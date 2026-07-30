#!/usr/bin/env python3
"""Beat Track Studio local Web UI (stdlib server + existing madmom pipeline)."""

import collections
import collections.abc
import json
import os
import re
import tempfile
import time
import traceback
import sys
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

for name in ("MutableSequence", "MutableMapping", "MutableSet"):
    if not hasattr(collections, name):
        setattr(collections, name, getattr(collections.abc, name))

import numpy as np

for name, value in {
    "float": np.float64, "int": np.int64, "bool": np.bool_,
    "complex": np.complex128, "object": np.object_, "str": np.str_,
}.items():
    if name not in np.__dict__:
        setattr(np, name, value)

FROZEN = getattr(sys, "frozen", False)
ROOT = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent
DATA_ROOT = Path(getattr(sys, "_MEIPASS", ROOT))
WEB = DATA_ROOT / "webui"
UPLOAD_TEMP = ROOT / ".webui_tmp"
UPLOAD_TEMP.mkdir(exist_ok=True)


def _default_definitions(tolerance: float = .2):
    return {
        "normal_beat": {
            "can_attack": True, "color": "#9999FF", "scale": 1.0,
            "category": "normal", "haptic_intensity": 1.0, "tolerance": tolerance,
            "landing_x_percent": 56.0, "spawn_advance_ms": 1000,
            "texture": "djcraft:textures/gui/beats/blue_beat.png",
        },
        "empty_beat": {
            "can_attack": False, "color": "#BEBEBE", "scale": 1.0,
            "category": "normal", "haptic_intensity": 1.0, "tolerance": 0.0,
            "landing_x_percent": 38.0, "spawn_advance_ms": 1000,
            "texture": "djcraft:textures/gui/beats/empty_beat.png",
        },
        "weak_beat": {
            "can_attack": True, "color": "#77FFAA", "scale": .8,
            "category": "weakbeat", "haptic_intensity": .7, "tolerance": .33,
            "landing_x_percent": 44.0, "spawn_advance_ms": 700,
            "texture": "djcraft:textures/gui/beats/blue_beat.png",
        },
        "strong_beat": {
            "can_attack": True, "color": "#FFFF00", "scale": 1.2,
            "category": "downbeat", "haptic_intensity": 1.5, "tolerance": .2,
            "landing_x_percent": 62.0, "spawn_advance_ms": 1400,
            "texture": "djcraft:textures/gui/beats/green_beat.png",
        },
    }


def _multipart(body: bytes, content_type: str):
    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type)
    if not match:
        raise ValueError("无效的上传请求")
    boundary = (match.group(1) or match.group(2)).encode()
    result = {}
    for part in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in part:
            continue
        header, value = part.split(b"\r\n\r\n", 1)
        # Each MIME part is framed by one CRLF. Do not use rstrip here: it can
        # silently remove valid audio bytes that happen to equal CR/LF/'-'.
        if value.endswith(b"\r\n"):
            value = value[:-2]
        name = re.search(br'name="([^"]+)"', header)
        if not name:
            continue
        key = name.group(1).decode()
        filename = re.search(br'filename="([^"]*)"', header)
        result[key] = (filename.group(1).decode(errors="replace"), value) if filename else value.decode()
    return result


def detect(audio_path: str, filename: str, config: dict):
    start = time.time()
    engine = config.get("engine", "fast")
    if engine == "madmom":
        from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor
        # Decode with libsndfile in-process so madmom never invokes the blocked
        # external ffmpeg executable. The online LSTM is still a neural model,
        # but is dramatically faster than the three-model BLSTM ensemble here.
        try:
            import soundfile as sf
            signal, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        except Exception as exc:
            raise ValueError(f"神经网络模式无法读取此音频：{exc}") from exc
        if signal.ndim > 1:
            signal = np.mean(signal, axis=1)
        if sample_rate != 44100:
            # Lightweight linear resampling avoids another external decoder.
            old_x = np.arange(len(signal), dtype=float)
            new_len = max(1, int(len(signal) * 44100 / sample_rate))
            new_x = np.linspace(0, max(0, len(signal) - 1), new_len)
            signal = np.interp(new_x, old_x, signal).astype("float32")
            sample_rate = 44100
        activations = RNNBeatProcessor(online=True)(signal)
        beats = DBNBeatTrackingProcessor(fps=100)(activations)
        method = "madmom LSTM + DBN"
        duration = float(len(signal) / sample_rate)
    else:
        beats, bpm, duration = detect_fast(audio_path)
        method = "快速起音 + 周期跟踪"
    if not len(beats):
        raise ValueError("未检测到节拍，请尝试节奏更清晰的音频")

    intervals = np.diff(beats)
    if engine == "madmom":
        bpm = float(60 / np.median(intervals)) if len(intervals) else 120.0
    offset = int(config.get("offset", 0))
    rounding = max(0, int(config.get("rounding", 10)))
    minimum = max(0, int(config.get("minimum", 200)))

    bpm_value = float(config["bpm"]) if str(config.get("bpm", "")).strip() else float(bpm)
    duration_ms = int(config["duration_ms"]) if str(config.get("duration_ms", "")).strip() else int(duration * 1000)


    hits, last = [], -10**9
    for beat in beats:
        stamp = int(float(beat) * 1000) + offset
        if rounding > 1:
            stamp = round(stamp / rounding) * rounding
        if stamp - last < minimum:
            continue
        hits.append({"t": stamp, "type": "normal_beat"})
        last = stamp

    track = {
        "meta": {
            "version": config.get("version", "1.0"),
            "author": config.get("author", "BeatDetector"),
            "bpm": round(bpm_value, 2),
            "difficulty": config.get("difficulty", "normal"),
            "sound_file": filename,
            "offset_ms": offset,
            "playback_start_ms": max(0, int(config.get("playback_start_ms", 0))),
            "total_duration_ms": duration_ms,
            "display_name": config.get("display_name", ""),
        },
        "settings": {
            "crosshair_mode": config.get("crosshair_mode", "beat"),
            "crosshair_beat_count": int(config.get("crosshair_beat_count", 2)),
            "crosshair_time_ms": int(config.get("crosshair_time_ms", 1400)),
        },
        "definitions": _default_definitions(float(config.get("tolerance", .2))),
        "timeline": {"combat_line": hits},
    }
    return {
        "success": True, "track": track,
        "stats": {"total": len(hits), "normal": len(hits), "bpm": round(bpm, 2), "duration": duration, "density": round(len(hits)/duration, 2)},
        "processing_seconds": round(time.time()-start, 2), "method": method,
    }


def detect_fast(audio_path: str):
    """Fast onset-envelope tempo estimation without JIT or neural inference."""
    try:
        import soundfile as sf
        signal, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    except Exception as exc:
        raise ValueError(f"无法读取音频格式：{exc}") from exc
    if signal.ndim > 1:
        signal = np.mean(signal, axis=1)
    if not len(signal) or sr <= 0:
        raise ValueError("音频文件没有可分析的内容")
    duration = len(signal) / float(sr)
    hop = max(128, int(sr / 100))
    usable = len(signal) // hop * hop
    if usable < hop * 8:
        raise ValueError("音频太短，无法稳定检测节拍")
    frames = signal[:usable].reshape(-1, hop)
    energy = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    onset = np.maximum(0, np.diff(energy, prepend=energy[0]))
    onset -= np.mean(onset)
    fps = sr / hop
    min_lag = max(1, int(fps * 60 / 220))
    max_lag = min(len(onset) - 1, int(fps * 60 / 55))
    if max_lag <= min_lag:
        raise ValueError("音频太短，无法估算 BPM")
    corr = np.correlate(onset, onset, mode="full")[len(onset)-1:]
    lag = min_lag + int(np.argmax(corr[min_lag:max_lag + 1]))
    bpm = float(60 * fps / lag)
    # Anchor the regular beat grid to the strongest onset within one period.
    anchor = int(np.argmax(np.maximum(onset[:max(lag, 1)], 0)))
    beat_frames = np.arange(anchor, len(onset), lag)
    beats = beat_frames.astype(float) / fps
    return beats, bpm, duration


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def do_POST(self):
        if self.path not in ("/api/detect", "/api/convert-ogg"):
            self.send_error(404); return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 200 * 1024 * 1024:
                raise ValueError("文件超过 200 MB 限制")
            form = _multipart(self.rfile.read(length), self.headers.get("Content-Type", ""))
            filename, data = form.get("audio", ("", b""))
            if not data:
                raise ValueError("请选择音频文件")
            config = json.loads(form.get("config", "{}"))
            suffix = Path(filename).suffix or ".audio"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=UPLOAD_TEMP) as tmp:
                tmp.write(data); temp_name = tmp.name
            try:
                if self.path == "/api/convert-ogg":
                    ffmpeg = Path(sys.prefix) / "Library" / "bin" / "ffmpeg.exe"
                    if not ffmpeg.exists():
                        raise RuntimeError("便携环境中缺少 FFmpeg，无法转码 OGG")
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg", dir=UPLOAD_TEMP) as out:
                        output_name = out.name
                    try:
                        command = [str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
                                   "-i", temp_name, "-vn", "-c:a", "libvorbis", "-q:a", "5",
                                   output_name]
                        completed = subprocess.run(command, capture_output=True, text=True,
                                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        if completed.returncode != 0:
                            raise RuntimeError(f"OGG 转码失败：{completed.stderr.strip() or 'FFmpeg 未返回详细信息'}")
                        with open(output_name, "rb") as converted:
                            payload = converted.read()
                    finally:
                        os.unlink(output_name)
                else:
                    payload = detect(temp_name, Path(filename).name, config)
            finally:
                os.unlink(temp_name)
            if self.path == "/api/convert-ogg":
                self._bytes(200, payload, "audio/ogg")
            else:
                self._json(200, payload)
        except Exception as exc:
            traceback.print_exc()
            self._json(400, {"success": False, "error": str(exc)})

    def do_GET(self):
        if self.path == "/api/health":
            self._json(200, {"ok": True, "service": "Beat Track Studio"})
            return
        super().do_GET()

    def _json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def _bytes(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers(); self.wfile.write(payload)


if __name__ == "__main__":
    print("[READY] Beat Track Studio: http://127.0.0.1:8765", flush=True)
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
