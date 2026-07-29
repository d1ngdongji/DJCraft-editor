(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const MAX_MIDI_BYTES = 16 * 1024 * 1024;
  const MAX_NOTES = 200000;
  const HEADER_SIZE = 14;
  let notes = [];
  let selected = new Set();
  let config = null;
  let layout = null;
  let drag = null;

  class MidiReader {
    constructor(buffer) {
      this.data = new Uint8Array(buffer);
      this.view = new DataView(buffer);
      this.pos = 0;
    }
    remaining() { return this.data.length - this.pos; }
    require(count, message = "MIDI 文件提前结束") {
      if (this.pos + count > this.data.length) throw Error(message);
    }
    u8() { this.require(1); return this.data[this.pos++]; }
    u16() { this.require(2); const value = this.view.getUint16(this.pos); this.pos += 2; return value; }
    u32() { this.require(4); const value = this.view.getUint32(this.pos); this.pos += 4; return value; }
    text(count) {
      this.require(count);
      let value = "";
      for (let i = 0; i < count; i++) value += String.fromCharCode(this.data[this.pos++]);
      return value;
    }
    skip(count) { this.require(count); this.pos += count; }
    vlq(limit = this.data.length) {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        if (this.pos >= limit) throw Error("MIDI 可变长度数值越过轨道边界");
        const byte = this.u8();
        value = value * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return value;
      }
      throw Error("MIDI 可变长度数值超过 4 字节");
    }
  }

  function parseMidi(buffer) {
    if (buffer.byteLength < HEADER_SIZE) throw Error("文件太短，不是有效的 MIDI");
    if (buffer.byteLength > MAX_MIDI_BYTES) throw Error("MIDI 文件不能超过 16 MB");
    const reader = new MidiReader(buffer);
    if (reader.text(4) !== "MThd") throw Error("缺少 MThd 文件头");
    const headerLength = reader.u32();
    if (headerLength < 6) throw Error("MIDI 文件头长度无效");
    const format = reader.u16();
    const trackCount = reader.u16();
    const divisionRaw = reader.u16();
    reader.skip(headerLength - 6);
    if (format > 2) throw Error(`不支持的 MIDI format：${format}`);
    if (format === 2) throw Error("暂不支持 format 2：其各轨拥有彼此独立的时间轴");
    if (!trackCount || trackCount > 1024) throw Error("MIDI 轨道数量无效或过多");

    const rawNotes = [];
    const tempos = [{ tick: 0, micros: 500000, order: -1 }];
    let order = 0;
    let finalTick = 0;
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      if (reader.text(4) !== "MTrk") throw Error(`第 ${trackIndex + 1} 轨缺少 MTrk 标记`);
      const trackLength = reader.u32();
      reader.require(trackLength, `第 ${trackIndex + 1} 轨数据不完整`);
      const end = reader.pos + trackLength;
      const open = new Map();
      let tick = 0;
      let runningStatus = 0;
      while (reader.pos < end) {
        tick += reader.vlq(end);
        finalTick = Math.max(finalTick, tick);
        let status = reader.u8();
        let firstData = null;
        if (status < 0x80) {
          if (runningStatus < 0x80 || runningStatus >= 0xf0) throw Error("MIDI running status 无效");
          firstData = status;
          status = runningStatus;
        } else if (status < 0xf0) {
          runningStatus = status;
        }
        if (status === 0xff) {
          runningStatus = 0;
          const type = reader.u8();
          const length = reader.vlq(end);
          if (reader.pos + length > end) throw Error("MIDI meta event 越过轨道边界");
          if (type === 0x51 && length === 3) {
            const micros = reader.u8() * 65536 + reader.u8() * 256 + reader.u8();
            if (micros > 0) tempos.push({ tick, micros, order: order++ });
          } else {
            reader.skip(length);
          }
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          runningStatus = 0;
          const length = reader.vlq(end);
          if (reader.pos + length > end) throw Error("MIDI SysEx event 越过轨道边界");
          reader.skip(length);
          continue;
        }
        if (status >= 0xf0) throw Error(`不支持的 MIDI 系统事件：0x${status.toString(16)}`);
        const command = status & 0xf0;
        const channel = status & 0x0f;
        const dataLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
        const data1 = firstData == null ? reader.u8() : firstData;
        const data2 = dataLength === 2 ? reader.u8() : 0;
        if (reader.pos > end || data1 > 127 || data2 > 127) throw Error("MIDI channel event 数据无效");
        if (command !== 0x80 && command !== 0x90) continue;
        const key = `${channel}:${data1}`;
        if (command === 0x90 && data2 > 0) {
          const queue = open.get(key) || [];
          queue.push({ startTick: tick, pitch: data1, velocity: data2, channel, track: trackIndex });
          open.set(key, queue);
        } else {
          const queue = open.get(key);
          const note = queue?.shift();
          if (note) {
            note.endTick = Math.max(tick, note.startTick);
            rawNotes.push(note);
            if (!queue.length) open.delete(key);
            if (rawNotes.length > MAX_NOTES) throw Error("MIDI note 超过 200,000 个，无法安全导入");
          }
        }
      }
      if (reader.pos !== end) throw Error(`第 ${trackIndex + 1} 轨长度无效`);
      for (const queue of open.values()) {
        for (const note of queue) {
          note.endTick = Math.max(finalTick, note.startTick);
          rawNotes.push(note);
        }
      }
    }

    const tickToMs = makeTickConverter(divisionRaw, tempos);
    const converted = rawNotes.map((note, index) => ({
      ...note,
      id: index,
      startMs: tickToMs(note.startTick),
      endMs: tickToMs(note.endTick)
    })).sort((a, b) => a.startMs - b.startMs || a.pitch - b.pitch || a.track - b.track);
    converted.forEach((note, index) => { note.id = index; });
    const duration = Math.max(0, tickToMs(finalTick), ...converted.map(note => note.endMs));
    return { format, trackCount, notes: converted, duration };
  }

  function makeTickConverter(divisionRaw, tempos) {
    if (divisionRaw & 0x8000) {
      let frames = (divisionRaw >> 8) & 0xff;
      frames = frames > 127 ? 256 - frames : frames;
      const ticksPerFrame = divisionRaw & 0xff;
      if (![24, 25, 29, 30].includes(frames) || !ticksPerFrame) throw Error("MIDI SMPTE time division 无效");
      const framesPerSecond = frames === 29 ? 29.97 : frames;
      return tick => tick * 1000 / (framesPerSecond * ticksPerFrame);
    }
    const ticksPerQuarter = divisionRaw;
    if (!ticksPerQuarter) throw Error("MIDI ticks-per-quarter 无效");
    const sorted = tempos
      .filter(item => item.tick >= 0)
      .sort((a, b) => a.tick - b.tick || a.order - b.order);
    const segments = [];
    let lastTick = 0;
    let micros = 500000;
    let elapsedMs = 0;
    for (const tempo of sorted) {
      if (tempo.tick > lastTick) {
        elapsedMs += (tempo.tick - lastTick) * micros / ticksPerQuarter / 1000;
        lastTick = tempo.tick;
      }
      micros = tempo.micros;
      const existing = segments.at(-1);
      const segment = { tick: lastTick, ms: elapsedMs, micros };
      if (existing?.tick === lastTick) segments[segments.length - 1] = segment;
      else segments.push(segment);
    }
    return tick => {
      let low = 0;
      let high = segments.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (segments[middle].tick <= tick) low = middle;
        else high = middle - 1;
      }
      const segment = segments[low] || { tick: 0, ms: 0, micros: 500000 };
      return segment.ms + (tick - segment.tick) * segment.micros / ticksPerQuarter / 1000;
    };
  }

  function noteName(pitch) {
    return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;
  }

  function setStatus(message, error = false) {
    $("advMidiStatus").textContent = message;
    $("advMidiStatus").classList.toggle("error", error);
  }

  function reset() {
    notes = [];
    selected.clear();
    layout = null;
    drag = null;
    $("advMidiFile").value = "";
    $("advMidiFileName").textContent = "选择 .mid / .midi 文件";
    $("advMidiSummary").textContent = "尚未加载 MIDI";
    $("advMidiPlaceholder").classList.remove("hidden");
    setStatus("");
    render();
  }

  function open(nextConfig) {
    config = nextConfig;
    reset();
    $("advMidiDefinition").innerHTML = config.definitions.map(value => `<option></option>`).join("");
    [...$("advMidiDefinition").options].forEach((option, index) => {
      option.value = config.definitions[index];
      option.textContent = config.definitions[index];
    });
    $("advMidiTrack").innerHTML = config.tracks.map(value => `<option></option>`).join("");
    [...$("advMidiTrack").options].forEach((option, index) => {
      option.value = config.tracks[index];
      option.textContent = valueLabel(config.tracks[index]);
    });
    $("advMidiTrack").value = config.activeTrack && config.tracks.includes(config.activeTrack)
      ? config.activeTrack : config.tracks[0];
    $("advMidiDialog").showModal();
  }

  const valueLabel = value => value === "combat_line" ? "combat_line（战斗轨）" : value;
  const close = () => $("advMidiDialog").close();

  async function loadFile(file) {
    if (!file) return;
    $("advMidiFileName").textContent = file.name;
    setStatus("正在解析 MIDI…");
    try {
      const parsed = parseMidi(await file.arrayBuffer());
      notes = parsed.notes;
      selected.clear();
      $("advMidiPlaceholder").classList.toggle("hidden", !!notes.length);
      $("advMidiSummary").textContent = `format ${parsed.format} · ${parsed.trackCount} MIDI 轨 · ${notes.length} notes · ${(parsed.duration / 1000).toFixed(2)} s`;
      setStatus(notes.length ? "解析完成。拖动框选 note，按住 Ctrl/⌘ 可追加。" : "MIDI 中没有可导入的 note。", !notes.length);
      render();
    } catch (error) {
      notes = [];
      selected.clear();
      $("advMidiSummary").textContent = "MIDI 解析失败";
      $("advMidiPlaceholder").classList.remove("hidden");
      setStatus(error.message || String(error), true);
      render();
    }
  }

  function render() {
    const canvas = $("advMidiRoll");
    const wrap = canvas.parentElement;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const minPitch = notes.length ? Math.max(0, Math.min(...notes.map(note => note.pitch)) - 2) : 48;
    const maxPitch = notes.length ? Math.min(127, Math.max(...notes.map(note => note.pitch)) + 2) : 72;
    const duration = Math.max(1000, ...notes.map(note => note.endMs));
    const cssWidth = notes.length ? Math.min(12000, Math.max(wrap.clientWidth || 900, duration * 0.08)) : Math.max(900, wrap.clientWidth || 900);
    const cssHeight = Math.max(420, (maxPitch - minPitch + 1) * 12);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0b1012";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    layout = { width: cssWidth, height: cssHeight, minPitch, maxPitch, duration, rowHeight: cssHeight / (maxPitch - minPitch + 1) };
    const white = new Set([0, 2, 4, 5, 7, 9, 11]);
    for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
      const y = pitchY(pitch);
      ctx.fillStyle = white.has(pitch % 12) ? "#11191c" : "#0d1315";
      ctx.fillRect(0, y, cssWidth, layout.rowHeight);
      ctx.strokeStyle = pitch % 12 === 0 ? "#344248" : "#20292d";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
      if (pitch % 12 === 0) {
        ctx.fillStyle = "#718087";
        ctx.font = "9px ui-monospace";
        ctx.fillText(noteName(pitch), 5, y + 10);
      }
    }
    const secondStep = duration > 180000 ? 30 : duration > 60000 ? 10 : duration > 15000 ? 5 : 1;
    for (let second = 0; second * 1000 <= duration; second += secondStep) {
      const x = second * 1000 / duration * cssWidth;
      ctx.strokeStyle = second ? "#29353a" : "#5a6c72";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssHeight);
      ctx.stroke();
      ctx.fillStyle = "#7f9197";
      ctx.font = "9px ui-monospace";
      const labelX = second === 0 ? 28 : Math.min(cssWidth - 24, x + 4);
      ctx.fillText(`${second}s`, labelX, 11);
    }
    for (const note of notes) {
      const rect = noteRect(note);
      const active = selected.has(note.id);
      ctx.fillStyle = active ? "#fff3a2" : `hsl(${(note.channel * 43 + note.track * 17) % 360} 72% 62%)`;
      ctx.strokeStyle = active ? "#ffffff" : "#d9ffff66";
      ctx.lineWidth = active ? 2 : 1;
      ctx.fillRect(rect.x, rect.y + 1, rect.width, Math.max(2, rect.height - 2));
      ctx.strokeRect(rect.x, rect.y + 1, rect.width, Math.max(2, rect.height - 2));
    }
    updateSelection();
  }

  function pitchY(pitch) {
    return (layout.maxPitch - pitch) * layout.rowHeight;
  }

  function noteRect(note) {
    const x = note.startMs / layout.duration * layout.width;
    const end = note.endMs / layout.duration * layout.width;
    return { x, y: pitchY(note.pitch), width: Math.max(3, end - x), height: layout.rowHeight };
  }

  function canvasPoint(event) {
    const rect = $("advMidiRoll").getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * layout.width / rect.width,
      y: (event.clientY - rect.top) * layout.height / rect.height
    };
  }

  function updateSelection() {
    const chosen = notes.filter(note => selected.has(note.id));
    if (!chosen.length) $("advMidiSelection").textContent = "未选择 note";
    else {
      const start = Math.min(...chosen.map(note => note.startMs));
      const end = Math.max(...chosen.map(note => note.endMs));
      const pitches = [...new Set(chosen.map(note => note.pitch))];
      $("advMidiSelection").textContent = `已选 ${chosen.length} notes · ${noteName(Math.min(...pitches))}–${noteName(Math.max(...pitches))} · ${(start / 1000).toFixed(3)}–${(end / 1000).toFixed(3)} s`;
    }
    $("advMidiApply").disabled = !chosen.length;
  }

  function beginSelect(event) {
    if (!notes.length || event.button !== 0) return;
    const point = canvasPoint(event);
    drag = { start: point, current: point, additive: event.ctrlKey || event.metaKey, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateMarquee();
    event.preventDefault();
  }

  function moveSelect(event) {
    if (!drag) return;
    drag.current = canvasPoint(event);
    drag.moved ||= Math.abs(drag.current.x - drag.start.x) > 3 || Math.abs(drag.current.y - drag.start.y) > 3;
    updateMarquee();
  }

  function updateMarquee() {
    if (!drag) return;
    const canvas = $("advMidiRoll");
    const scaleX = canvas.clientWidth / layout.width;
    const scaleY = canvas.clientHeight / layout.height;
    const box = $("advMidiMarquee");
    box.classList.remove("hidden");
    Object.assign(box.style, {
      left: `${canvas.offsetLeft + Math.min(drag.start.x, drag.current.x) * scaleX}px`,
      top: `${canvas.offsetTop + Math.min(drag.start.y, drag.current.y) * scaleY}px`,
      width: `${Math.abs(drag.current.x - drag.start.x) * scaleX}px`,
      height: `${Math.abs(drag.current.y - drag.start.y) * scaleY}px`
    });
  }

  function endSelect(event) {
    if (!drag) return;
    const state = drag;
    drag = null;
    $("advMidiMarquee").classList.add("hidden");
    if (!state.additive) selected.clear();
    if (!state.moved) {
      const hits = notes.filter(note => pointInRect(state.current, noteRect(note)));
      const hit = hits.at(-1);
      if (hit) {
        if (state.additive && selected.has(hit.id)) selected.delete(hit.id);
        else selected.add(hit.id);
      }
    } else {
      const selectionRect = {
        x: Math.min(state.start.x, state.current.x),
        y: Math.min(state.start.y, state.current.y),
        width: Math.abs(state.current.x - state.start.x),
        height: Math.abs(state.current.y - state.start.y)
      };
      notes.forEach(note => {
        if (intersects(selectionRect, noteRect(note))) selected.add(note.id);
      });
    }
    render();
  }

  const pointInRect = (point, rect) =>
    point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
  const intersects = (a, b) =>
    a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;

  function syncPercent(source, target) {
    const value = Math.max(0, Math.min(100, Number(source.value) || 0));
    source.value = String(value);
    target.value = String(value);
  }

  function apply() {
    const percent = Math.max(0, Math.min(100, Number($("advMidiPercentNumber").value) || 0));
    const chosen = notes
      .filter(note => selected.has(note.id))
      .map(note => ({
        time: Math.round(note.startMs + (note.endMs - note.startMs) * percent / 100),
        pitch: note.pitch,
        velocity: note.velocity,
        channel: note.channel,
        midiTrack: note.track
      }));
    if (!chosen.length) return setStatus("请先选择至少一个 note", true);
    const result = config.importNotes({
      notes: chosen,
      type: $("advMidiDefinition").value,
      trackName: $("advMidiTrack").value,
      percent
    });
    if (result?.ok) close();
    else if (result?.message) setStatus(result.message, true);
  }

  function bind() {
    $("advMidiClose").onclick = close;
    $("advMidiCancel").onclick = close;
    $("advMidiFile").onchange = event => loadFile(event.target.files[0]);
    $("advMidiSelectAll").onclick = () => { selected = new Set(notes.map(note => note.id)); render(); };
    $("advMidiClearSelection").onclick = () => { selected.clear(); render(); };
    $("advMidiPercent").oninput = () => syncPercent($("advMidiPercent"), $("advMidiPercentNumber"));
    $("advMidiPercentNumber").oninput = () => syncPercent($("advMidiPercentNumber"), $("advMidiPercent"));
    $("advMidiApply").onclick = apply;
    $("advMidiRoll").onpointerdown = beginSelect;
    $("advMidiRoll").onpointermove = moveSelect;
    $("advMidiRoll").onpointerup = endSelect;
    $("advMidiRoll").onpointercancel = endSelect;
    $("advMidiDialog").addEventListener("close", () => {
      drag = null;
      $("advMidiMarquee").classList.add("hidden");
    });
    new ResizeObserver(() => { if ($("advMidiDialog").open) render(); }).observe($("advMidiRoll").parentElement);
  }

  window.MidiImporter = { bind, open, parseMidi };
})();
