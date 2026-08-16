(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const clone = value => structuredClone(value);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const DEFAULT_DEFINITION = () => ({
    can_attack: true,
    color: "#FFFFFF",
    scale: 1,
    damage_rate: 1,
    category: "normal",
    haptic_intensity: 1,
    tolerance: 0.1,
    particle: null,
    trigger: null,
    texture: "djcraft:textures/gui/beats/blue_beat.png",
    landing_x_percent: 50,
    spawn_advance_ms: 1400,
    hit_behavior: "freeze_dissipate",
    miss_behavior: "none",
    rotation_rpm: 0
  });
  const KNOWN_DEFINITION_KEYS = new Set([
    "can_attack", "color", "scale", "damage_rate", "category", "haptic_intensity",
    "tolerance", "particle", "trigger", "texture", "landing_x_percent",
    "spawn_advance_ms", "hit_behavior", "matched_hit_behavior", "miss_behavior",
    "rotation_rpm"
  ]);
  const BEAT_BEHAVIORS = ["none", "freeze_dissipate", "dissipate", "bounce"];

  let adapter = null;
  let project = null;
  let track = null;
  let audio = null;
  let activeTrack = "combat_line";
  let inspectorTab = "event";
  let selected = new Set();
  let lastSelectedId = null;
  let previewIds = new Set();
  let clipboard = [];
  let undoStack = [];
  let redoStack = [];
  let eventIds = new WeakMap();
  let nextEventId = 1;
  let pxPerMs = 0.01;
  let fitMode = true;
  let waveformBuffer = null;
  let waveformLevels = [];
  let waveformSource = null;
  let waveformToken = 0;
  let animationFrame = 0;
  let previewBeatIndex = 0;
  let previewAudioContext = null;
  let dragState = null;
  let marqueeState = null;
  let resizeObserver = null;
  let inspectorInputTimer = 0;
  let waveformScrubbing = false;
  let bulkPropDraft = { key: "", expression: "" };
  let bulkMathRuntime = null;

  const idFor = event => {
    if (!eventIds.has(event)) eventIds.set(event, `e${nextEventId++}`);
    return eventIds.get(event);
  };
  const durationMs = () => Math.max(1, Math.round(Number(track?.meta?.total_duration_ms) || (audio?.duration || 0) * 1000 || 1));
  const audioDurationMs = () => Math.max(0, Math.round((waveformBuffer?.duration || audio?.duration || 0) * 1000));
  const displayDurationMs = () => Math.max(durationMs(), audioDurationMs(), 1);
  const playbackStartMs = () => Math.max(0, Math.round(Number(track?.meta?.playback_start_ms) || 0));
  const bpm = () => Math.max(0.0001, Number(track?.meta?.bpm) || 120);
  const division = () => Math.max(1, Number($("advSnapDivision")?.value) || 4);
  const snapStep = () => 60000 / bpm() / division();
  const snapTime = time => Math.round(Math.round(time / snapStep()) * snapStep());
  const clampTime = time => Math.max(0, Math.min(durationMs(), Math.round(time)));
  const clampAudioTime = time => Math.max(0, Math.min(audioDurationMs() || durationMs(), Math.round(time)));
  const timelineNames = () => track?.timeline ? Object.keys(track.timeline) : [];
  const timelineEvents = name => Array.isArray(track?.timeline?.[name]) ? track.timeline[name] : [];
  const colorFor = type => {
    const value = track?.definitions?.[type]?.color;
    if (/^#[0-9a-f]{6}$/i.test(value || "")) return value;
    let hash = 0;
    for (const char of String(type)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return `hsl(${Math.abs(hash) % 360} 70% 65%)`;
  };
  const setStatus = (message, error = false) => {
    const node = $("advStatus");
    if (node) {
      node.textContent = message;
      node.style.color = error ? "#ff9b9b" : "";
    }
    adapter?.setStatus?.(message, error);
  };

  function normalizeTrack() {
    if (!track) return;
    track.meta = track.meta && typeof track.meta === "object" ? track.meta : {};
    track.meta.playback_start_ms = playbackStartMs();
    track.settings = track.settings && typeof track.settings === "object" ? track.settings : {};
    track.definitions = track.definitions && typeof track.definitions === "object" ? track.definitions : {};
    if (!Object.keys(track.definitions).length) track.definitions.normal_beat = DEFAULT_DEFINITION();
    track.timeline = track.timeline && typeof track.timeline === "object" ? track.timeline : {};
    if (!Array.isArray(track.timeline.combat_line)) track.timeline.combat_line = [];
    for (const [name, events] of Object.entries(track.timeline)) {
      if (!Array.isArray(events)) continue;
      events.forEach((event, index) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) events[index] = { t: 0, type: "normal_beat" };
        events[index].t = Math.round(Number(events[index].t) || 0);
        events[index].type = String(events[index].type || "normal_beat");
        if (events[index].props && typeof events[index].props !== "object") delete events[index].props;
        idFor(events[index]);
      });
      stableSort(events);
    }
    if (!track.timeline[activeTrack]) activeTrack = "combat_line";
  }

  function stableSort(events) {
    const indexed = events.map((event, index) => ({ event, index }));
    indexed.sort((a, b) => Number(a.event.t) - Number(b.event.t) || a.index - b.index);
    events.splice(0, events.length, ...indexed.map(item => item.event));
  }

  function allEventInfo() {
    const result = [];
    timelineNames().forEach((name, trackIndex) => {
      timelineEvents(name).forEach((event, eventIndex) => result.push({
        id: idFor(event), event, trackName: name, trackIndex, eventIndex
      }));
    });
    return result;
  }

  function selectedInfo() {
    return allEventInfo().filter(info => selected.has(info.id));
  }

  function pruneSelection() {
    const valid = new Set(allEventInfo().map(info => info.id));
    selected = new Set([...selected].filter(id => valid.has(id)));
    previewIds = new Set([...previewIds].filter(id => valid.has(id)));
    if (lastSelectedId && !valid.has(lastSelectedId)) lastSelectedId = null;
  }

  function ensureDefinition(type) {
    if (!track.definitions[type]) {
      track.definitions[type] = DEFAULT_DEFINITION();
      setStatus(`已为 combat_line 自动创建 definition：${type}`);
    }
  }

  function commit(label, mutator, options = {}) {
    if (!track) return false;
    const before = JSON.stringify(track);
    try {
      mutator();
      normalizeTrack();
    } catch (error) {
      setStatus(error.message || String(error), true);
      return false;
    }
    const after = JSON.stringify(track);
    if (before === after) {
      if (options.noChangeMessage) setStatus(options.noChangeMessage);
      return false;
    }
    undoStack.push({ label, snapshot: before });
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    pruneSelection();
    adapter?.trackChanged?.(label);
    renderAll();
    setStatus(label);
    return true;
  }

  function restoreHistory(source, target, verb) {
    if (!source.length || !track) return;
    const item = source.pop();
    target.push({ label: item.label, snapshot: JSON.stringify(track) });
    adapter?.replaceTrack?.(JSON.parse(item.snapshot));
    project = adapter?.getProject?.() || project;
    track = project?.track || null;
    eventIds = new WeakMap();
    selected.clear();
    previewIds.clear();
    lastSelectedId = null;
    normalizeTrack();
    adapter?.trackChanged?.(`${verb}：${item.label}`);
    renderAll();
    setStatus(`${verb}：${item.label}`);
  }

  function undo() { restoreHistory(undoStack, redoStack, "已撤销"); }
  function redo() { restoreHistory(redoStack, undoStack, "已重做"); }

  function activate() {
    if (!track) return;
    requestAnimationFrame(() => {
      if (fitMode) fitTimeline(false);
      renderAll();
      drawWaveform();
      drawRuler();
    });
  }

  function setProject(nextProject, external = true) {
    const oldTrack = track;
    project = nextProject || null;
    track = project?.track || null;
    audio = adapter?.getAudio?.() || null;
    if (external && oldTrack !== track) {
      undoStack = [];
      redoStack = [];
      selected.clear();
      previewIds.clear();
      eventIds = new WeakMap();
      lastSelectedId = null;
      fitMode = true;
      bulkPropDraft = { key: "", expression: "" };
    }
    $("advancedEmpty")?.classList.toggle("hidden", !!track);
    $("advancedWorkspace")?.classList.toggle("hidden", !track);
    if (!track) return;
    normalizeTrack();
    const source = adapter?.getAudioFile?.() || null;
    if (source && source !== waveformSource) decodeWaveform(source);
    renderAll();
  }

  function renderAll() {
    if (!track) return;
    renderProjectSummary();
    renderTypeList();
    renderTimeline();
    renderInspector();
    renderSelectionStatus();
    updateHistoryButtons();
    drawWaveform();
    drawRuler();
    updatePlayhead();
  }

  function renderProjectSummary() {
    const count = timelineNames().reduce((sum, name) => sum + timelineEvents(name).length, 0);
    $("advProjectName").textContent = track.meta.display_name || adapter?.getProjectName?.() || "未命名曲目";
    $("advProjectInfo").textContent = `${timelineNames().length} 轨 · ${count} 事件 · ${formatTime(durationMs())}`;
  }

  function renderTypeList() {
    const types = new Set(Object.keys(track.definitions));
    timelineNames().forEach(name => timelineEvents(name).forEach(event => types.add(event.type)));
    $("advTypeList").innerHTML = [...types].sort().map(type => `<option value="${esc(type)}"></option>`).join("");
  }

  function contentMetrics() {
    const scroll = $("advTimelineScroll");
    const labelWidth = matchMedia("(max-width: 760px)").matches ? 92 : 132;
    const viewportWidth = Math.max(320, (scroll?.clientWidth || 900) - labelWidth);
    const timeWidth = Math.max(viewportWidth, displayDurationMs() * pxPerMs);
    return { scroll, labelWidth, viewportWidth, timeWidth };
  }

  function renderTimeline() {
    const { scroll, labelWidth, timeWidth } = contentMetrics();
    if (!scroll) return;
    const startMs = Math.max(0, scroll.scrollLeft / pxPerMs - 1000);
    const endMs = Math.min(durationMs(), (scroll.scrollLeft + scroll.clientWidth) / pxPerMs + 1000);
    const gridMs = visibleGridStep();
    const eventWidth = Math.max(1, Math.min(12, snapStep() * pxPerMs * .55));
    const compactEvents = eventWidth < 4;
    const selectedRange = getRange(false);
    const anchorIds = new Set(selectedRange ? [selectedRange.start.id, selectedRange.end.id] : []);
    const rows = timelineNames().map((name, trackIndex) => {
      const events = timelineEvents(name);
      const visible = events.filter(event => event.t >= startMs && event.t <= endMs);
      const nodes = visible.map(event => {
        const id = idFor(event);
        const classes = [
          "advancedEvent",
          compactEvents ? "compact" : "",
          selected.has(id) ? "selected" : "",
          anchorIds.has(id) ? "anchor" : "",
          previewIds.has(id) ? "preview" : ""
        ].filter(Boolean).join(" ");
        return `<button class="${classes}" data-event-id="${id}" data-track="${esc(name)}" data-type="${esc(event.type)}" style="left:${labelWidth + event.t * pxPerMs}px;--event-color:${colorFor(event.type)};--event-width:${eventWidth}px" aria-label="${esc(event.type)}，${event.t} 毫秒"></button>`;
      }).join("");
      return `<div class="advancedTrackRow${previewIds.size ? " preview" : ""}" data-track="${esc(name)}" data-track-index="${trackIndex}" style="--grid-px:${gridMs * pxPerMs}px">
        <div class="advancedTrackHeader${name === activeTrack ? " active" : ""}" data-track-header="${esc(name)}">
          <strong title="${esc(name)}">${esc(name)}</strong><small>${events.length}</small><button data-track-menu="${esc(name)}" title="轨道属性">⋮</button>
        </div>${nodes}</div>`;
    }).join("");
    $("advTrackRows").innerHTML = rows;
    const content = $("advTimelineContent");
    content.style.width = `${labelWidth + timeWidth}px`;
    content.style.height = `${Math.max(scroll.clientHeight, timelineNames().length * 62)}px`;
    $("advPlayhead").style.left = `${labelWidth + (audio?.currentTime || 0) * 1000 * pxPerMs}px`;
  }

  function visibleGridStep() {
    let step = snapStep();
    while (step * pxPerMs < 12) step *= 2;
    return step;
  }

  function renderSelectionStatus() {
    const info = selectedInfo();
    const status = $("advSelectionStatus");
    if (!info.length) status.textContent = "未选择事件";
    else if (info.length === 1) status.textContent = `${info[0].trackName} · ${info[0].event.t} ms · ${info[0].event.type}`;
    else status.textContent = `已选 ${info.length} 个事件 · ${new Set(info.map(item => item.trackName)).size} 轨`;
    const range = getRange(false);
    $("advRangeSummary").textContent = range
      ? `${range.trackName} · ${range.start.event.t}–${range.end.event.t} ms · 区间 ${range.events.length} 拍`
      : "请选择同轨至少两个节拍";
  }

  function updateHistoryButtons() {
    $("advUndo").disabled = !undoStack.length;
    $("advRedo").disabled = !redoStack.length;
    $("advUndo").title = undoStack.length ? `撤销：${undoStack.at(-1).label} · Ctrl+Z` : "没有可撤销操作";
    $("advRedo").title = redoStack.length ? `重做：${redoStack.at(-1).label} · Ctrl+Y` : "没有可重做操作";
  }

  function selectEvent(id, event) {
    const info = allEventInfo();
    const clicked = info.find(item => item.id === id);
    if (!clicked) return;
    if (event.shiftKey && lastSelectedId) {
      const anchor = info.find(item => item.id === lastSelectedId);
      if (anchor?.trackName === clicked.trackName) {
        const events = timelineEvents(clicked.trackName);
        const from = Math.min(anchor.eventIndex, clicked.eventIndex);
        const to = Math.max(anchor.eventIndex, clicked.eventIndex);
        if (!event.ctrlKey && !event.metaKey) selected.clear();
        for (let i = from; i <= to; i++) selected.add(idFor(events[i]));
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else {
      if (!selected.has(id) || selected.size > 1) selected = new Set([id]);
    }
    activeTrack = clicked.trackName;
    lastSelectedId = id;
    previewIds.clear();
    renderAll();
  }

  function clearSelection() {
    selected.clear();
    previewIds.clear();
    lastSelectedId = null;
    renderAll();
  }

  function pointerTime(event) {
    const { scroll, labelWidth } = contentMetrics();
    const rect = scroll.getBoundingClientRect();
    const contentX = scroll.scrollLeft + event.clientX - rect.left;
    return clampTime((contentX - labelWidth) / pxPerMs);
  }

  function beginDrag(event, node) {
    const id = node.dataset.eventId;
    selectEvent(id, event);
    const infos = selectedInfo();
    if (!infos.length) return;
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      startTime: pointerTime(event),
      items: infos.map(info => ({ ...info, originalT: info.event.t })),
      copy: event.ctrlKey || event.metaKey,
      targetTrack: infos[0].trackName,
      moved: false
    };
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!dragState) return;
    const deltaPixels = event.clientX - dragState.startX;
    let deltaMs = deltaPixels / pxPerMs;
    const primary = dragState.items[0];
    let target = primary.originalT + deltaMs;
    if ($("advSnapEnabled").checked && !event.altKey) target = snapTime(target);
    deltaMs = target - primary.originalT;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".advancedTrackRow");
    if (row && new Set(dragState.items.map(item => item.trackName)).size === 1) dragState.targetTrack = row.dataset.track;
    dragState.deltaMs = deltaMs;
    dragState.moved = Math.abs(deltaPixels) > 2 || dragState.targetTrack !== primary.trackName;
    setStatus(`${dragState.copy ? "复制" : "移动"} · ${deltaMs >= 0 ? "+" : ""}${Math.round(deltaMs)} ms · ${dragState.targetTrack}`);
    document.querySelectorAll(".advancedEvent.selected").forEach(node => {
      node.style.transform = `translateX(calc(-50% + ${deltaMs * pxPerMs}px))`;
    });
  }

  function endDrag() {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    if (!state.moved) {
      renderTimeline();
      return;
    }
    const delta = Math.round(state.deltaMs || 0);
    const targetTrack = state.targetTrack;
    const copiedIds = [];
    commit(state.copy ? "复制并移动事件" : "移动事件", () => {
      const sameSource = new Set(state.items.map(item => item.trackName)).size === 1;
      if (targetTrack === "combat_line") state.items.forEach(item => ensureDefinition(item.event.type));
      if (state.copy) {
        for (const item of state.items) {
          const destination = sameSource ? targetTrack : item.trackName;
          const next = clone(item.event);
          next.t = clampTime(item.originalT + delta);
          timelineEvents(destination).push(next);
          copiedIds.push(idFor(next));
        }
      } else {
        for (const item of state.items) {
          item.event.t = clampTime(item.originalT + delta);
          if (sameSource && item.trackName !== targetTrack) {
            const source = timelineEvents(item.trackName);
            source.splice(source.indexOf(item.event), 1);
            timelineEvents(targetTrack).push(item.event);
          }
        }
      }
      if (state.copy) selected = new Set(copiedIds);
    });
  }

  function beginMarquee(event, row) {
    if (event.button !== 0) return;
    const { scroll } = contentMetrics();
    const rect = scroll.getBoundingClientRect();
    marqueeState = {
      startX: scroll.scrollLeft + event.clientX - rect.left,
      startY: scroll.scrollTop + event.clientY - rect.top,
      currentX: 0,
      currentY: 0,
      additive: event.ctrlKey || event.metaKey
    };
    marqueeState.currentX = marqueeState.startX;
    marqueeState.currentY = marqueeState.startY;
    if (!marqueeState.additive) selected.clear();
    updateMarquee();
    event.preventDefault();
  }

  function moveMarquee(event) {
    if (!marqueeState) return;
    const { scroll } = contentMetrics();
    const rect = scroll.getBoundingClientRect();
    marqueeState.currentX = scroll.scrollLeft + event.clientX - rect.left;
    marqueeState.currentY = scroll.scrollTop + event.clientY - rect.top;
    updateMarquee();
  }

  function updateMarquee() {
    const box = $("advSelectionBox");
    const left = Math.min(marqueeState.startX, marqueeState.currentX);
    const top = Math.min(marqueeState.startY, marqueeState.currentY);
    const width = Math.abs(marqueeState.currentX - marqueeState.startX);
    const height = Math.abs(marqueeState.currentY - marqueeState.startY);
    box.classList.remove("hidden");
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  function endMarquee() {
    if (!marqueeState) return;
    const state = marqueeState;
    marqueeState = null;
    $("advSelectionBox").classList.add("hidden");
    const { labelWidth } = contentMetrics();
    const left = Math.min(state.startX, state.currentX);
    const right = Math.max(state.startX, state.currentX);
    const top = Math.min(state.startY, state.currentY);
    const bottom = Math.max(state.startY, state.currentY);
    allEventInfo().forEach(info => {
      const x = labelWidth + info.event.t * pxPerMs;
      const y = info.trackIndex * 62 + 31;
      if (x >= left && x <= right && y >= top && y <= bottom) selected.add(info.id);
    });
    renderAll();
  }

  function addEvent(trackName = activeTrack, time = null) {
    const eventTime = time == null ? clampTime((audio?.currentTime || 0) * 1000) : clampTime(time);
    const type = trackName === "combat_line" ? Object.keys(track.definitions)[0] : ($("advGenerateType").value.trim() || "event");
    commit(`在 ${trackName} 创建事件`, () => {
      if (trackName === "combat_line") ensureDefinition(type);
      const next = { t: $("advSnapEnabled").checked ? snapTime(eventTime) : eventTime, type };
      timelineEvents(trackName).push(next);
      selected = new Set([idFor(next)]);
      lastSelectedId = idFor(next);
      activeTrack = trackName;
    });
  }

  function openMidiImporter() {
    if (!window.MidiImporter) return setStatus("MIDI 导入组件未加载", true);
    window.MidiImporter.open({
      definitions: Object.keys(track.definitions),
      tracks: timelineNames(),
      activeTrack,
      importNotes: importMidiNotes
    });
  }

  function importMidiNotes({ notes, type, trackName, percent }) {
    if (!track.timeline[trackName]) return { ok: false, message: "目标轨道已不存在，请重新打开导入界面" };
    if (!track.definitions[type]) return { ok: false, message: "所选 definition 已不存在，请重新打开导入界面" };
    const usable = notes.filter(note => Number.isFinite(note.time) && note.time >= 0 && note.time <= durationMs());
    const skipped = notes.length - usable.length;
    if (!usable.length) return { ok: false, message: `所选 note 的时间戳均超出曲目时长 ${durationMs()} ms` };
    const addedIds = [];
    const changed = commit(`从 MIDI 导入 ${usable.length} 个节拍`, () => {
      usable.forEach(note => {
        const next = { t: Math.round(note.time), type };
        timelineEvents(trackName).push(next);
        addedIds.push(idFor(next));
      });
      selected = new Set(addedIds);
      lastSelectedId = addedIds.at(-1) || null;
      activeTrack = trackName;
    });
    if (!changed) return { ok: false, message: "没有可导入的 MIDI note" };
    const detail = skipped ? `；另有 ${skipped} 个超出曲目时长，已跳过` : "";
    setStatus(`已从 MIDI 导入 ${usable.length} 个节拍到 ${trackName}（note ${percent}%）${detail}`);
    return { ok: true };
  }

  function deleteSelected() {
    const infos = selectedInfo();
    if (!infos.length) return setStatus("请先选择要删除的事件", true);
    commit(`删除 ${infos.length} 个事件`, () => {
      const byTrack = Map.groupBy ? Map.groupBy(infos, item => item.trackName) : groupByTrack(infos);
      for (const [name, items] of byTrack) {
        const remove = new Set(items.map(item => item.event));
        track.timeline[name] = timelineEvents(name).filter(event => !remove.has(event));
      }
      selected.clear();
    });
  }

  function groupByTrack(items) {
    const map = new Map();
    items.forEach(item => {
      if (!map.has(item.trackName)) map.set(item.trackName, []);
      map.get(item.trackName).push(item);
    });
    return map;
  }

  function copySelected(cut = false) {
    const infos = selectedInfo();
    if (!infos.length) return setStatus("没有可复制的事件", true);
    const earliest = Math.min(...infos.map(info => info.event.t));
    clipboard = infos.map(info => ({
      sourceTrack: info.trackName,
      offset: info.event.t - earliest,
      event: clone(info.event)
    }));
    setStatus(`已复制 ${clipboard.length} 个事件`);
    if (cut) deleteSelected();
  }

  function pasteClipboard() {
    if (!clipboard.length) return setStatus("剪贴板为空", true);
    const at = clampTime((audio?.currentTime || 0) * 1000);
    const sourceTracks = new Set(clipboard.map(item => item.sourceTrack));
    const pasted = [];
    commit(`粘贴 ${clipboard.length} 个事件`, () => {
      clipboard.forEach(item => {
        const destination = sourceTracks.size === 1 ? activeTrack : (track.timeline[item.sourceTrack] ? item.sourceTrack : activeTrack);
        const next = clone(item.event);
        next.t = clampTime(at + item.offset);
        if ($("advSnapEnabled").checked) next.t = snapTime(next.t);
        if (destination === "combat_line") ensureDefinition(next.type);
        timelineEvents(destination).push(next);
        pasted.push(idFor(next));
      });
      selected = new Set(pasted);
    });
  }

  function duplicateSelected() {
    const infos = selectedInfo();
    if (!infos.length) return setStatus("请先选择事件", true);
    const step = Math.max(1, Math.round(snapStep()));
    const ids = [];
    commit(`重复 ${infos.length} 个事件`, () => {
      infos.forEach(info => {
        const next = clone(info.event);
        next.t = clampTime(next.t + step);
        timelineEvents(info.trackName).push(next);
        ids.push(idFor(next));
      });
      selected = new Set(ids);
    });
  }

  function nudgeSelected(amount) {
    const infos = selectedInfo();
    if (!infos.length) return;
    commit(`精移 ${amount > 0 ? "+" : ""}${amount} ms`, () => {
      infos.forEach(info => { info.event.t = clampTime(info.event.t + amount); });
    });
  }

  function quantizeSelected() {
    const infos = selectedInfo();
    if (!infos.length) return setStatus("请先选择要量化的事件", true);
    commit(`量化 ${infos.length} 个事件`, () => {
      infos.forEach(info => { info.event.t = clampTime(snapTime(info.event.t)); });
    });
  }

  function getRange(showError = true) {
    const infos = selectedInfo();
    if (infos.length < 2 || new Set(infos.map(info => info.trackName)).size !== 1) {
      if (showError) setStatus("该工具需要选择同一轨道上的至少两个节拍", true);
      return null;
    }
    const ordered = infos.sort((a, b) => a.event.t - b.event.t);
    const start = ordered[0];
    const end = ordered.at(-1);
    if (start.event.t === end.event.t) {
      if (showError) setStatus("两个锚点必须位于不同时间", true);
      return null;
    }
    const name = start.trackName;
    const events = timelineEvents(name).filter(event => event.t >= start.event.t && event.t <= end.event.t);
    return { trackName: name, start, end, events };
  }

  function validateGeneratedTimes(times, start, end) {
    const rounded = times.map(Math.round);
    if (rounded.some(time => time <= start || time >= end)) throw Error("区间太短，无法生成互不重合的整数毫秒节拍");
    if (new Set(rounded).size !== rounded.length) throw Error("生成结果在整数毫秒舍入后发生重合");
    return rounded;
  }

  function generateBetween() {
    const range = getRange();
    if (!range) return;
    const interiors = timelineEvents(range.trackName).filter(event => event.t > range.start.event.t && event.t < range.end.event.t);
    if (interiors.length) return setStatus(`两个锚点之间已有 ${interiors.length} 个事件，请先清空区间`, true);
    const mode = $("advGenerateMode").value;
    const value = Number($("advGenerateValue").value);
    const type = $("advGenerateType").value.trim() || range.start.event.type;
    let times = [];
    let endTime = range.end.event.t;
    if (mode === "count") {
      if (!Number.isInteger(value) || value < 0) return setStatus("中间个数必须是非负整数", true);
      for (let i = 1; i <= value; i++) times.push(range.start.event.t + (range.end.event.t - range.start.event.t) * i / (value + 1));
      try { times = validateGeneratedTimes(times, range.start.event.t, range.end.event.t); }
      catch (error) { return setStatus(error.message, true); }
    } else {
      if (!Number.isFinite(value) || value <= 0) return setStatus("BPM 必须是正数", true);
      const interval = 60000 / value;
      const segments = Math.floor((range.end.event.t - range.start.event.t) / interval + 1e-9);
      if (segments < 1) return setStatus("区间不足一个完整 BPM 拍长", true);
      endTime = Math.round(range.start.event.t + segments * interval);
      for (let i = 1; i < segments; i++) times.push(range.start.event.t + i * interval);
      try { times = validateGeneratedTimes(times, range.start.event.t, endTime); }
      catch (error) { return setStatus(error.message, true); }
      const collision = timelineEvents(range.trackName).some(event => event !== range.start.event && event !== range.end.event && event.t === endTime);
      if (collision) return setStatus("覆盖后的末锚点会与现有事件冲突", true);
    }
    commit(mode === "count" ? `生成 ${times.length} 个中间节拍` : `按 ${value} BPM 生成节拍`, () => {
      if (range.trackName === "combat_line") ensureDefinition(type);
      range.end.event.t = endTime;
      times.forEach(time => timelineEvents(range.trackName).push({ t: time, type }));
    });
  }

  function cycleTargets(showError = true) {
    const range = getRange(showError);
    if (!range) return null;
    const x = Number($("advCycleSize").value);
    const k = Number($("advCycleTake").value);
    if (!Number.isInteger(x) || !Number.isInteger(k) || x < 1 || k < 1 || k > x) {
      if (showError) setStatus("周期参数必须满足 1 ≤ K ≤ X，且均为整数", true);
      return null;
    }
    const targets = range.events.filter((_, index) => index % x < k);
    return { range, targets, x, k };
  }

  function previewCycle() {
    const data = cycleTargets();
    if (!data) return;
    previewIds = new Set(data.targets.map(idFor));
    renderAll();
    setStatus(`周期预览：将影响 ${data.targets.length} 个事件`);
  }

  function applyCycle() {
    const data = cycleTargets();
    if (!data) return;
    const action = $("advCycleAction").value;
    const type = $("advCycleType").value.trim();
    if (action === "type" && !type) return setStatus("目标 type 不能为空", true);
    commit(action === "delete" ? `周期删除 ${data.targets.length} 个事件` : `周期修改 ${data.targets.length} 个事件`, () => {
      if (action === "delete") {
        const remove = new Set(data.targets);
        track.timeline[data.range.trackName] = timelineEvents(data.range.trackName).filter(event => !remove.has(event));
        selected.clear();
      } else {
        if (data.range.trackName === "combat_line") ensureDefinition(type);
        data.targets.forEach(event => { event.type = type; });
      }
      previewIds.clear();
    });
  }

  function doubleDensity() {
    const range = getRange();
    if (!range) return;
    const additions = [];
    for (let i = 0; i < range.events.length - 1; i++) {
      const left = range.events[i];
      const right = range.events[i + 1];
      const middle = Math.round((left.t + right.t) / 2);
      if (middle <= left.t || middle >= right.t) return setStatus(`事件 ${left.t}–${right.t} ms 之间没有可用的整数毫秒中点`, true);
      additions.push({ t: middle, type: left.type, ...(left.props ? { props: clone(left.props) } : {}) });
    }
    commit(`选区节拍翻倍：新增 ${additions.length} 个`, () => {
      timelineEvents(range.trackName).push(...additions);
    });
  }

  function halfDensity() {
    const range = getRange();
    if (!range) return;
    const remove = new Set(range.events.filter((_, index) => index > 0 && index < range.events.length - 1 && index % 2 === 1));
    if (!remove.size) return setStatus("选区内没有可删除的内部奇数位节拍", true);
    commit(`选区节拍减半：删除 ${remove.size} 个`, () => {
      track.timeline[range.trackName] = timelineEvents(range.trackName).filter(event => !remove.has(event));
    });
  }

  function fitTimeline(render = true) {
    if (!track) return;
    const { viewportWidth } = contentMetrics();
    pxPerMs = Math.max(0.001, Math.min(1, viewportWidth / displayDurationMs()));
    fitMode = true;
    $("advTimelineScroll").scrollLeft = 0;
    if (render) renderAll();
  }

  function zoom(factor, anchorClientX = null) {
    const { scroll, labelWidth } = contentMetrics();
    const old = pxPerMs;
    const rect = scroll.getBoundingClientRect();
    const anchorX = anchorClientX == null ? scroll.clientWidth / 2 : anchorClientX - rect.left;
    const anchorTime = Math.max(0, (scroll.scrollLeft + anchorX - labelWidth) / old);
    pxPerMs = Math.max(0.001, Math.min(1, pxPerMs * factor));
    fitMode = false;
    renderTimeline();
    scroll.scrollLeft = Math.max(0, anchorTime * pxPerMs - anchorX + labelWidth);
    renderAll();
  }

  function drawRuler() {
    const canvas = $("advRuler");
    if (!canvas || !track) return;
    const width = canvas.clientWidth || 1;
    const dpr = devicePixelRatio || 1;
    const height = canvas.clientHeight || 28;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.scale(dpr, dpr);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#101517";
    context.fillRect(0, 0, width, height);
    const scrollLeft = $("advTimelineScroll").scrollLeft;
    const start = scrollLeft / pxPerMs;
    let step = chooseRulerStep();
    const first = Math.floor(start / step) * step;
    context.font = "9px ui-monospace";
    context.textBaseline = "top";
    for (let time = first; time <= start + width / pxPerMs + step; time += step) {
      const x = (time - start) * pxPerMs;
      context.strokeStyle = "#405055";
      context.beginPath(); context.moveTo(x, Math.max(14, height - 12)); context.lineTo(x, height); context.stroke();
      context.fillStyle = "#8b9698";
      context.fillText(formatTime(Math.max(0, Math.round(time))), x + 4, 4);
    }
    $("advZoomLabel").textContent = `${(pxPerMs * 1000).toFixed(pxPerMs < 0.01 ? 1 : 0)} px/s${fitMode ? " · 适应" : ""}`;
  }

  function chooseRulerStep() {
    const candidates = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];
    return candidates.find(step => step * pxPerMs >= 80) || 120000;
  }

  function formatTime(ms) {
    ms = Math.max(0, Math.round(ms));
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor(ms % 60000 / 1000);
    const millis = ms % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  async function decodeWaveform(file) {
    const token = ++waveformToken;
    waveformSource = file;
    waveformBuffer = null;
    waveformLevels = [];
    $("advWaveStatus").textContent = "正在解码…";
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      await context.close();
      if (token !== waveformToken) return;
      waveformBuffer = buffer;
      waveformLevels = buildPeakLevels(buffer);
      $("advWaveStatus").textContent = `${buffer.numberOfChannels} 声道 · ${buffer.sampleRate} Hz`;
      if (fitMode) fitTimeline(false);
      renderAll();
    } catch (error) {
      if (token !== waveformToken) return;
      $("advWaveStatus").textContent = "波形解码失败，时间线仍可编辑";
      setStatus(`波形解码失败：${error.message}`, true);
      drawWaveform();
    }
  }

  function buildPeakLevels(buffer) {
    const baseSize = 128;
    const buckets = Math.ceil(buffer.length / baseSize);
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    for (let bucket = 0; bucket < buckets; bucket++) {
      let lo = 1;
      let hi = -1;
      const from = bucket * baseSize;
      const to = Math.min(buffer.length, from + baseSize);
      for (let sample = from; sample < to; sample++) {
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const value = buffer.getChannelData(channel)[sample];
          if (value < lo) lo = value;
          if (value > hi) hi = value;
        }
      }
      min[bucket] = lo;
      max[bucket] = hi;
    }
    const levels = [{ size: baseSize, min, max }];
    while (levels.at(-1).min.length > 2048) {
      const previous = levels.at(-1);
      const length = Math.ceil(previous.min.length / 2);
      const nextMin = new Float32Array(length);
      const nextMax = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const a = i * 2;
        const b = Math.min(a + 1, previous.min.length - 1);
        nextMin[i] = Math.min(previous.min[a], previous.min[b]);
        nextMax[i] = Math.max(previous.max[a], previous.max[b]);
      }
      levels.push({ size: previous.size * 2, min: nextMin, max: nextMax });
    }
    return levels;
  }

  function drawWaveform() {
    const canvas = $("advWaveform");
    if (!canvas || !track) return;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 112;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    context.scale(dpr, dpr);
    context.fillStyle = "#0a1013";
    context.fillRect(0, 0, width, height);
    const startMs = $("advTimelineScroll").scrollLeft / pxPerMs;
    const beatMs = 60000 / bpm();
    const firstBeat = Math.floor(startMs / beatMs) * beatMs;
    for (let time = firstBeat; time <= startMs + width / pxPerMs + beatMs; time += beatMs) {
      const x = (time - startMs) * pxPerMs;
      context.strokeStyle = Math.round(time / beatMs) % 4 === 0 ? "#34464e" : "#1d2a2f";
      context.beginPath(); context.moveTo(x + .5, 0); context.lineTo(x + .5, height); context.stroke();
    }
    context.strokeStyle = "#2a383e";
    context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
    if (!waveformBuffer || !waveformLevels.length) {
      context.fillStyle = "#536064";
      context.font = "11px ui-monospace";
      context.fillText("NO WAVEFORM", 14, 18);
    } else {
      const samplesPerMs = waveformBuffer.sampleRate / 1000;
      const samplesPerPixel = samplesPerMs / pxPerMs;
      let level = waveformLevels[0];
      for (const candidate of waveformLevels) {
        if (candidate.size <= samplesPerPixel * 1.5) level = candidate;
        else break;
      }
      const peaks = [];
      for (let x = 0; x < width; x++) {
        const sampleStart = Math.floor((startMs + x / pxPerMs) * samplesPerMs);
        const sampleEnd = Math.min(waveformBuffer.length, Math.ceil(sampleStart + samplesPerPixel));
        let lo = 1;
        let hi = -1;
        if (samplesPerPixel < waveformLevels[0].size) {
          const stride = Math.max(1, Math.floor((sampleEnd - sampleStart) / 24));
          for (let sample = sampleStart; sample < sampleEnd; sample += stride) {
            for (let channel = 0; channel < waveformBuffer.numberOfChannels; channel++) {
              const value = waveformBuffer.getChannelData(channel)[sample] || 0;
              lo = Math.min(lo, value);
              hi = Math.max(hi, value);
            }
          }
        } else {
          const from = Math.max(0, Math.floor(sampleStart / level.size));
          const to = Math.min(level.min.length, Math.ceil(sampleEnd / level.size));
          for (let bucket = from; bucket < to; bucket++) {
            lo = Math.min(lo, level.min[bucket]);
            hi = Math.max(hi, level.max[bucket]);
          }
        }
        if (hi < lo) { lo = 0; hi = 0; }
        peaks.push([height / 2 + lo * height * 0.43, height / 2 + hi * height * 0.43]);
      }
      const drawEnvelope = (fill, alpha, clipWidth = width) => {
        context.save();
        context.beginPath(); context.rect(0, 0, Math.max(0, clipWidth), height); context.clip();
        context.beginPath();
        peaks.forEach((peak, x) => x ? context.lineTo(x, peak[1]) : context.moveTo(x, peak[1]));
        for (let x = peaks.length - 1; x >= 0; x--) context.lineTo(x, peaks[x][0]);
        context.closePath(); context.fillStyle = fill; context.globalAlpha = alpha; context.fill();
        context.restore();
      };
      drawEnvelope("#5f7780", .42);
      const playX = ((audio?.currentTime || 0) * 1000 - startMs) * pxPerMs;
      drawEnvelope("#66e2f5", .95, playX);
    }
    const drawExcludedRegion = (fromMs, toMs, label, fill, hatch) => {
      const fromX = (fromMs - startMs) * pxPerMs;
      const toX = (toMs - startMs) * pxPerMs;
      const visibleFrom = Math.max(0, Math.min(width, fromX));
      const visibleTo = Math.max(0, Math.min(width, toX));
      const regionWidth = Math.max(0, visibleTo - visibleFrom);
      if (regionWidth <= 0) return;
      context.fillStyle = fill;
      context.fillRect(visibleFrom, 0, regionWidth, height);
      context.save();
      context.beginPath(); context.rect(visibleFrom, 0, regionWidth, height); context.clip();
      context.strokeStyle = hatch; context.lineWidth = 1;
      for (let x = visibleFrom - height; x < visibleTo + height; x += 12) {
        context.beginPath(); context.moveTo(x, height); context.lineTo(x + height, 0); context.stroke();
      }
      context.restore();
      if (regionWidth >= 72) {
        context.fillStyle = "#ffd7d9";
        context.font = "700 10px ui-monospace";
        context.fillText(label, visibleFrom + 10, 17, regionWidth - 18);
      }
    };
    const playbackStart = playbackStartMs();
    drawExcludedRegion(0, playbackStart, `排除至 ${formatTime(playbackStart)}`, "#3d171dcc", "#a84a5577");
    const audioEnd = audioDurationMs();
    const configuredEnd = durationMs();
    if (audioEnd > configuredEnd) {
      drawExcludedRegion(configuredEnd, audioEnd, `${formatTime(configuredEnd)} 后排除`, "#3d2a13d9", "#bd874d88");
    }
    const excludedEndX = (playbackStart - startMs) * pxPerMs;
    if (excludedEndX >= 0 && excludedEndX <= width && playbackStartMs() > 0) {
      context.strokeStyle = "#ff8d96"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(excludedEndX + .5, 0); context.lineTo(excludedEndX + .5, height); context.stroke();
    }
    const configuredEndX = (configuredEnd - startMs) * pxPerMs;
    if (audioEnd > configuredEnd && configuredEndX >= 0 && configuredEndX <= width) {
      context.strokeStyle = "#ffbd73"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(configuredEndX + .5, 0); context.lineTo(configuredEndX + .5, height); context.stroke();
    }
    const playX = ((audio?.currentTime || 0) * 1000 - startMs) * pxPerMs;
    if (playX >= 0 && playX <= width) {
      context.strokeStyle = "#ff7272"; context.lineWidth = 1.5;
      context.beginPath(); context.moveTo(playX + .5, 0); context.lineTo(playX + .5, height); context.stroke();
    }
  }

  function updatePlayhead() {
    if (!track) return;
    const { labelWidth } = contentMetrics();
    const time = Math.max(0, (audio?.currentTime || 0) * 1000);
    $("advCurrentTime").textContent = formatTime(time);
    $("advPlayhead").style.left = `${labelWidth + time * pxPerMs}px`;
    if (audio && !audio.paused && !fitMode) {
      const scroll = $("advTimelineScroll");
      const visibleX = labelWidth + time * pxPerMs - scroll.scrollLeft;
      if (visibleX > scroll.clientWidth * .84) scroll.scrollLeft = Math.max(0, labelWidth + time * pxPerMs - scroll.clientWidth * .28);
      else if (visibleX < labelWidth) scroll.scrollLeft = Math.max(0, time * pxPerMs - labelWidth);
    }
    drawWaveform();
  }

  function startTransportAnimation() {
    cancelAnimationFrame(animationFrame);
    previewBeatIndex = findCombatBeat((audio?.currentTime || 0) * 1000);
    const frame = () => {
      updatePlayhead();
      playMetronomeEvents();
      if (audio && !audio.paused) animationFrame = requestAnimationFrame(frame);
      else $("advPlay").textContent = "▶";
    };
    animationFrame = requestAnimationFrame(frame);
  }

  function findCombatBeat(ms) {
    const events = timelineEvents("combat_line");
    let index = 0;
    while (index < events.length && events[index].t < ms - 35) index++;
    return index;
  }

  function playMetronomeEvents() {
    if (!$("advMetronome")?.checked || !audio) return;
    const now = audio.currentTime * 1000;
    const events = timelineEvents("combat_line");
    while (previewBeatIndex < events.length && events[previewBeatIndex].t <= now + 25) {
      if (events[previewBeatIndex].t >= now - 90) clickTone(events[previewBeatIndex].type);
      previewBeatIndex++;
    }
  }

  function clickTone(type) {
    previewAudioContext = previewAudioContext || new (window.AudioContext || window.webkitAudioContext)();
    const now = previewAudioContext.currentTime;
    const oscillator = previewAudioContext.createOscillator();
    const gain = previewAudioContext.createGain();
    const index = Math.max(0, Object.keys(track.definitions).indexOf(type));
    const volume = Math.max(1, Math.min(10, Number($("advMetronomeVolume").value) || 1));
    oscillator.frequency.setValueAtTime(650 + index * 130, now);
    gain.gain.setValueAtTime(0.12 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    oscillator.connect(gain).connect(previewAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.07);
  }

  function renderInspector() {
    document.querySelectorAll("[data-adv-inspector]").forEach(button => button.classList.toggle("active", button.dataset.advInspector === inspectorTab));
    if (inspectorTab === "event") renderEventInspector();
    else if (inspectorTab === "track") renderTrackInspector();
    else if (inspectorTab === "project") renderProjectInspector();
    else renderDefinitionInspector();
  }

  function renderEventInspector() {
    const infos = selectedInfo();
    if (!infos.length) {
      $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>事件属性</h3><p class="advInspectorEmpty">选择一个事件编辑时间、type 与 props；框选或 Ctrl 点击可以执行多选操作。</p></div>`;
      return;
    }
    if (infos.length > 1) {
      $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>${infos.length} 个事件</h3>
        <label>批量设置 type<input id="advBulkEventType" list="advTypeList" placeholder="输入 type"></label>
        <button class="wide" data-action="apply-bulk-type">应用到所选事件</button>
        <h4>BULK PROPS</h4>
        <label>属性名<input id="advBulkPropKey" value="${esc(bulkPropDraft.key)}" placeholder="landing_x_percent"></label>
        <label>值表达式<input id="advBulkPropExpression" value="${esc(bulkPropDraft.expression)}" placeholder='x % 4 == 0 ? "beats/a.png" : null'></label>
        <button class="wide" data-action="apply-bulk-prop">计算并批量添加</button>
        <p class="subtle">由内置 math.js 计算：支持完整数学函数与常量、数组/矩阵、复数、单位、隐式乘法和三元条件“? :”。幂使用 ^，逻辑使用 and / or / not，比较使用 == / !=；也兼容 **、&amp;&amp;、||、===、!==。text(...) 可拼接字符串。最终结果须为 number、string、boolean 或 null；null 表示该事件不修改。x / i 从 0 开始，n 从 1 开始，t 是事件时间（ms），count 是所选数量。</p>
        <label>复制到轨道<select id="advCopyTarget">${timelineNames().map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select></label>
        <button class="wide" data-action="copy-to-track">按绝对时间复制</button>
        <p class="subtle">跨轨复制会保留时间、type 与 props；复制进 combat_line 时会自动补齐缺失 definition。</p></div>`;
      return;
    }
    const info = infos[0];
    const props = info.event.props && typeof info.event.props === "object" ? info.event.props : {};
    $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>事件属性</h3>
      <label>轨道<input value="${esc(info.trackName)}" readonly></label>
      <label>时间 t <span>ms</span><input id="advEventTime" type="number" min="0" step="1" value="${info.event.t}"></label>
      <label>类型 type<input id="advEventType" value="${esc(info.event.type)}" list="advTypeList"></label>
      <h4>PROPS</h4><div class="advProps">${Object.entries(props).map(([key, value]) => propRow(key, value)).join("")}</div>
      <label>新属性名<input id="advNewPropKey" placeholder="label"></label><label>值<input id="advNewPropValue" placeholder="drop"></label>
      <button data-action="add-event-prop">添加属性</button>
      <p class="advInspectorNote">props 仅支持 number、boolean、string；与 definition 同名的核心字段（包括 Falling 视觉字段）会覆盖当前事件，其他标量扩展键仍会保留。</p></div>`;
  }

  function propRow(key, value) {
    return `<div class="advPropRow"><input data-prop-key value="${esc(key)}" aria-label="属性名"><input data-prop-value value="${esc(valueText(value))}" aria-label="${esc(key)} 的值"><button data-action="remove-event-prop" data-key="${esc(key)}">×</button></div>`;
  }

  function valueText(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function parseScalar(value) {
    const text = String(value).trim();
    if (text === "true") return true;
    if (text === "false") return false;
    if (text !== "" && Number.isFinite(Number(text))) return Number(text);
    return text;
  }

  function normalizeBulkMathSyntax(source) {
    let result = "";
    let quote = "";
    let escaped = false;
    for (let index = 0; index < source.length;) {
      const char = source[index];
      if (quote) {
        result += char;
        index++;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        result += char;
        index++;
        continue;
      }
      const replacements = [
        ["!==", "!="], ["===", "=="], ["&&", " and "], ["||", " or "], ["**", "^"]
      ];
      const replacement = replacements.find(([token]) => source.startsWith(token, index));
      if (replacement) {
        result += replacement[1];
        index += replacement[0].length;
      } else {
        result += char;
        index++;
      }
    }
    return result;
  }

  function getBulkMathRuntime() {
    if (bulkMathRuntime) return bulkMathRuntime;
    if (!window.math?.parse || !window.math?.import) throw Error("math.js 未加载，请刷新页面后重试");

    const instance = window.math;
    const parse = instance.parse.bind(instance);
    const disabled = name => () => { throw Error(`批量表达式中禁用函数：${name}`); };
    const scalarText = value => {
      if (value === null) return "null";
      if (["number", "string", "boolean", "bigint"].includes(typeof value)) return String(value);
      if (instance.isBigNumber?.(value) || instance.isFraction?.(value)) return String(value);
      if (instance.isComplex?.(value) && Number(value.im) === 0) return String(value.re);
      throw Error("text(...) 只接受标量参数");
    };

    // math.js 官方安全建议：表达式环境不开放导入、单位定义、二次解析与符号变换。
    instance.import({
      import: disabled("import"),
      createUnit: disabled("createUnit"),
      reviver: disabled("reviver"),
      evaluate: disabled("evaluate"),
      parse: disabled("parse"),
      compile: disabled("compile"),
      parser: disabled("parser"),
      simplify: disabled("simplify"),
      derivative: disabled("derivative"),
      resolve: disabled("resolve"),
      text: (...values) => values.map(scalarText).join(""),
      clamp: (value, minimum, maximum) => instance.min(maximum, instance.max(minimum, value))
    }, { override: true });
    bulkMathRuntime = { instance, parse };
    return bulkMathRuntime;
  }

  function normalizeBulkMathResult(value, instance) {
    if (value === null) return { matched: false };
    if (typeof value === "string" || typeof value === "boolean") return { matched: true, value };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw Error("表达式结果必须是有限数字");
      return { matched: true, value };
    }
    if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw Error("整数结果超出可安全保存范围");
      return { matched: true, value: number };
    }
    if (instance.isBigNumber?.(value)) {
      const number = value.toNumber();
      if (!Number.isFinite(number)) throw Error("高精度数值结果超出可保存范围");
      return { matched: true, value: number };
    }
    if (instance.isFraction?.(value)) {
      const number = Number(value.valueOf());
      if (!Number.isFinite(number)) throw Error("分数结果超出可保存范围");
      return { matched: true, value: number };
    }
    if (instance.isComplex?.(value)) {
      const real = Number(value.re);
      if (Number(value.im) !== 0 || !Number.isFinite(real)) throw Error("复数结果不能直接保存为事件属性；请先取 re(...)、im(...)、abs(...) 等标量");
      return { matched: true, value: real };
    }
    throw Error("表达式最终结果必须是 number、string、boolean 或 null；数组、矩阵和单位只能用于中间计算");
  }

  function compileMathBulkExpression(source) {
    const text = String(source).trim();
    if (!text) throw Error("值表达式不能为空");
    if (text.length > 4096) throw Error("值表达式不能超过 4096 个字符");
    const { instance, parse } = getBulkMathRuntime();
    let node;
    try {
      node = parse(normalizeBulkMathSyntax(text));
    } catch (error) {
      throw Error(`表达式语法错误：${error.message || error}`);
    }
    node.traverse(child => {
      if (["AssignmentNode", "FunctionAssignmentNode", "BlockNode"].includes(child.type)) {
        throw Error("批量表达式不允许赋值、定义函数或多语句");
      }
    });
    const compiled = node.compile();
    return variables => {
      try {
        const scope = new Map(Object.entries(variables));
        return normalizeBulkMathResult(compiled.evaluate(scope), instance);
      } catch (error) {
        throw Error(`表达式计算失败：${error.message || error}`);
      }
    };
  }

  function compileBulkExpression(source) {
    if (window.math?.parse && window.math?.import) return compileMathBulkExpression(source);
    const text = String(source).trim();
    if (!text) throw Error("值表达式不能为空");
    let position = 0;
    let token;

    const readToken = () => {
      while (/\s/.test(text[position] || "")) position++;
      const start = position;
      if (position >= text.length) return { type: "eof", value: "", position };
      const remaining = text.slice(position);
      const number = remaining.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (number) {
        position += number[0].length;
        return { type: "number", value: Number(number[0]), position: start };
      }
      const identifier = remaining.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (identifier) {
        position += identifier[0].length;
        return { type: "identifier", value: identifier[0], position: start };
      }
      const quote = text[position];
      if (quote === '"' || quote === "'") {
        position++;
        let value = "";
        while (position < text.length) {
          const char = text[position++];
          if (char === quote) return { type: "string", value, position: start };
          if (char !== "\\") {
            value += char;
            continue;
          }
          if (position >= text.length) break;
          const escaped = text[position++];
          const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
          if (escaped === "u") {
            const hex = text.slice(position, position + 4);
            if (!/^[0-9a-f]{4}$/i.test(hex)) throw Error(`表达式第 ${position + 1} 个字符的 Unicode 转义无效`);
            value += String.fromCharCode(parseInt(hex, 16));
            position += 4;
          } else value += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
        }
        throw Error(`表达式第 ${start + 1} 个字符的字符串缺少结束引号`);
      }
      const operators = ["===", "!==", "**", "&&", "||", "==", "!=", "<=", ">=", "+", "-", "*", "/", "%", "(", ")", "?", ":", ",", "!", "<", ">"];
      const operator = operators.find(item => text.startsWith(item, position));
      if (!operator) throw Error(`表达式第 ${position + 1} 个字符无效`);
      position += operator.length;
      return { type: "operator", value: operator, position: start };
    };
    const advance = () => {
      const current = token;
      token = readToken();
      return current;
    };
    const match = value => {
      if (token.type !== "operator" || token.value !== value) return false;
      advance();
      return true;
    };
    const expect = value => {
      if (!match(value)) throw Error(`表达式第 ${token.position + 1} 个字符应为 ${value}`);
    };
    const binary = (operator, left, right) => ({ type: "binary", operator, left, right });

    const parsePrimary = () => {
      if (token.type === "number" || token.type === "string") {
        const current = advance();
        return { type: "literal", value: current.value };
      }
      if (token.type === "identifier") {
        const name = advance().value;
        if (name === "true") return { type: "literal", value: true };
        if (name === "false") return { type: "literal", value: false };
        if (name === "null") return { type: "literal", value: null };
        if (!match("(")) return { type: "variable", name };
        const args = [];
        if (!match(")")) {
          do { args.push(parseConditional()); } while (match(","));
          expect(")");
        }
        return { type: "call", name, args };
      }
      if (match("(")) {
        const value = parseConditional();
        expect(")");
        return value;
      }
      throw Error(`表达式第 ${token.position + 1} 个字符缺少值`);
    };
    const parsePower = () => {
      const left = parsePrimary();
      return match("**") ? binary("**", left, parseUnary()) : left;
    };
    const parseUnary = () => {
      if (token.type === "operator" && ["!", "+", "-"].includes(token.value)) {
        return { type: "unary", operator: advance().value, argument: parseUnary() };
      }
      return parsePower();
    };
    const parseMultiplicative = () => {
      let value = parseUnary();
      while (token.type === "operator" && ["*", "/", "%"].includes(token.value)) {
        value = binary(advance().value, value, parseUnary());
      }
      return value;
    };
    const parseAdditive = () => {
      let value = parseMultiplicative();
      while (token.type === "operator" && ["+", "-"].includes(token.value)) {
        value = binary(advance().value, value, parseMultiplicative());
      }
      return value;
    };
    const parseComparison = () => {
      let value = parseAdditive();
      while (token.type === "operator" && ["<", "<=", ">", ">="].includes(token.value)) {
        value = binary(advance().value, value, parseAdditive());
      }
      return value;
    };
    const parseEquality = () => {
      let value = parseComparison();
      while (token.type === "operator" && ["==", "===", "!=", "!=="].includes(token.value)) {
        value = binary(advance().value, value, parseComparison());
      }
      return value;
    };
    const parseLogicalAnd = () => {
      let value = parseEquality();
      while (match("&&")) value = binary("&&", value, parseEquality());
      return value;
    };
    const parseLogicalOr = () => {
      let value = parseLogicalAnd();
      while (match("||")) value = binary("||", value, parseLogicalAnd());
      return value;
    };
    function parseConditional() {
      const condition = parseLogicalOr();
      if (!match("?")) return condition;
      const consequent = parseConditional();
      expect(":");
      return { type: "conditional", condition, consequent, alternate: parseConditional() };
    }

    token = readToken();
    const ast = parseConditional();
    if (token.type !== "eof") throw Error(`表达式第 ${token.position + 1} 个字符无效`);
    return variables => {
      const finiteNumber = (value, label = "运算") => {
        const number = Number(value);
        if (!Number.isFinite(number)) throw Error(`${label}需要有限数字`);
        return number;
      };
      const finiteResult = (value, label) => {
        if (!Number.isFinite(value)) throw Error(`${label}结果必须是有限数字`);
        return value;
      };
      const calculate = node => {
        if (node.type === "literal") return node.value;
        if (node.type === "variable") {
          if (!Object.prototype.hasOwnProperty.call(variables, node.name)) throw Error(`不支持的表达式变量：${node.name}`);
          return variables[node.name];
        }
        if (node.type === "unary") {
          const value = calculate(node.argument);
          if (node.operator === "!") return !value;
          return node.operator === "+" ? finiteNumber(value, "一元 + ") : -finiteNumber(value, "一元 - ");
        }
        if (node.type === "conditional") return calculate(node.condition) ? calculate(node.consequent) : calculate(node.alternate);
        if (node.type === "call") {
          const args = node.args.map(calculate);
          const numeric = args.map(value => finiteNumber(value, `${node.name} `));
          let result;
          if (node.name === "abs" && numeric.length === 1) result = Math.abs(numeric[0]);
          else if (node.name === "round" && numeric.length === 1) result = Math.round(numeric[0]);
          else if (node.name === "floor" && numeric.length === 1) result = Math.floor(numeric[0]);
          else if (node.name === "ceil" && numeric.length === 1) result = Math.ceil(numeric[0]);
          else if (node.name === "sqrt" && numeric.length === 1) result = Math.sqrt(numeric[0]);
          else if (node.name === "pow" && numeric.length === 2) result = Math.pow(numeric[0], numeric[1]);
          else if (node.name === "min" && numeric.length) result = Math.min(...numeric);
          else if (node.name === "max" && numeric.length) result = Math.max(...numeric);
          else if (node.name === "clamp" && numeric.length === 3) result = Math.min(numeric[2], Math.max(numeric[1], numeric[0]));
          else throw Error(`不支持的函数或参数数量：${node.name}`);
          if (!Number.isFinite(result)) throw Error(`${node.name} 的结果必须是有限数字`);
          return result;
        }
        if (node.operator === "&&") {
          const left = calculate(node.left);
          return left ? calculate(node.right) : left;
        }
        if (node.operator === "||") {
          const left = calculate(node.left);
          return left ? left : calculate(node.right);
        }
        const left = calculate(node.left);
        const right = calculate(node.right);
        if (node.operator === "+") {
          if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
          return finiteResult(finiteNumber(left, "加法") + finiteNumber(right, "加法"), "加法");
        }
        if (node.operator === "-") return finiteResult(finiteNumber(left, "减法") - finiteNumber(right, "减法"), "减法");
        if (node.operator === "*") return finiteResult(finiteNumber(left, "乘法") * finiteNumber(right, "乘法"), "乘法");
        if (node.operator === "/") return finiteResult(finiteNumber(left, "除法") / finiteNumber(right, "除法"), "除法");
        if (node.operator === "%") return finiteResult(finiteNumber(left, "取模") % finiteNumber(right, "取模"), "取模");
        if (node.operator === "**") return finiteResult(finiteNumber(left, "乘方") ** finiteNumber(right, "乘方"), "乘方");
        if (node.operator === "==" || node.operator === "===") return left === right;
        if (node.operator === "!=" || node.operator === "!==") return left !== right;
        if (node.operator === "<") return left < right;
        if (node.operator === "<=") return left <= right;
        if (node.operator === ">") return left > right;
        return left >= right;
      };
      const value = calculate(ast);
      if (value === null) return { matched: false };
      if (!["number", "string", "boolean"].includes(typeof value)) throw Error("表达式结果必须是 number、string、boolean 或 null");
      if (typeof value === "number" && !Number.isFinite(value)) throw Error("表达式结果必须是有限数字");
      return { matched: true, value };
    };
  }

  function renderTrackInspector() {
    const names = timelineNames();
    $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>轨道管理</h3>
      <div class="advTrackList">${names.map((name, index) => `<div class="advTrackItem${name === activeTrack ? " active" : ""}">
        <input data-track-rename="${esc(name)}" value="${esc(name)}" ${name === "combat_line" ? "readonly" : ""} aria-label="轨道名称">
        <button data-track-up="${esc(name)}" ${index === 0 ? "disabled" : ""}>↑</button>
        <button data-track-down="${esc(name)}" ${index === names.length - 1 ? "disabled" : ""}>↓</button>
        <button class="danger" data-track-delete="${esc(name)}" ${name === "combat_line" ? "disabled" : ""}>×</button>
      </div>`).join("")}</div>
      <label>新轨道名称<input id="advNewTrackName" placeholder="lighting"></label><button data-action="add-track">＋ 添加命名轨</button>
      <p class="advInspectorNote">combat_line 是必需战斗轨。其他命名轨会写入 track.json，但 DJCraft 当前尚未调度这些特效事件。</p></div>`;
  }

  function renderProjectInspector() {
    const meta = track.meta;
    const settings = track.settings;
    $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>工程参数</h3>
      <h4>META</h4>
      ${projectInput("version", "版本 version", meta.version ?? "1.0")}
      ${projectInput("author", "作者 author", meta.author ?? "")}
      ${projectInput("bpm", "BPM", meta.bpm ?? 120, "number", "0.0001")}
      ${projectInput("difficulty", "难度 difficulty", meta.difficulty ?? "normal")}
      ${projectInput("sound_file", "包内音频 sound_file", meta.sound_file ?? "track.ogg", "text", "", true)}
      ${projectInput("offset_ms", "时间偏移 offset_ms", meta.offset_ms ?? 0, "number", "1")}
      ${projectInput("playback_start_ms", "起播位置 playback_start_ms", meta.playback_start_ms ?? 0, "number", "1", false, "0")}
      ${projectInput("total_duration_ms", "总时长 total_duration_ms", meta.total_duration_ms ?? 0, "number", "1")}
      ${projectInput("display_name", "显示名称 display_name", meta.display_name ?? "")}
      <h4>SETTINGS</h4>
      <label>准星模式 crosshair_mode<select data-project-section="settings" data-project-key="crosshair_mode"><option value="time" ${settings.crosshair_mode === "time" ? "selected" : ""}>time</option><option value="beat" ${settings.crosshair_mode === "beat" ? "selected" : ""}>beat</option></select></label>
      ${settingsInput("crosshair_time_ms", "时间窗口 crosshair_time_ms", settings.crosshair_time_ms ?? 1400, "number", "1")}
      ${settingsInput("crosshair_beat_count", "节拍数量 crosshair_beat_count", settings.crosshair_beat_count ?? 4, "number", "1")}
      ${settingsInput("volume_multiplier", "音量倍率 volume_multiplier", settings.volume_multiplier ?? 1, "number", "0.01")}
      <p class="advInspectorNote">difficulty 以及部分 definition 字段当前仅保存；高级编辑器不会把未完成的游戏端能力标记为已生效。</p></div>`;
  }

  function projectInput(key, label, value, type = "text", step = "", readonly = false, min = "") {
    return `<label>${label}<input data-project-section="meta" data-project-key="${key}" type="${type}" ${step ? `step="${step}"` : ""} ${min !== "" ? `min="${min}"` : ""} value="${esc(value)}" ${readonly ? "readonly" : ""}></label>`;
  }

  function settingsInput(key, label, value, type = "text", step = "") {
    return `<label>${label}<input data-project-section="settings" data-project-key="${key}" type="${type}" ${step ? `step="${step}"` : ""} value="${esc(value)}"></label>`;
  }

  function renderDefinitionInspector() {
    const names = Object.keys(track.definitions);
    const current = $("advDefinitionSelect")?.value;
    const selectedName = names.includes(current) ? current : names[0];
    const definition = track.definitions[selectedName];
    const extras = Object.entries(definition).filter(([key]) => !KNOWN_DEFINITION_KEYS.has(key));
    $("advInspectorContent").innerHTML = `<div class="advInspectorSection"><h3>节拍定义</h3>
      <div class="advDefinitionList"><select id="advDefinitionSelect">${names.map(name => `<option value="${esc(name)}" ${name === selectedName ? "selected" : ""}>${esc(name)}</option>`).join("")}</select><button data-action="add-definition">＋</button><button class="danger" data-action="remove-definition">×</button></div>
      <label>定义名称<input id="advDefinitionName" value="${esc(selectedName)}"></label>
      <label><input data-definition-key="can_attack" type="checkbox" ${definition.can_attack !== false ? "checked" : ""}>允许攻击 can_attack</label>
      ${definitionInput("color", "颜色 color", definition.color ?? "#FFFFFF", "color")}
      ${definitionInput("scale", "视觉缩放 scale", definition.scale ?? 1, "number", "0.01")}
      ${definitionInput("damage_rate", "伤害倍率 damage_rate", definition.damage_rate ?? 1, "number", "0.01")}
      <label>战斗类别 category<select data-definition-key="category"><option value="normal" ${(definition.category ?? "normal") === "normal" ? "selected" : ""}>normal</option><option value="weakbeat" ${definition.category === "weakbeat" ? "selected" : ""}>weakbeat</option><option value="downbeat" ${definition.category === "downbeat" ? "selected" : ""}>downbeat</option></select></label>
      ${definitionInput("haptic_intensity", "震动强度 haptic_intensity", definition.haptic_intensity ?? 1, "number", "0.01")}
      ${definitionInput("tolerance", "判定容差 tolerance", definition.tolerance ?? 0.1, "number", "0.01")}
      ${definitionInput("particle", "粒子 particle", definition.particle ?? "")}
      ${definitionInput("trigger", "条件 trigger", definition.trigger ?? "")}
      ${definitionInput("texture", "下落贴图 texture", definition.texture ?? "", "text", "", 'placeholder="beats/normal.png"')}
      ${definitionInput("landing_x_percent", "落点横坐标 landing_x_percent (%)", definition.landing_x_percent ?? 50, "number", "0.1", 'min="0" max="100"')}
      ${definitionInput("spawn_advance_ms", "提前生成 spawn_advance_ms (ms)", definition.spawn_advance_ms ?? 1400, "number", "1", 'min="1" max="60000"')}
      ${behaviorSelect("hit_behavior", "命中行为 hit_behavior", definition.hit_behavior ?? "freeze_dissipate")}
      ${behaviorSelect("matched_hit_behavior", "标签匹配命中 matched_hit_behavior", definition.matched_hit_behavior ?? "", true)}
      ${behaviorSelect("miss_behavior", "未命中行为 miss_behavior", definition.miss_behavior ?? "none")}
      ${definitionInput("rotation_rpm", "旋转速度 rotation_rpm", definition.rotation_rpm ?? 0, "number", "0.1", 'min="-10000" max="10000"')}
      <h4>扩展键</h4>
      <div class="advProps">${extras.map(([key, value]) => `<div class="advPropRow"><input value="${esc(key)}" readonly><input data-definition-extra="${esc(key)}" value="${esc(valueText(value))}"><button data-action="remove-definition-extra" data-key="${esc(key)}">×</button></div>`).join("")}</div>
      <label>新键<input id="advNewDefKey" placeholder="custom_key"></label><label>值<input id="advNewDefValue"></label><button data-action="add-definition-extra">添加扩展键</button>
      <p class="advInspectorNote">texture 可填写资源管理中的 beats/*.png 或 beats/*.gif；matched_hit_behavior 留空时继承 hit_behavior。haptic_intensity、particle、trigger 仍为预留字段。</p></div>`;
  }

  function definitionInput(key, label, value, type = "text", step = "", attributes = "") {
    return `<label>${label}<input data-definition-key="${key}" type="${type}" ${step ? `step="${step}"` : ""} ${attributes} value="${esc(value)}"></label>`;
  }

  function behaviorSelect(key, label, value, inherit = false) {
    const options = [
      ...(inherit ? [["", "继承 hit_behavior"]] : []),
      ...BEAT_BEHAVIORS.map(item => [item, item])
    ];
    if (!options.some(([option]) => option === value)) options.unshift([value, `${value}（当前值无效）`]);
    return `<label>${label}<select data-definition-key="${key}">${options.map(([option, text]) => `<option value="${option}" ${value === option ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
  }

  function addTrack() {
    const name = $("advNewTrackName").value.trim();
    if (!validTrackName(name)) return;
    commit(`添加轨道 ${name}`, () => {
      track.timeline[name] = [];
      activeTrack = name;
    });
    inspectorTab = "track";
  }

  function validTrackName(name, oldName = null) {
    if (!name) { setStatus("轨道名称不能为空", true); return false; }
    if (name === "combat_line" && oldName !== "combat_line") { setStatus("combat_line 是保留轨道名", true); return false; }
    if (track.timeline[name] && name !== oldName) { setStatus(`轨道 ${name} 已存在`, true); return false; }
    return true;
  }

  function renameTrack(oldName, name) {
    name = name.trim();
    if (oldName === "combat_line" || name === oldName || !validTrackName(name, oldName)) return renderInspector();
    commit(`重命名轨道 ${oldName} → ${name}`, () => {
      const next = {};
      Object.entries(track.timeline).forEach(([key, events]) => { next[key === oldName ? name : key] = events; });
      track.timeline = next;
      if (activeTrack === oldName) activeTrack = name;
    });
  }

  function reorderTrack(name, direction) {
    const entries = Object.entries(track.timeline);
    const index = entries.findIndex(([key]) => key === name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= entries.length) return;
    commit(`调整轨道顺序：${name}`, () => {
      [entries[index], entries[target]] = [entries[target], entries[index]];
      track.timeline = Object.fromEntries(entries);
    });
  }

  function removeTrack(name) {
    if (name === "combat_line") return;
    commit(`删除轨道 ${name}`, () => {
      delete track.timeline[name];
      if (activeTrack === name) activeTrack = "combat_line";
      selected.clear();
    });
  }

  function handleInspectorClick(event) {
    const action = event.target.dataset.action;
    if (!action) return;
    if (action === "add-track") addTrack();
    if (action === "apply-bulk-type") {
      const type = $("advBulkEventType").value.trim();
      if (!type) return setStatus("type 不能为空", true);
      const infos = selectedInfo();
      commit(`批量设置 ${infos.length} 个事件 type`, () => {
        if (infos.some(info => info.trackName === "combat_line")) ensureDefinition(type);
        infos.forEach(info => { info.event.type = type; });
      });
    }
    if (action === "apply-bulk-prop") {
      const key = $("advBulkPropKey").value.trim();
      const expression = $("advBulkPropExpression").value;
      if (!key) return setStatus("属性名不能为空", true);
      const infos = selectedInfo();
      let values;
      try {
        const evaluate = compileBulkExpression(expression);
        values = infos.map((info, index) => evaluate({
          x: index, i: index, n: index + 1,
          t: Number(info.event.t) || 0, count: infos.length
        }));
      } catch (error) {
        return setStatus(error.message || String(error), true);
      }
      const matchedCount = values.filter(item => item.matched).length;
      if (!matchedCount) return setStatus("没有事件命中条件，未修改 props", true);
      commit(`批量添加 ${matchedCount}/${infos.length} 个事件属性 ${key}`, () => {
        infos.forEach((info, index) => {
          if (!values[index].matched) return;
          info.event.props = info.event.props && typeof info.event.props === "object" ? info.event.props : {};
          info.event.props[key] = values[index].value;
        });
      });
    }
    if (action === "copy-to-track") {
      const destination = $("advCopyTarget").value;
      const infos = selectedInfo();
      const ids = [];
      commit(`复制 ${infos.length} 个事件到 ${destination}`, () => {
        infos.forEach(info => {
          const next = clone(info.event);
          if (destination === "combat_line") ensureDefinition(next.type);
          timelineEvents(destination).push(next);
          ids.push(idFor(next));
        });
        selected = new Set(ids);
        activeTrack = destination;
      });
    }
    if (action === "add-event-prop") {
      const info = selectedInfo()[0];
      const key = $("advNewPropKey").value.trim();
      if (!key) return setStatus("属性名不能为空", true);
      commit(`添加事件属性 ${key}`, () => {
        info.event.props = info.event.props && typeof info.event.props === "object" ? info.event.props : {};
        info.event.props[key] = parseScalar($("advNewPropValue").value);
      });
    }
    if (action === "remove-event-prop") {
      const info = selectedInfo()[0];
      commit(`删除事件属性 ${event.target.dataset.key}`, () => {
        delete info.event.props[event.target.dataset.key];
        if (!Object.keys(info.event.props).length) delete info.event.props;
      });
    }
    if (action === "add-definition") {
      let index = 1;
      let name = "custom_hit";
      while (track.definitions[name]) name = `custom_hit_${index++}`;
      commit(`添加 definition ${name}`, () => { track.definitions[name] = DEFAULT_DEFINITION(); });
      requestAnimationFrame(() => { $("advDefinitionSelect").value = name; renderDefinitionInspector(); });
    }
    if (action === "remove-definition") {
      const name = $("advDefinitionSelect").value;
      if (Object.keys(track.definitions).length <= 1) return setStatus("至少需要保留一个 definition", true);
      commit(`删除 definition ${name}`, () => {
        delete track.definitions[name];
        const fallback = Object.keys(track.definitions)[0];
        timelineEvents("combat_line").forEach(item => { if (item.type === name) item.type = fallback; });
      });
    }
    if (action === "add-definition-extra") {
      const name = $("advDefinitionSelect").value;
      const key = $("advNewDefKey").value.trim();
      if (!key || KNOWN_DEFINITION_KEYS.has(key)) return setStatus("请输入未被占用的扩展键", true);
      commit(`添加 definition 扩展键 ${key}`, () => { track.definitions[name][key] = parseScalar($("advNewDefValue").value); });
    }
    if (action === "remove-definition-extra") {
      const name = $("advDefinitionSelect").value;
      commit(`删除 definition 扩展键 ${event.target.dataset.key}`, () => { delete track.definitions[name][event.target.dataset.key]; });
    }
  }

  function handleInspectorChange(event) {
    const target = event.target;
    if (target.id === "advDefinitionSelect") return renderDefinitionInspector();
    if (target.id === "advEventTime" || target.id === "advEventType") {
      const info = selectedInfo()[0];
      if (!info) return;
      commit("编辑事件属性", () => {
        if (target.id === "advEventTime") info.event.t = clampTime(Number(target.value));
        else {
          const type = target.value.trim();
          if (!type) throw Error("type 不能为空");
          info.event.type = type;
          if (info.trackName === "combat_line") ensureDefinition(type);
        }
      });
      return;
    }
    if (target.matches("[data-prop-key],[data-prop-value]")) {
      const info = selectedInfo()[0];
      const rows = [...document.querySelectorAll(".advPropRow")];
      commit("编辑事件 props", () => {
        const props = {};
        rows.forEach(row => {
          const key = row.querySelector("[data-prop-key]")?.value.trim();
          const value = row.querySelector("[data-prop-value]")?.value;
          if (key) props[key] = parseScalar(value);
        });
        if (Object.keys(props).length) info.event.props = props;
        else delete info.event.props;
      });
      return;
    }
    if (target.dataset.trackRename) return renameTrack(target.dataset.trackRename, target.value);
    if (target.dataset.projectSection) {
      const section = target.dataset.projectSection;
      const key = target.dataset.projectKey;
      commit(`编辑 ${section}.${key}`, () => {
        let value = target.type === "number" ? Number(target.value) : target.value;
        if (target.type === "number" && !Number.isFinite(value)) throw Error(`${key} 必须是有限数值`);
        if (section === "meta" && key === "playback_start_ms") value = Math.max(0, Math.round(value));
        track[section][key] = value;
      });
      return;
    }
    if (target.id === "advDefinitionName") {
      const oldName = $("advDefinitionSelect").value;
      const name = target.value.trim();
      if (!name || (track.definitions[name] && name !== oldName)) return setStatus("definition 名称为空或已存在", true);
      commit(`重命名 definition ${oldName} → ${name}`, () => {
        const next = {};
        Object.entries(track.definitions).forEach(([key, value]) => { next[key === oldName ? name : key] = value; });
        track.definitions = next;
        timelineEvents("combat_line").forEach(item => { if (item.type === oldName) item.type = name; });
      });
      return;
    }
    if (target.dataset.definitionKey) {
      const name = $("advDefinitionSelect").value;
      const key = target.dataset.definitionKey;
      commit(`编辑 definition.${key}`, () => {
        if (target.type === "checkbox") track.definitions[name][key] = target.checked;
        else if (target.type === "number") {
          const value = Number(target.value);
          if (!Number.isFinite(value)) throw Error(`${key} 必须是有限数值`);
          if (key === "landing_x_percent" && (value < 0 || value > 100)) throw Error("landing_x_percent 必须在 0..100");
          if (key === "spawn_advance_ms" && (!Number.isInteger(value) || value < 1 || value > 60000)) throw Error("spawn_advance_ms 必须是 1..60000 的整数");
          if (key === "rotation_rpm" && (value < -10000 || value > 10000)) throw Error("rotation_rpm 必须在 -10000..10000");
          track.definitions[name][key] = value;
        } else if (key === "matched_hit_behavior" && !target.value) delete track.definitions[name][key];
        else if ((key === "particle" || key === "trigger" || key === "texture") && !target.value.trim()) track.definitions[name][key] = null;
        else track.definitions[name][key] = target.value;
      });
      return;
    }
    if (target.dataset.definitionExtra) {
      const name = $("advDefinitionSelect").value;
      const key = target.dataset.definitionExtra;
      commit(`编辑 definition 扩展键 ${key}`, () => { track.definitions[name][key] = parseScalar(target.value); });
    }
  }

  function bindEvents() {
    $("advancedChooseAudio").onclick = () => $("advancedAudioInput").click();
    $("advancedImportPackage").onclick = () => $("advancedPackageInput").click();
    $("advNewAudio").onclick = () => $("advancedAudioInput").click();
    $("advImport").onclick = () => $("advancedPackageInput").click();
    $("advancedAudioInput").onchange = async event => {
      const file = event.target.files[0];
      event.target.value = "";
      if (file) await adapter.createBlankProject(file);
    };
    $("advancedPackageInput").onchange = async event => {
      const file = event.target.files[0];
      event.target.value = "";
      if (file) await adapter.importPackage(file);
    };
    $("advUndo").onclick = undo;
    $("advRedo").onclick = redo;
    $("advDelete").onclick = deleteSelected;
    $("advAddEvent").onclick = () => addEvent();
    $("advImportMidi").onclick = openMidiImporter;
    $("advQuantize").onclick = quantizeSelected;
    $("advZoomOut").onclick = () => zoom(0.7);
    $("advZoomIn").onclick = () => zoom(1.4);
    $("advFit").onclick = () => fitTimeline();
    $("advExport").onclick = () => adapter.exportProject($("advExport"));
    $("advGenerate").onclick = generateBetween;
    $("advPreviewCycle").onclick = previewCycle;
    $("advApplyCycle").onclick = applyCycle;
    $("advDoubleDensity").onclick = doubleDensity;
    $("advHalfDensity").onclick = halfDensity;
    $("advGenerateMode").onchange = event => {
      const count = event.target.value === "count";
      $("advGenerateValueLabel").textContent = count ? "中间个数" : "BPM";
      Object.assign($("advGenerateValue"), count ? { min: "0", step: "1", value: "1" } : { min: "0.01", step: "0.01", value: String(bpm()) });
    };
    $("advCycleAction").onchange = event => $("advCycleTypeWrap").classList.toggle("hidden", event.target.value === "delete");
    $("advPlay").onclick = async () => {
      if (!audio) return;
      if (audio.paused) {
        await audio.play();
        $("advPlay").textContent = "Ⅱ";
        startTransportAnimation();
      } else {
        audio.pause();
        $("advPlay").textContent = "▶";
        cancelAnimationFrame(animationFrame);
      }
    };
    $("advStop").onclick = () => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
      $("advPlay").textContent = "▶";
      cancelAnimationFrame(animationFrame);
      updatePlayhead();
    };
    $("advVolume").oninput = event => { if (audio) audio.volume = Number(event.target.value); };
    $("advMetronomeVolume").onchange = event => {
      if ($("metronomeVolume")) $("metronomeVolume").value = event.target.value;
    };

    document.querySelectorAll("[data-adv-inspector]").forEach(button => button.onclick = () => {
      inspectorTab = button.dataset.advInspector;
      renderInspector();
    });
    $("advInspectorContent").onclick = event => {
      if (event.target.dataset.trackUp) reorderTrack(event.target.dataset.trackUp, -1);
      else if (event.target.dataset.trackDown) reorderTrack(event.target.dataset.trackDown, 1);
      else if (event.target.dataset.trackDelete) removeTrack(event.target.dataset.trackDelete);
      else handleInspectorClick(event);
    };
    $("advInspectorContent").onchange = handleInspectorChange;
    $("advInspectorContent").onfocusout = event => {
      if (event.target.matches("#advEventTime,#advEventType,[data-prop-key],[data-prop-value],[data-track-rename],[data-project-section],#advDefinitionName,[data-definition-key],[data-definition-extra]")) {
        clearTimeout(inspectorInputTimer);
        handleInspectorChange(event);
      }
    };
    $("advInspectorContent").oninput = event => {
      if (event.target.id === "advBulkPropKey") {
        bulkPropDraft.key = event.target.value;
        return;
      }
      if (event.target.id === "advBulkPropExpression") {
        bulkPropDraft.expression = event.target.value;
        return;
      }
      if (!event.target.matches("#advEventTime")) return;
      const target = event.target;
      clearTimeout(inspectorInputTimer);
      inspectorInputTimer = setTimeout(() => handleInspectorChange({ target }), 350);
    };

    const scroll = $("advTimelineScroll");
    scroll.onscroll = () => {
      renderTimeline();
      drawWaveform();
      drawRuler();
      updatePlayhead();
    };
    scroll.onwheel = event => {
      if (event.ctrlKey) {
        event.preventDefault();
        zoom(event.deltaY < 0 ? 1.18 : 0.85, event.clientX);
      } else if (event.shiftKey) {
        event.preventDefault();
        scroll.scrollLeft += event.deltaY || event.deltaX;
      }
    };
    scroll.onpointerdown = event => {
      const eventNode = event.target.closest(".advancedEvent");
      if (eventNode) return beginDrag(event, eventNode);
      const header = event.target.closest(".advancedTrackHeader");
      if (header) {
        activeTrack = header.dataset.trackHeader;
        inspectorTab = "track";
        renderAll();
        return;
      }
      const row = event.target.closest(".advancedTrackRow");
      if (row) {
        activeTrack = row.dataset.track;
        beginMarquee(event, row);
      }
    };
    scroll.ondblclick = event => {
      if (event.target.closest(".advancedEvent,.advancedTrackHeader")) return;
      const row = event.target.closest(".advancedTrackRow");
      if (row) addEvent(row.dataset.track, pointerTime(event));
    };
    addEventListener("pointermove", event => { moveDrag(event); moveMarquee(event); });
    addEventListener("pointerup", () => { waveformScrubbing = false; endDrag(); endMarquee(); });
    document.addEventListener("keydown", handleKeyboard);
    const seekFromWaveform = event => {
      if (!audio) return;
      const canvas = $("advWaveform");
      const rect = canvas.getBoundingClientRect();
      const start = scroll.scrollLeft / pxPerMs;
      audio.currentTime = clampAudioTime(start + (event.clientX - rect.left) / pxPerMs) / 1000;
      previewBeatIndex = findCombatBeat(audio.currentTime * 1000);
      updatePlayhead();
    };
    $("advWaveform").onpointerdown = event => {
      waveformScrubbing = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      seekFromWaveform(event);
    };
    $("advWaveform").onpointermove = event => { if (waveformScrubbing) seekFromWaveform(event); };
    resizeObserver = new ResizeObserver(() => {
      if (fitMode) fitTimeline(false);
      renderAll();
    });
    resizeObserver.observe($("advTimelineScroll"));
  }

  function handleKeyboard(event) {
    const panel = $("advancedPanel");
    if (!track || !panel || panel.classList.contains("hidden") || event.defaultPrevented || event.target.closest?.("dialog[open]")) return;
    if (event.target.matches?.("input, textarea, select, [contenteditable='true']")) return;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "z") { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
    if (ctrl && event.key.toLowerCase() === "y") { event.preventDefault(); return redo(); }
    if (ctrl && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selected = new Set(timelineEvents(activeTrack).map(idFor));
      return renderAll();
    }
    if (ctrl && event.key.toLowerCase() === "c") { event.preventDefault(); return copySelected(false); }
    if (ctrl && event.key.toLowerCase() === "x") { event.preventDefault(); return copySelected(true); }
    if (ctrl && event.key.toLowerCase() === "v") { event.preventDefault(); return pasteClipboard(); }
    if (ctrl && event.key.toLowerCase() === "d") { event.preventDefault(); return duplicateSelected(); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); return deleteSelected(); }
    if (event.key === "Escape") { event.preventDefault(); return clearSelection(); }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const amount = ctrl ? 100 : event.shiftKey ? 10 : 1;
      return nudgeSelected(event.key === "ArrowLeft" ? -amount : amount);
    }
    if (event.key === "Enter") { event.preventDefault(); return addEvent(); }
    if (event.code === "Space") {
      event.preventDefault();
      $("advPlay").click();
    }
  }

  function init(nextAdapter) {
    adapter = nextAdapter;
    window.MidiImporter?.bind();
    bindEvents();
    setProject(adapter.getProject?.() || null, true);
  }

  window.AdvancedEditor = { init, setProject, activate, render: renderAll };
})();
