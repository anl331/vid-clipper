#!/usr/bin/env python3
"""Local Video Clipper - Replaces Vugola with local processing.

Pipeline: yt-dlp download → faster-whisper transcription → OpenRouter LLM moment selection → ffmpeg clip + captions

Usage:
    python3 local_clipper.py "https://youtube.com/watch?v=..." --max-clips 5 --captions
    
API:
    from local_clipper import clip_video
    clips = clip_video(url="...", max_clips=5, captions=True, output_dir="./clips/")
"""

import sys
import os
import json
import re
import subprocess
import tempfile
import argparse
import threading
import concurrent.futures
import random

# Ensure homebrew bin is on PATH (needed when spawned from Node/Vite)
_homebrew_bin = "/opt/homebrew/bin"
if _homebrew_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _homebrew_bin + ":" + os.environ.get("PATH", "")
import logging
import time
import uuid
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# Lock for thread-safe state mutations during parallel clip/upload
_state_lock = threading.Lock()

# Global semaphore: caps total concurrent ffmpeg renders across ALL jobs.
# 4 jobs × 4 clips = 16 processes would thrash a Mac Mini.
# This keeps total renders at ≤ MAX_CONCURRENT_RENDERS regardless of job count.
MAX_CONCURRENT_RENDERS = 6
_render_semaphore = threading.Semaphore(MAX_CONCURRENT_RENDERS)

# Groq transcription semaphore: max 2 concurrent Groq API calls across all jobs.
# Prevents 429 rate-limit errors when multiple jobs run simultaneously.
_groq_semaphore = threading.Semaphore(2)

# YOLO model singleton — loaded once, reused across all render threads.
# Avoids reloading the 6MB model for every clip in every job.
_yolo_model = None
_yolo_model_lock = threading.Lock()
_yolo_infer_lock = threading.Lock()   # YOLO inference is not thread-safe; serialize calls

def _get_yolo_model():
    """Lazy-load YOLOv8n once and cache it for all threads."""
    global _yolo_model
    if _yolo_model is None:
        with _yolo_model_lock:
            if _yolo_model is None:
                try:
                    from ultralytics import YOLO as _YOLO
                    _model_path = os.path.join(SCRIPT_DIR, "yolov8n.pt")
                    _yolo_model = _YOLO(_model_path)
                except Exception:
                    _yolo_model = False  # sentinel: YOLO unavailable
    return _yolo_model if _yolo_model else None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(SCRIPT_DIR, "pipeline_state.json")
HISTORY_FILE = os.path.join(SCRIPT_DIR, "pipeline_history.json")
SETTINGS_FILE = os.path.join(SCRIPT_DIR, "settings.json")
VIDEO_CACHE_DIR = os.path.join(SCRIPT_DIR, "video_cache")
os.makedirs(VIDEO_CACHE_DIR, exist_ok=True)
VIDEO_FILE_CACHE_TTL = 86400  # 24 hours in seconds

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Use ffmpeg-full if available (has libass, drawtext support)
FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"
    FFPROBE = "ffprobe"

# ─── State Management ─────────────────────────────────────────────────────────

CONVEX_SITE_URL = os.environ.get("CONVEX_SITE_URL", "https://veracious-sardine-771.convex.site")
_convex_job_id = None  # Set when job starts, used for Convex sync

_pipeline_state = {
    "status": "idle",
    "video_url": None,
    "video_title": None,
    "error": None,
    "steps": {},
    "logs": [],
    "clips": [],
    "settings": {},
}

def _now():
    return datetime.now(timezone.utc).isoformat()

def _convex_post(path: str, payload: dict, timeout: int = 5):
    """Fire-and-forget POST to Convex HTTP action. Never raises."""
    if not _convex_job_id:
        return
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{CONVEX_SITE_URL}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=timeout)
    except Exception:
        pass  # Best-effort, don't break pipeline

def _sync_convex():
    """Push state metadata to Convex — NO logs (those are appended per-entry)."""
    payload = {
        "jobId": _convex_job_id,
        "status": _pipeline_state.get("status"),
        "steps": _pipeline_state.get("steps", {}),
        "clipsCount": len(_pipeline_state.get("clips", [])),
        "clips": [
            {"filename": c["filename"], "title": c["title"], "duration": c["duration"],
             "sizeBytes": c["size_bytes"], "path": c["path"]}
            for c in _pipeline_state.get("clips", [])
        ],
    }
    # Only include optional string fields if they have a value (Convex rejects null for v.optional(v.string()))
    for key, val in [
        ("videoTitle", _pipeline_state.get("video_title")),
        ("thumbnail", _pipeline_state.get("thumbnail")),
        ("channel", _pipeline_state.get("channel")),
        ("error", _pipeline_state.get("error")),
    ]:
        if val is not None:
            payload[key] = val
    if _pipeline_state.get("status") in ("done", "error"):
        payload["endedAt"] = _now()
    _convex_post("/api/pipeline/update", payload)

def _append_log_convex(level: str, message: str, timestamp: str):
    """Append a single log entry to Convex (small payload, fast)."""
    _convex_post("/api/pipeline/log", {
        "jobId": _convex_job_id,
        "timestamp": timestamp,
        "level": level,
        "message": message,
    })

def write_state():
    """Persist current pipeline state to disk and sync metadata to Convex."""
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(_pipeline_state, f, indent=2, default=str)
    except Exception as e:
        log.warning(f"Failed to write state: {e}")
    _sync_convex()

def state_log(level: str, message: str):
    """Append a log entry locally, sync to disk, and push log to Convex."""
    ts = _now()
    _pipeline_state["logs"].append({"timestamp": ts, "level": level, "message": message})
    # Write local state file
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(_pipeline_state, f, indent=2, default=str)
    except Exception:
        pass
    # Push log to Convex (tiny payload — just one entry)
    _append_log_convex(level, message, ts)

def begin_step(step_name: str):
    _pipeline_state["status"] = step_name
    _pipeline_state["steps"][step_name] = {"started_at": _now(), "ended_at": None, "status": "active"}
    state_log("INFO", f"Step started: {step_name}")
    _sync_convex()  # Push step state — state_log only pushes the log entry

def end_step(step_name: str, status: str = "done"):
    if step_name in _pipeline_state["steps"]:
        _pipeline_state["steps"][step_name]["ended_at"] = _now()
        _pipeline_state["steps"][step_name]["status"] = status
    state_log("INFO", f"Step finished: {step_name} ({status})")
    _sync_convex()  # Push step state — state_log only pushes the log entry

def reset_state(url: str):
    """Reset state for a new job."""
    _pipeline_state.update({
        "status": "idle",
        "video_url": url,
        "video_title": None,
        "error": None,
        "steps": {},
        "logs": [],
        "clips": [],
    })
    # Load settings
    try:
        with open(SETTINGS_FILE) as f:
            _pipeline_state["settings"] = json.load(f)
    except:
        _pipeline_state["settings"] = {}
    write_state()
    # Note: Convex job is created by the Vite /api/run handler (with oEmbed metadata).
    # Python only syncs updates via _sync_convex().

def append_history(job_id: str, clips_count: int):
    """Append completed job to history."""
    entry = {
        "id": job_id,
        "video_url": _pipeline_state.get("video_url", ""),
        "video_title": _pipeline_state.get("video_title", ""),
        "thumbnail": _pipeline_state.get("thumbnail"),
        "channel": _pipeline_state.get("channel"),
        "status": _pipeline_state.get("status", "done"),
        "started_at": _pipeline_state["steps"].get("downloading", {}).get("started_at"),
        "ended_at": _now(),
        "model": _pipeline_state.get("settings", {}).get("model", "unknown"),
        "clips_count": clips_count,
        "clips": _pipeline_state.get("clips", []),
        "steps": _pipeline_state.get("steps", {}),
        "logs": _pipeline_state.get("logs", []),
    }
    history = []
    try:
        with open(HISTORY_FILE) as f:
            history = json.load(f)
    except:
        pass
    history.append(entry)
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2, default=str)

# ─── Load Settings ─────────────────────────────────────────────────────────────

def load_settings():
    """Load settings from settings.json."""
    defaults = {
        "model": "google/gemini-2.0-flash-001",
        "max_clips": 5,
        "min_duration": 20,
        "max_duration": 90,
        "openrouter_api_key": "",
    }
    try:
        with open(SETTINGS_FILE) as f:
            s = json.load(f)
            defaults.update(s)
    except:
        pass
    return defaults


def _get_cookie_args(url: str = "") -> list[str]:
    """Return cookie/auth args for yt-dlp.
    
    Priority:
    1. Per-platform cookies file (e.g. youtube_cookies.txt, tiktok_cookies.txt)
    2. Generic cookies.txt
    3. Nothing — impersonation handles most public content without cookies
    """
    import re
    platform = "generic"
    if "youtube.com" in url or "youtu.be" in url:
        platform = "youtube"
    elif "tiktok.com" in url:
        platform = "tiktok"
    elif "instagram.com" in url:
        platform = "instagram"
    elif "twitter.com" in url or "x.com" in url:
        platform = "twitter"

    base = os.path.dirname(__file__)
    for fname in [f"{platform}_cookies.txt", "cookies.txt"]:
        path = os.path.join(base, fname)
        if os.path.exists(path):
            return ["--cookies", path]
    return []  # rely on impersonation


def _extract_video_id(url: str) -> Optional[str]:
    """Extract YouTube video ID from URL. Returns None for non-YouTube URLs."""
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([A-Za-z0-9_-]{11})',
    ]
    for pattern in patterns:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return None


def _load_video_cache(video_id: str) -> Optional[dict]:
    """Load cached analysis for a video ID. Returns None if not cached."""
    cache_path = os.path.join(VIDEO_CACHE_DIR, f"{video_id}.json")
    if not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, "r") as f:
            data = json.load(f)
        if "segments" in data and "moments" in data:
            return data
    except Exception:
        pass
    return None


def _save_video_cache(video_id: str, data: dict) -> None:
    """Save analysis results to cache."""
    cache_path = os.path.join(VIDEO_CACHE_DIR, f"{video_id}.json")
    try:
        with open(cache_path, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as _e:
        state_log("WARNING", f"Failed to save video cache: {_e}")


def _get_cached_video_path(video_id: str) -> Optional[str]:
    """Return path to cached video file if it exists and is < 24h old. Else None."""
    path = os.path.join(VIDEO_CACHE_DIR, f"{video_id}.mp4")
    if not os.path.exists(path):
        return None
    age = time.time() - os.path.getmtime(path)
    if age > VIDEO_FILE_CACHE_TTL:
        try:
            os.remove(path)
            state_log("INFO", f"🗑️ Expired video cache removed for {video_id}")
        except Exception:
            pass
        return None
    return path


def _cleanup_expired_video_cache() -> None:
    """Remove all expired .mp4 files from video_cache/."""
    try:
        for fname in os.listdir(VIDEO_CACHE_DIR):
            if not fname.endswith(".mp4"):
                continue
            fpath = os.path.join(VIDEO_CACHE_DIR, fname)
            age = time.time() - os.path.getmtime(fpath)
            if age > VIDEO_FILE_CACHE_TTL:
                os.remove(fpath)
                state_log("INFO", f"🗑️ Cleaned up expired video cache: {fname}")
    except Exception:
        pass


def download_audio_only(url: str, output_dir: str) -> Optional[str]:
    """Download audio-only stream. Much faster than full video (~3-5s for a 1hr video).
    Used to start transcription while video download runs in parallel."""
    output_path = os.path.join(output_dir, "audio_only.%(ext)s")
    cmd = [
        "yt-dlp",
        "--impersonate", "chrome-120",
        *_get_cookie_args(url),
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "-o", output_path,
        "--no-playlist",
        "--retries", "2",
        "--concurrent-fragments", "8",
    ]
    result = subprocess.run(cmd + [url], capture_output=True, text=True)
    if result.returncode != 0:
        # Retry without impersonation
        cmd2 = ["yt-dlp", *_get_cookie_args(url), "-f", "bestaudio[ext=m4a]/bestaudio",
                "-o", output_path, "--no-playlist", url]
        result = subprocess.run(cmd2, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    for f in sorted(Path(output_dir).glob("audio_only*"), key=lambda x: x.stat().st_size, reverse=True):
        if f.suffix in ('.m4a', '.mp3', '.webm', '.ogg', '.opus'):
            return str(f)
    return None


def download_video(url: str, output_dir: str) -> Optional[str]:
    """Download video with yt-dlp. Returns path to downloaded file.
    
    Uses browser impersonation as default — no Chrome required, works on servers.
    Falls back to stored cookies if a platform cookies file exists.
    """
    output_path = os.path.join(output_dir, "source.%(ext)s")
    base_cmd = [
        "yt-dlp",
        "--impersonate", "chrome-120",
        *_get_cookie_args(url),
        # 720p max — 2-3x smaller than 1080p, still crisp after our crop+scale to 1080×1920.
        # Prefer mp4 for seekability; fall back to any 720p or best available.
        "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "-o", output_path,
        "--no-playlist",
        "--retries", "3",
        "--fragment-retries", "3",
        "--concurrent-fragments", "8",  # parallel fragment downloads (DASH/HLS)
    ]

    state_log("INFO", f"Downloading: {url}")

    # First attempt: impersonation
    cmd = base_cmd + [url]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Second attempt: try without impersonation (some sites block impersonated UA)
        state_log("WARNING", "Impersonation failed, retrying without impersonation flag...")
        cmd2 = [
            "yt-dlp",
            *_get_cookie_args(url),
            "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best",
            "--merge-output-format", "mp4",
            "-o", output_path, "--no-playlist", "--retries", "2",
            "--concurrent-fragments", "8", url
        ]
        result = subprocess.run(cmd2, capture_output=True, text=True)

    if result.returncode != 0:
        state_log("ERROR", f"Download failed: {result.stderr[-300:]}")
        return None
    
    # Find the downloaded file
    for f in sorted(Path(output_dir).glob("source*"), key=lambda x: x.stat().st_size, reverse=True):
        if f.suffix in ('.mp4', '.mkv', '.webm'):
            state_log("INFO", f"Downloaded: {f.name} ({f.stat().st_size / 1024 / 1024:.1f} MB)")
            return str(f)
    return None


def transcribe_groq(video_path: str, api_key: str) -> list[dict]:
    """Transcribe video with Groq Whisper API. Fast cloud transcription with word timestamps."""
    from groq import Groq
    
    state_log("INFO", "Transcribing with Groq Whisper (cloud)...")
    
    # Extract audio to a temp file (Groq has 25MB limit, so we extract audio only).
    # Use AudioToolbox AAC (hardware encoder on Mac) for speed; m4a is accepted by Groq.
    # Fallback to libmp3lame if aac_at isn't available.
    _base = os.path.splitext(video_path)[0]
    audio_path = _base + "_groq.m4a"
    extract = subprocess.run([
        FFMPEG, "-y", "-i", video_path, "-vn",
        "-acodec", "aac_at",   # AudioToolbox hardware AAC
        "-b:a", "64k", "-ar", "16000", "-ac", "1",
        audio_path
    ], capture_output=True, text=True)

    if extract.returncode != 0:
        # aac_at unavailable — fall back to software libmp3lame
        audio_path = audio_path.replace(".m4a", ".mp3")
        extract = subprocess.run([
            FFMPEG, "-y", "-i", video_path, "-vn",
            "-acodec", "libmp3lame", "-ab", "64k", "-ar", "16000", "-ac", "1",
            audio_path
        ], capture_output=True, text=True)

    if extract.returncode != 0:
        state_log("ERROR", f"Audio extraction failed: {extract.stderr[-200:]}")
        raise RuntimeError("Audio extraction failed")
    
    audio_size = os.path.getsize(audio_path) / (1024 * 1024)
    state_log("INFO", f"Audio extracted: {audio_size:.1f}MB")
    
    # If audio > 25MB, need to chunk it (Groq limit)
    if audio_size > 24:
        state_log("WARNING", f"Audio too large for Groq ({audio_size:.1f}MB > 25MB), falling back to local Whisper")
        os.remove(audio_path)
        return transcribe_local(video_path)
    
    client = Groq(api_key=api_key)
    audio_filename = os.path.basename(audio_path)

    # Acquire global Groq semaphore — max 2 concurrent transcription calls across all jobs.
    # On 429, retry with exponential backoff (up to 3 attempts) before falling back to local.
    transcription = None
    with _groq_semaphore:
        for attempt in range(3):
            try:
                with open(audio_path, "rb") as f:
                    transcription = client.audio.transcriptions.create(
                        file=(audio_filename, f),
                        model="whisper-large-v3-turbo",
                        response_format="verbose_json",
                        timestamp_granularities=["word", "segment"],
                        language="en"
                    )
                break  # success
            except Exception as e:
                err_str = str(e)
                if "429" in err_str and attempt < 2:
                    wait = 15 * (attempt + 1)  # 15s, 30s
                    state_log("WARNING", f"Groq rate limit hit — retrying in {wait}s (attempt {attempt+1}/3)...")
                    time.sleep(wait)
                else:
                    os.remove(audio_path)
                    raise

    os.remove(audio_path)

    if transcription is None:
        raise RuntimeError("Groq transcription failed after retries")
    
    # Parse into our format
    full_segments = []
    words = []
    
    if hasattr(transcription, 'segments') and transcription.segments:
        for seg in transcription.segments:
            seg_data = {
                "start": seg.get("start", seg.get("start", 0)),
                "end": seg.get("end", seg.get("end", 0)),
                "text": seg.get("text", "").strip(),
                "words": []
            }
            full_segments.append(seg_data)
    
    if hasattr(transcription, 'words') and transcription.words:
        for w in transcription.words:
            word_data = {"word": w.get("word", "").strip(), "start": w.get("start", 0), "end": w.get("end", 0)}
            words.append(word_data)
            # Assign words to segments
            for seg in full_segments:
                if seg["start"] <= word_data["start"] <= seg["end"]:
                    seg["words"].append(word_data)
                    break
    
    duration = full_segments[-1]["end"] if full_segments else 0
    state_log("INFO", f"Groq transcribed {len(full_segments)} segments, {len(words)} words, duration {duration:.0f}s")
    return full_segments


def transcribe_local(video_path: str) -> list[dict]:
    """Transcribe video with faster-whisper locally. Returns word-level segments."""
    from faster_whisper import WhisperModel
    
    state_log("INFO", "Loading local whisper model (small)...")
    model = WhisperModel("small", device="cpu", compute_type="int8")
    
    segments, info = model.transcribe(video_path, word_timestamps=True, language="en")
    
    words = []
    full_segments = []
    for segment in segments:
        seg_data = {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "words": []
        }
        if segment.words:
            for w in segment.words:
                word_data = {"word": w.word.strip(), "start": w.start, "end": w.end}
                words.append(word_data)
                seg_data["words"].append(word_data)
        full_segments.append(seg_data)
    
    state_log("INFO", f"Transcribed {len(full_segments)} segments, {len(words)} words, duration {info.duration:.0f}s")
    return full_segments


def transcribe(video_path: str) -> list[dict]:
    """Transcribe video using local faster-whisper (no API key required).
    
    Set transcription_provider=groq in settings.json + groq_api_key to use
    Groq's cloud Whisper instead (faster for long videos).
    """
    settings = load_settings()
    provider = settings.get("transcription_provider", "local")
    groq_key = settings.get("groq_api_key", "") or os.environ.get("GROQ_API_KEY", "")

    if provider == "groq" and groq_key:
        try:
            return transcribe_groq(video_path, groq_key)
        except Exception as e:
            state_log("WARNING", f"Groq failed ({e}), falling back to local Whisper")

    return transcribe_local(video_path)


def _filter_low_density_segments(segments: list[dict], min_wpm: float = 80.0) -> list[dict]:
    """Remove transcript segments with very low word density (silence, music, ads).
    
    Uses a sliding window approach — computes WPM for each segment and drops
    segments where surrounding context is too sparse.
    Returns filtered segment list. Never returns empty list (falls back to original).
    """
    if not segments:
        return segments
    
    filtered = []
    for seg in segments:
        duration = seg.get("end", 0) - seg.get("start", 0)
        if duration <= 0:
            filtered.append(seg)
            continue
        words = len(seg.get("text", "").split())
        wpm = (words / duration) * 60.0
        if wpm >= min_wpm or words >= 3:  # always keep segments with at least 3 words
            filtered.append(seg)
    
    # Safety: never return less than 50% of original
    if len(filtered) < len(segments) * 0.5:
        return segments
    return filtered if filtered else segments


def get_audio_energy_peaks(video_path: str, interval: int = 10) -> list[dict]:
    """Sample audio RMS energy every N seconds. Returns list of {time, energy, is_peak}.
    
    Used to enrich transcript context with audio energy markers for text-only LLM fallback.
    """
    import struct
    try:
        cmd = [
            FFPROBE, "-f", "lavfi", "-i",
            f"amovie={video_path},astats=metadata=1:reset=1",
            "-show_entries", "frame_tags=lavfi.astats.Overall.RMS_level",
            "-of", "csv=p=0", "-v", "quiet"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            return []
        
        lines = [l.strip() for l in result.stdout.strip().split('\n') if l.strip()]
        if not lines:
            return []
        
        # Parse RMS levels (in dB, negative values). Sample every `interval` frames.
        # ffprobe outputs one line per audio frame (~1024 samples at common rates).
        # At 44.1kHz that's ~43 frames/sec. We'll bucket by time.
        energies = []
        for i, line in enumerate(lines):
            try:
                val = float(line)
                # Approximate time: assume ~43 frames/sec for 44.1kHz
                t = i / 43.0
                energies.append({"time": t, "energy": val})
            except (ValueError, IndexError):
                continue
        
        if not energies:
            return []
        
        # Bucket into intervals and find peaks
        import statistics
        max_time = energies[-1]["time"]
        buckets = []
        for bucket_start in range(0, int(max_time) + 1, interval):
            bucket_vals = [e["energy"] for e in energies 
                          if bucket_start <= e["time"] < bucket_start + interval]
            if bucket_vals:
                avg = statistics.mean(bucket_vals)
                buckets.append({"time": bucket_start, "energy": avg, "is_peak": False})
        
        if len(buckets) < 3:
            return buckets
        
        all_energies = [b["energy"] for b in buckets]
        mean_e = statistics.mean(all_energies)
        std_e = statistics.stdev(all_energies) if len(all_energies) > 1 else 0
        threshold = mean_e + 1.5 * std_e
        
        for b in buckets:
            if b["energy"] >= threshold:
                b["is_peak"] = True
        
        return buckets
    except Exception as e:
        state_log("WARNING", f"Audio energy analysis failed: {e}")
        return []


def _enrich_transcript_with_energy(transcript_lines: list[str], energy_peaks: list[dict]) -> list[str]:
    """Insert [AUDIO PEAK] markers into transcript lines at peak timestamps."""
    if not energy_peaks:
        return transcript_lines
    
    peak_times = {p["time"] for p in energy_peaks if p.get("is_peak")}
    if not peak_times:
        return transcript_lines
    
    enriched = []
    peak_times_sorted = sorted(peak_times)
    peak_idx = 0
    
    for line in transcript_lines:
        # Extract timestamp from line like "[12:34] text..."
        match = re.match(r'\[(\d+):(\d+)\]', line)
        if match:
            line_time = int(match.group(1)) * 60 + int(match.group(2))
            # Insert any peaks that fall before this line
            while peak_idx < len(peak_times_sorted) and peak_times_sorted[peak_idx] <= line_time:
                pt = peak_times_sorted[peak_idx]
                m, s = divmod(int(pt), 60)
                enriched.append(f"[AUDIO PEAK at {m:02d}:{s:02d} - high energy/excitement]")
                peak_idx += 1
        enriched.append(line)
    
    # Append remaining peaks
    while peak_idx < len(peak_times_sorted):
        pt = peak_times_sorted[peak_idx]
        m, s = divmod(int(pt), 60)
        enriched.append(f"[AUDIO PEAK at {m:02d}:{s:02d} - high energy/excitement]")
        peak_idx += 1
    
    return enriched


def find_viral_moments_openrouter(segments: list[dict], max_clips: int = 5,
                                    min_duration: int = 45, max_duration: int = 90,
                                    model: str = "google/gemini-2.0-flash-001",
                                    api_key: str = "",
                                    video_path: str = "") -> list[dict]:
    """Use OpenRouter to identify viral moments from transcript.
    
    For Gemini models: no transcript truncation (1M token context).
    For other models: chunks transcript into overlapping 40K windows and deduplicates.
    If video_path is provided, enriches transcript with audio energy peaks.
    """
    FREE_MODEL = "google/gemini-2.0-flash-exp:free"
    if not api_key:
        api_key = "no-key"
        model = FREE_MODEL
        state_log("INFO", f"No OpenRouter API key — using free model ({FREE_MODEL}). Set openrouter_api_key in settings for paid models.")

    from openai import OpenAI

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
    )

    # Build transcript with timestamps
    transcript_lines = []
    for seg in segments:
        m, s = divmod(int(seg["start"]), 60)
        transcript_lines.append(f"[{m:02d}:{s:02d}] {seg['text']}")

    # Enrich with audio energy peaks for text-only analysis
    if video_path and os.path.exists(video_path):
        state_log("INFO", "Analyzing audio energy peaks...")
        energy_peaks = get_audio_energy_peaks(video_path)
        peak_count = sum(1 for p in energy_peaks if p.get("is_peak"))
        if peak_count > 0:
            state_log("INFO", f"🔊 Found {peak_count} audio energy peaks")
            transcript_lines = _enrich_transcript_with_energy(transcript_lines, energy_peaks)

    transcript = "\n".join(transcript_lines)

    is_gemini_model = "gemini" in model.lower()

    if is_gemini_model:
        # Gemini handles 1M tokens — no truncation needed
        pass
    elif len(transcript) > 40000:
        # Non-Gemini models: chunk into overlapping windows
        state_log("INFO", f"Transcript {len(transcript)} chars — chunking for {model}")
        _vd = max((s.get("end", 0) for s in segments), default=0)
        return _chunked_openrouter_analysis(client, model, transcript, segments,
                                             max_clips, min_duration, max_duration, api_key, video_duration=_vd)

    video_duration = max((s.get("end", 0) for s in segments), default=0)
    prompt = _build_moment_prompt(transcript, max_clips, min_duration, max_duration, video_duration=video_duration)

    try:
        state_log("INFO", f"Calling OpenRouter ({model})...")
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
        text = response.choices[0].message.content.strip()
        moments, content_type = _parse_moments(text, max_clips)
        moments = _enforce_duration_limits(moments, min_duration, max_duration)
        moments = _score_hooks(moments, segments, api_key, model)
        state_log("INFO", f"LLM identified {len(moments)} viral moments after hook scoring (min={min_duration}s, max={max_duration}s)")
        return moments, content_type
    except Exception as e:
        state_log("ERROR", f"OpenRouter call failed: {e}")
        return find_viral_moments_fallback(segments, max_clips, min_duration, max_duration)


def _chunked_openrouter_analysis(client, model: str, transcript: str, segments: list[dict],
                                  max_clips: int, min_duration: int, max_duration: int,
                                  api_key: str, video_duration: float = 0.0) -> tuple[list[dict], str]:
    """For non-Gemini models: chunk transcript into overlapping 40K windows,
    run LLM on each, collect candidates, then dedup/rank to pick the best N."""
    chunk_size = 40000
    overlap = 5000
    chunks = []
    pos = 0
    while pos < len(transcript):
        end = min(pos + chunk_size, len(transcript))
        chunks.append(transcript[pos:end])
        if end >= len(transcript):
            break
        pos = end - overlap

    state_log("INFO", f"Split transcript into {len(chunks)} overlapping chunks for {model}")

    all_candidates = []
    content_types = []
    for i, chunk in enumerate(chunks):
        prompt = _build_moment_prompt(chunk, max_clips, min_duration, max_duration, video_duration=video_duration)
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
            )
            text = response.choices[0].message.content.strip()
            moments, ct = _parse_moments(text, max_clips)
            all_candidates.extend(moments)
            content_types.append(ct)
            state_log("INFO", f"Chunk {i+1}/{len(chunks)}: found {len(moments)} candidates")
        except Exception as e:
            state_log("WARNING", f"Chunk {i+1} failed: {e}")

    if not all_candidates:
        return find_viral_moments_fallback(segments, max_clips, min_duration, max_duration)

    # Dedup: merge overlapping candidates (within 30s of each other), keep higher hook_score
    all_candidates.sort(key=lambda m: float(m.get("start", 0)))
    deduped = [all_candidates[0]]
    for m in all_candidates[1:]:
        if abs(float(m["start"]) - float(deduped[-1]["start"])) < 30:
            if m.get("hook_score", 5) > deduped[-1].get("hook_score", 5):
                deduped[-1] = m
        else:
            deduped.append(m)

    # Rank by hook_score and take top N
    deduped.sort(key=lambda m: m.get("hook_score", 5), reverse=True)
    moments = deduped[:max_clips]
    moments.sort(key=lambda m: float(m["start"]))

    # Most common content type
    from collections import Counter
    content_type = Counter(content_types).most_common(1)[0][0] if content_types else "other"

    moments = _enforce_duration_limits(moments, min_duration, max_duration)
    moments = _score_hooks(moments, segments, api_key, model)
    state_log("INFO", f"Chunked analysis: {len(moments)} moments from {len(all_candidates)} candidates")
    return moments, content_type


def find_viral_moments_gemini_video(segments: list[dict], max_clips: int = 5,
                                     min_duration: int = 45, max_duration: int = 90,
                                     video_path: str = "",
                                     model_name: str = "") -> tuple[list[dict], str]:
    """Use Gemini Flash with native video upload to identify viral moments.
    
    Uploads the video file to Gemini Files API so the model can watch audio+visuals.
    Falls back to text-only analysis if upload fails or video is too large.
    """
    settings = load_settings()
    api_key = settings.get("gemini_api_key", "") or GEMINI_API_KEY
    if not api_key:
        state_log("WARNING", "No Gemini API key, falling back to simple splitting")
        return find_viral_moments_fallback(segments, max_clips, min_duration, max_duration)

    # Size check — Gemini Files API limit is 2GB
    if video_path and os.path.exists(video_path):
        file_size_gb = os.path.getsize(video_path) / (1024**3)
        if file_size_gb > 1.8:
            state_log("WARNING", f"Video too large for Gemini ({file_size_gb:.1f}GB), falling back to transcript")
            return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)
    else:
        # No video file — use text-only
        return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)

    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)

        state_log("INFO", f"Uploading video to Gemini Files API ({file_size_gb:.1f}GB)...")
        video_file = genai.upload_file(path=video_path, mime_type="video/mp4")

        # Wait for processing
        wait_start = time.time()
        while video_file.state.name == "PROCESSING":
            if time.time() - wait_start > 600:  # 10 min timeout
                state_log("WARNING", "Gemini file processing timeout (10min), falling back to transcript")
                try:
                    genai.delete_file(video_file.name)
                except Exception:
                    pass
                return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)
            time.sleep(5)
            video_file = genai.get_file(video_file.name)

        if video_file.state.name == "FAILED":
            state_log("WARNING", "Gemini file processing failed, falling back to transcript")
            try:
                genai.delete_file(video_file.name)
            except Exception:
                pass
            return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)

        state_log("INFO", "Video processed by Gemini, analyzing...")

        # Build video-aware prompt
        transcript_lines = []
        for seg in segments:
            m, s = divmod(int(seg["start"]), 60)
            transcript_lines.append(f"[{m:02d}:{s:02d}] {seg['text']}")
        transcript = "\n".join(transcript_lines)

        _vid_duration_hint = max((s.get("end", 0) for s in segments), default=0)
        video_prompt = f"""You are a viral short-form content editor. Watch the full video including audio and visuals.

Pay attention to: exciting visual moments, strong reactions, music/energy peaks, on-screen action — not just what's said.

{_build_moment_prompt(transcript, max_clips, min_duration, max_duration, video_duration=_vid_duration_hint)}"""

        _genai_model_name = (model_name.split("/")[-1] if model_name else None) or "gemini-2.0-flash"
        model = genai.GenerativeModel(
            _genai_model_name,
            generation_config=genai.GenerationConfig(response_mime_type="application/json")
        )
        state_log("INFO", f"🤖 Gemini model: {_genai_model_name} (timeout: 5min)")
        response = model.generate_content(
            [video_file, video_prompt],
            request_options={"timeout": 300},
        )
        text = response.text.strip()

        # Clean up uploaded file
        try:
            genai.delete_file(video_file.name)
            state_log("INFO", "Cleaned up Gemini uploaded file")
        except Exception:
            pass

        moments, content_type = _parse_moments(text, max_clips)
        moments = _enforce_duration_limits(moments, min_duration, max_duration)
        moments = _score_hooks(moments, segments, "", "")
        state_log("INFO", f"Gemini Video identified {len(moments)} viral moments (min={min_duration}s, max={max_duration}s)")
        return moments, content_type

    except Exception as e:
        state_log("WARNING", f"Gemini video analysis failed ({e}), falling back to transcript")
        return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)


def find_viral_moments_gemini_text(segments: list[dict], max_clips: int = 5,
                                    min_duration: int = 45, max_duration: int = 90,
                                    model_name: str = "") -> tuple[list[dict], str]:
    """Use Gemini Flash to identify viral moments from transcript text only (no video upload)."""
    import google.generativeai as genai
    
    settings = load_settings()
    api_key = settings.get("gemini_api_key", "") or GEMINI_API_KEY
    if not api_key:
        state_log("WARNING", "No Gemini API key, falling back to simple splitting")
        return find_viral_moments_fallback(segments, max_clips, min_duration, max_duration)
    
    genai.configure(api_key=api_key)
    
    # Build transcript with timestamps — no truncation for Gemini (1M token context)
    transcript_lines = []
    for seg in segments:
        m, s = divmod(int(seg["start"]), 60)
        transcript_lines.append(f"[{m:02d}:{s:02d}] {seg['text']}")
    transcript = "\n".join(transcript_lines)
    
    video_duration = max((s.get("end", 0) for s in segments), default=0)
    prompt = _build_moment_prompt(transcript, max_clips, min_duration, max_duration, video_duration=video_duration)
    _txt_model_name = (model_name.split("/")[-1] if model_name else None) or "gemini-2.0-flash"
    state_log("INFO", f"🤖 Gemini text model: {_txt_model_name}")

    try:
        model = genai.GenerativeModel(
            _txt_model_name,
            generation_config=genai.GenerationConfig(response_mime_type="application/json")
        )
        response = model.generate_content(prompt, request_options={"timeout": 120})
        text = response.text.strip()
        moments, content_type = _parse_moments(text, max_clips)
        moments = _enforce_duration_limits(moments, min_duration, max_duration)
        moments = _score_hooks(moments, segments, "", "")
        state_log("INFO", f"Gemini (text) identified {len(moments)} viral moments after hook scoring (min={min_duration}s, max={max_duration}s)")
        return moments, content_type
    except Exception as e:
        state_log("ERROR", f"Gemini text failed ({_txt_model_name}): {e}")
        if _txt_model_name != "gemini-2.0-flash":
            state_log("INFO", "Retrying with gemini-2.0-flash fallback...")
            return find_viral_moments_gemini_text(segments, max_clips, min_duration, max_duration)
        return find_viral_moments_fallback(segments, max_clips, min_duration, max_duration)


def _build_moment_prompt(transcript: str, max_clips: int, min_duration: int, max_duration: int, video_duration: float = 0.0) -> str:
    return f"""You are a viral short-form content editor. Analyze the transcript and identify the content type and the best clips.

Identify the content type as one of: interview, educational, rant, podcast, other. Return it as "content_type" in the top-level JSON object.

THE #1 RULE: Every clip must tell a COMPLETE STORY. The viewer must understand what's happening without any other context. A clip should have a beginning, middle, and end. Never cut mid-thought or mid-explanation.

IDEAL CLIP STRUCTURE (45-90 seconds):
- HOOK (first 3-5 sec): Something that grabs attention immediately
- BODY: The actual content/explanation/story
- PAYOFF: A conclusion, result, or punchline

WHAT MAKES A GREAT CLIP:
1. Full story arcs: clear setup → development → payoff
2. Strategy/knowledge explanations with clear before/after
3. Strong opinions/hot takes: "Everyone is wrong about X, here's why..."
4. Lessons from real experience: "I used to do X, here's what I learned"
5. Predictions with reasoning: "I think X will happen because Y and Z"
6. Emotional moments with substance: rage, excitement, disbelief — but WITH context

WHAT MAKES A BAD CLIP (NEVER select these):
- Random 10-second snippets with no context
- Starting or ending mid-sentence
- Off-topic chat, bathroom breaks, technical issues, silence
- Greetings, intros, "hey guys welcome back"
- Clips that require watching the rest of the video to understand

DURATION RULES:
- MINIMUM {min_duration} seconds. Try hard to find segments this long.
- TARGET 45-75 seconds (TikTok sweet spot)
- MAXIMUM {max_duration} seconds
- Pad 2-3 seconds before the speaker starts and after they finish
- If a great moment is slightly under {min_duration}s, extend it by including surrounding context to hit the minimum.
{f"- VIDEO LENGTH: {video_duration:.0f}s ({video_duration/60:.0f} min). ALL start/end values MUST be below {video_duration:.0f}s — never hallucinate past the end." if video_duration > 0 else ""}

Return JSON object with "content_type" and "clips" keys. No markdown fences. Just JSON.

CRITICAL: "start" and "end" MUST be numbers in SECONDS (e.g., 56.0, 173.5). NOT timestamps like "00:56" or "01:04". Convert mm:ss to seconds yourself.

Also include "hook_score" (1-10) and "hook_reason" for the opening 5 seconds of each clip:
- 8-10: Specific claim, shocking number, strong opinion, "here's what I did" — stops scrollers cold
- 5-7: Decent setup but generic or needs context
- 1-4: Filler, greeting, mid-sentence, boring opener

Also include "peak_offset": seconds from the clip's start time to the single most compelling SPOKEN moment inside the clip — where the person says something shocking, controversial, emotional, or highly relatable. This 6-second snippet will be prepended as a teaser hook before the full clip plays. Requirements: (1) The person MUST be actively speaking — no silent pauses, no B-roll, no ambient noise. (2) Pick a moment where the spoken words alone would make someone stop scrolling — a bold claim, a surprising reveal, a strong opinion, a relatable frustration, or an emotional high point. (3) The offset must have at least 6 seconds of content remaining before the clip ends. Must be a number in seconds (e.g. 32.5). Set to null if no standout speech moment exists.

{{"content_type": "rant", "clips": [
  {{"start": 56.0, "end": 120.0, "title": "Short punchy title", "reason": "Why this works", "hook_score": 8, "hook_reason": "Opens with a shocking claim", "peak_offset": 38.0}},
  {{"start": 200.0, "end": 265.0, "title": "Another title", "reason": "Why this works", "hook_score": 6, "hook_reason": "Good setup but slightly generic", "peak_offset": null}}
]}}

IMPORTANT: You MUST return EXACTLY {max_clips} clips if the video has enough content. Spread the clips across the ENTIRE video (beginning, middle, and end). Do not cluster all clips at the start. Each clip must be from a different section of the video. No overlapping clips. If the video is too short for {max_clips} non-overlapping clips that meet the duration rules, return as many as genuinely fit (minimum 1).

TRANSCRIPT:
{transcript}"""


def _parse_moments(text: str, max_clips: int) -> tuple[list[dict], str]:
    """Parse LLM response into moments list and content_type.
    
    Returns (moments, content_type) where content_type defaults to "other".
    """
    content_type = "other"
    # Try to extract JSON
    # First try as JSON object with "clips" key
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "clips" in data:
            content_type = data.get("content_type", "other")
            moments = data["clips"]
        elif isinstance(data, list):
            moments = data
        else:
            moments = data
    except json.JSONDecodeError:
        match = re.search(r'\[.*\]', text, re.DOTALL)
        raw = match.group() if match else text
        raw = raw.replace("'", '"')
        raw = re.sub(r',\s*}', '}', raw)
        raw = re.sub(r',\s*\]', ']', raw)
        try:
            moments = json.loads(raw)
        except json.JSONDecodeError:
            raw2 = re.sub(r'```json?\s*', '', raw)
            raw2 = re.sub(r'```', '', raw2)
            moments = json.loads(raw2)

    # Validate content_type
    if content_type not in ("interview", "educational", "rant", "podcast", "other"):
        content_type = "other"

    # Fix any mm:ss timestamps
    for m in moments:
        for key in ("start", "end"):
            val = m.get(key)
            if isinstance(val, str) and ":" in val:
                parts = val.replace(".", ":").split(":")
                secs = int(parts[0]) * 60 + float(parts[1])
                m[key] = secs
            elif isinstance(val, str):
                m[key] = float(val)

    return moments[:max_clips], content_type


def _enforce_duration_limits(moments: list[dict], min_duration: int, max_duration: int) -> list[dict]:
    """Hard-enforce min/max duration on LLM-returned moments.
    
    - Clips longer than max_duration: hard-clamp the end.
    - Clips slightly under min_duration (>=70% of min): extend end to reach min.
    - Clips way too short (<70% of min): likely a bad timestamp — drop them.
    """
    valid = []
    drop_threshold = min_duration * 0.4  # only drop if <40% of min — clearly broken timestamps
    for m in moments:
        start = float(m.get("start", 0))
        end = float(m.get("end", 0))
        duration = end - start

        if duration <= 0:
            state_log("WARNING", f"Dropping clip '{m.get('title','')}' — invalid duration {duration:.0f}s")
            continue

        if duration > max_duration:
            m["end"] = start + max_duration
            state_log("INFO", f"Clamped '{m.get('title','')}' {duration:.0f}s → {max_duration}s")
            valid.append(m)
        elif duration < min_duration:
            if duration < drop_threshold:
                state_log("WARNING", f"Dropped '{m.get('title','')}' — {duration:.0f}s is too short (min={min_duration}s, drop threshold={drop_threshold:.0f}s)")
            else:
                # Close to min — extend end by the deficit
                m["end"] = end + (min_duration - duration)
                state_log("INFO", f"Extended '{m.get('title','')}' {duration:.0f}s → {min_duration}s")
                valid.append(m)
        else:
            valid.append(m)

    return valid


def _score_hooks(moments: list[dict], segments: list[dict], api_key: str, model: str) -> list[dict]:
    """Score the hook quality (first 8s) of each moment.

    If the main LLM already returned hook_score fields, just log them — no extra API call.
    Falls back to a separate batch LLM call only if scores are missing.
    """
    if not moments:
        return moments

    # ── Fast path: scores already embedded in the main response ──────────────
    already_scored = all("hook_score" in m for m in moments)
    if already_scored:
        for i, m in enumerate(moments):
            score = m.get("hook_score", 7)
            reason = m.get("hook_reason", "")
            level = "✅" if score >= 7 else "⚠️" if score >= 5 else "🪝"
            state_log("INFO", f"{level} Hook {i+1} score {score}/10: {m.get('title','?')} — {reason}")
        return moments

    # ── Slow path: make a separate API call (legacy / fallback) ──────────────
    if not api_key:
        return moments

    # Extract opening transcript for each moment
    hooks = []
    for i, m in enumerate(moments):
        hook_end = m["start"] + 8
        hook_words = [s["text"] for s in segments if s["start"] >= m["start"] - 0.5 and s["end"] <= hook_end + 0.5]
        hook_text = " ".join(hook_words).strip() or "[no transcript in this window]"
        hooks.append({"index": i, "title": m.get("title", f"clip_{i+1}"), "hook": hook_text})

    prompt = f"""You are scoring opening hooks for viral TikTok trading clips.

Score each hook from 1-10 on how likely it is to stop someone mid-scroll.

HIGH SCORE (8-10): Specific claim, shocking number, strong opinion, "here's what I did" story opener
MID SCORE (5-7): Decent setup but generic, needs context, or vague  
LOW SCORE (1-4): Boring opener, filler words, greetings, "in today's video...", mid-sentence confusion

Return ONLY a JSON array (no markdown): [{{"index": 0, "score": 7, "reason": "brief reason"}}, ...]

Hooks to score:
{json.dumps(hooks, indent=2)}"""

    try:
        from openai import OpenAI
        client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
        # Wrap in object since we requested json_object mode
        raw = response.choices[0].message.content.strip()
        # json_object mode returns an object — extract array
        data = json.loads(raw)
        scores = data if isinstance(data, list) else data.get("scores", data.get("hooks", []))
        
        score_map = {item["index"]: item for item in scores}
        for i, m in enumerate(moments):
            entry = score_map.get(i, {})
            score = entry.get("score", 7)
            reason = entry.get("reason", "")
            m["hook_score"] = score
            # Annotate only — never drop based on hook score.
            # Weak hooks are logged as info so you can see quality, but all clips render.
            level = "✅" if score >= 7 else "⚠️" if score >= 5 else "🪝"
            state_log("INFO", f"{level} Hook {i+1} score {score}/10: {m.get('title','?')} — {reason}")
        return moments
    except Exception as e:
        state_log("WARNING", f"Hook scoring failed ({e}), keeping all moments")
        return moments


def find_viral_moments_fallback(segments: list[dict], max_clips: int = 5,
                                 min_duration: int = 45, max_duration: int = 90) -> tuple[list[dict], str]:
    """Simple fallback: split transcript into even chunks. Returns (moments, content_type)."""
    if not segments:
        return [], "other"
    
    total_duration = segments[-1]["end"]
    clip_duration = min(max_duration, max(min_duration, total_duration / max_clips))
    
    moments = []
    current = 0
    while current < total_duration and len(moments) < max_clips:
        end = min(current + clip_duration, total_duration)
        text = " ".join(s["text"] for s in segments if s["start"] >= current and s["end"] <= end)
        moments.append({
            "start": current,
            "end": end,
            "title": f"Clip {len(moments) + 1}",
            "reason": "Auto-split",
            "hook_score": 7
        })
        current = end + 2
    
    return moments, "other"


def get_video_dimensions(video_path: str) -> tuple[int, int]:
    """Get video width and height."""
    cmd = [FFPROBE, "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "json", video_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    return stream["width"], stream["height"]


def pick_keyword_index(words_in_chunk: list[str]) -> int:
    """Pick the most important word in a chunk to highlight.
    Prefers longer words, trading terms, and numbers."""
    trading_terms = {"trading", "trade", "trades", "market", "nasdaq", "spy", "es",
                     "divergence", "sweep", "liquidity", "support", "resistance",
                     "breakout", "breakdown", "profit", "profits", "loss", "losses",
                     "bullish", "bearish", "long", "short", "entry", "exit",
                     "setup", "pattern", "candle", "trend", "reversal", "volume",
                     "high", "low", "level", "zone", "price", "target", "stop",
                     "risk", "reward", "confluence", "session", "london", "new york",
                     "asia", "ict", "smt", "fvg", "order block", "imbalance"}
    best_idx = 0
    best_score = 0
    for i, w in enumerate(words_in_chunk):
        score = len(w)
        if w.lower() in trading_terms:
            score += 20
        if any(c.isdigit() for c in w):
            score += 15
        if w[0].isupper() if w else False:
            score += 3
        if score > best_score:
            best_score = score
            best_idx = i
    return best_idx


# Font path for captions
FONTS_DIR = os.path.join(os.path.dirname(__file__), "fonts")
CAPTION_FONT = os.path.join(FONTS_DIR, "Montserrat-ExtraBold.ttf")


def _hex_to_ass_bgr(hex_color: str) -> str:
    """Convert #RRGGBB hex color to ASS &HBBGGRR& format."""
    h = hex_color.lstrip('#')
    if len(h) != 6:
        return "&H00FFFF&"  # fallback yellow
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{b}{g}{r}&"


def _wrap_title(text: str, max_chars: int = 16) -> str:
    """Split title into 1-2 lines at a word boundary near the midpoint."""
    text = text.upper().strip()
    if len(text) <= max_chars:
        return text
    words = text.split()
    best_split = 1
    best_diff = float("inf")
    for i in range(1, len(words)):
        line1 = " ".join(words[:i])
        line2 = " ".join(words[i:])
        diff = abs(len(line1) - len(line2))
        if diff < best_diff:
            best_diff = diff
            best_split = i
    line1 = " ".join(words[:best_split])
    line2 = " ".join(words[best_split:])
    return f"{line1}\\N{line2}"


def generate_ass_captions(
    words: list[dict],
    start_offset: float,
    title: str = "",
    clip_duration: float = 0,
    caption_font_size: int = 78,
    caption_margin_v: int = 350,
    caption_chunk_size: int = 3,
    caption_highlight: bool = True,
    caption_highlight_color: str = "#ffff00",
    title_font_size: int = 78,
    title_margin_v: int = 200,
    caption_font: str = "Montserrat ExtraBold",
    title_font: str = "Montserrat ExtraBold",
    title_intro_duration: float = 3.5,
    title_position: str = "intro",  # "intro" | "top"
    clip_number: int = 0,
    total_clips: int = 0,
) -> str:
    """Generate ASS subtitle content for TikTok-style captions.

    title_position:
      "intro" — title fades in at the caption zone (bottom) for title_intro_duration
                seconds, then captions take over.
      "top"   — title is pinned at the top for the full clip duration (classic overlay).
    """

    def fmt(t):
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        cs = int((t % 1) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    ass_header = f"""[Script Info]
Title: Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{caption_font},{caption_font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,40,40,{caption_margin_v},1
Style: Title,{title_font},{title_font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,40,40,{caption_margin_v},1
Style: TitleTop,{title_font},{title_font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,8,60,60,{title_margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []

    caption_start_after = 0.0

    if title:
        title_text = _wrap_title(title)

        if title_position == "top":
            # ── Static top overlay — pinned for full clip duration ─────────
            title_end = clip_duration + 1 if clip_duration > 0 else 9999
            events.append(f"Dialogue: 0,{fmt(0)},{fmt(title_end)},TitleTop,,0,0,0,,{title_text}")

        else:
            # ── Intro mode — fades in at bottom, then captions take over ───
            if title_intro_duration > 0:
                # No fade-in — title is visible from frame 1, fades out as captions take over
                title_event = f"{{\\fad(0,350)}}{title_text}"
                events.append(f"Dialogue: 0,{fmt(0)},{fmt(title_intro_duration)},Title,,0,0,0,,{title_event}")
                caption_start_after = title_intro_duration

    # ── Caption chunks ─────────────────────────────────────────────────────
    chunk_size = caption_chunk_size
    for i in range(0, len(words), chunk_size):
        chunk = words[i:i + chunk_size]
        if not chunk:
            break
        chunk_start = max(0, chunk[0]["start"] - start_offset)
        chunk_end   = chunk[-1]["end"] - start_offset

        # Skip chunks that finish during the title intro
        if chunk_end <= caption_start_after:
            continue
        # Delay chunks that start during the title intro
        if chunk_start < caption_start_after:
            chunk_start = caption_start_after

        chunk_words = [w["word"].upper() for w in chunk]

        parts = []
        if caption_highlight:
            kw_idx = pick_keyword_index(chunk_words)
            for j, cw in enumerate(chunk_words):
                if j == kw_idx:
                    ass_color = _hex_to_ass_bgr(caption_highlight_color)
                    parts.append("{\\c" + ass_color + "}" + cw + "{\\c&HFFFFFF&}")
                else:
                    parts.append(cw)
        else:
            parts = list(chunk_words)
        text = " ".join(parts)

        events.append(f"Dialogue: 0,{fmt(chunk_start)},{fmt(chunk_end)},Default,,0,0,0,,{text}")

    return ass_header + "\n".join(events) + "\n"


def detect_face_x_offset(video_path: str, start: float, end: float,
                          sample_interval: float = 3.0) -> Optional[float]:
    """Sample frames from [start, end] and detect the main subject's position.

    Detection order:
      1. YOLO (YOLOv8n) — person detection; most robust for varied poses/angles
      2. MediaPipe FaceDetector — good for close-up faces
      3. OpenCV Haar cascade — last resort frontal faces

    Returns normalized x center (0.0=left, 0.5=center, 1.0=right), or None.
    """
    # Adaptive sample interval: spread at most 8 frames across the clip duration.
    # Avoids scanning 20+ frames for long clips — face position is stable after 5-8 samples.
    MAX_SCAN_FRAMES = 8
    clip_duration = max(1.0, end - start)
    sample_interval = max(sample_interval, clip_duration / MAX_SCAN_FRAMES)

    def _sample_frames(cap, start, end, interval):
        """Generator: (timestamp, frame) pairs sampled every `interval` seconds."""
        t = start
        while t < end:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ret, frame = cap.read()
            if not ret:
                break
            yield t, frame
            t += interval

    # ── 1. YOLO person detection ──────────────────────────────────────────────
    try:
        import cv2
        import numpy as _np

        _yolo = _get_yolo_model()
        if _yolo is None:
            raise ImportError("YOLO unavailable")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError("Cannot open video for YOLO scan")

        person_centers: list[float] = []
        frames_sampled = 0
        for _t, frame in _sample_frames(cap, start, end, sample_interval):
            frames_sampled += 1
            fw = frame.shape[1]
            with _yolo_infer_lock:
                results = _yolo(frame, classes=[0], verbose=False)  # class 0 = person
            boxes = results[0].boxes
            if boxes is not None and len(boxes) > 0:
                areas = (boxes.xywh[:, 2] * boxes.xywh[:, 3]).cpu().numpy()
                largest_idx = int(_np.argmax(areas))
                cx_abs = float(boxes.xywh[largest_idx, 0].cpu().numpy())
                cx = max(0.0, min(1.0, cx_abs / fw))
                person_centers.append(cx)
        cap.release()

        if person_centers:
            # Use the first detection — opening frame sets viewer expectation
            first_x = person_centers[0]
            direction = "left" if first_x < 0.4 else "right" if first_x > 0.6 else "center"
            state_log("INFO",
                      f"🎯 Smart crop (YOLO): person in {len(person_centers)}/{frames_sampled} frames "
                      f"— x={first_x:.2f} ({direction})")
            return first_x
        else:
            state_log("INFO",
                      f"🎯 Smart crop (YOLO): no person found in {frames_sampled} frames — trying MediaPipe")

    except ImportError:
        state_log("INFO", "🎯 Smart crop: YOLO not available, trying MediaPipe")
    except Exception as _e:
        state_log("INFO", f"🎯 Smart crop: YOLO error ({_e}), trying MediaPipe")

    # ── 2. MediaPipe FaceDetector fallback ────────────────────────────────────
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as _mp_py
        from mediapipe.tasks.python import vision as _mp_vision
        import cv2
        import numpy as _np

        _model_path = os.path.join(SCRIPT_DIR, "blaze_face_short_range.tflite")
        _base_opts  = _mp_py.BaseOptions(model_asset_path=_model_path)
        _options    = _mp_vision.FaceDetectorOptions(
            base_options=_base_opts, min_detection_confidence=0.25
        )
        _detector   = _mp_vision.FaceDetector.create_from_options(_options)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return None

        face_centers: list[float] = []
        frames_sampled = 0
        for _t, frame in _sample_frames(cap, start, end, sample_interval):
            frames_sampled += 1
            fw = frame.shape[1]
            rgb    = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = _detector.detect(mp_img)
            if result.detections:
                largest = max(result.detections,
                              key=lambda d: d.bounding_box.width * d.bounding_box.height)
                bb = largest.bounding_box
                cx = max(0.0, min(1.0, (bb.origin_x + bb.width / 2) / fw))
                face_centers.append(cx)

        cap.release()
        _detector.close()

        if face_centers:
            median_x = float(_np.median(face_centers))
            direction = "left" if median_x < 0.4 else "right" if median_x > 0.6 else "center"
            state_log("INFO",
                      f"🎯 Smart crop (MediaPipe): face in {len(face_centers)}/{frames_sampled} frames "
                      f"— x={median_x:.2f} ({direction})")
            return median_x
        else:
            state_log("INFO", f"🎯 Smart crop (MediaPipe): no face in {frames_sampled} frames — trying Haar")

    except ImportError:
        pass
    except Exception:
        pass

    # ── 3. Haar cascade last resort ───────────────────────────────────────────
    try:
        import cv2
        import numpy as _np

        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(cascade_path)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return None

        face_centers: list[float] = []
        for _t, frame in _sample_frames(cap, start, end, sample_interval):
            gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
            )
            if len(faces) > 0:
                largest = max(faces, key=lambda f: f[2] * f[3])
                x, y, w, h = largest
                face_centers.append((x + w / 2) / frame.shape[1])

        cap.release()
        if face_centers:
            median_x = float(_np.median(face_centers))
            state_log("INFO", f"🎯 Smart crop (Haar): face at x={median_x:.2f}")
            return median_x
        return None

    except Exception:
        return None  # All detectors failed — caller falls back to center crop


def detect_face_bbox(video_path: str, start: float, end: float) -> Optional[tuple]:
    """Detect the primary face/person bounding box for tight split-panel zoom.

    Returns (x, y, w, h) in PIXELS relative to the source video dimensions,
    with generous padding applied. Returns None if no face detected.

    Uses YOLO first, then MediaPipe as fallback.
    """
    MAX_SCAN_FRAMES = 8
    clip_duration = max(1.0, end - start)
    sample_interval = max(3.0, clip_duration / MAX_SCAN_FRAMES)

    try:
        import cv2
        import numpy as _np

        _yolo = _get_yolo_model()
        if _yolo is None:
            raise ImportError("YOLO unavailable")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError("Cannot open video")

        vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        bboxes: list[tuple] = []
        frames_sampled = 0

        t = start
        while t < end:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ret, frame = cap.read()
            if not ret:
                break
            frames_sampled += 1
            with _yolo_infer_lock:
                results = _yolo(frame, classes=[0], verbose=False)
            boxes = results[0].boxes
            if boxes is not None and len(boxes) > 0:
                areas = (boxes.xywh[:, 2] * boxes.xywh[:, 3]).cpu().numpy()
                largest_idx = int(_np.argmax(areas))
                bx, by, bw, bh = [float(v) for v in boxes.xywh[largest_idx].cpu().numpy()]
                # xywh is center_x, center_y, w, h — convert to top-left
                bboxes.append((bx - bw/2, by - bh/2, bw, bh))
            t += sample_interval
        cap.release()

        if not bboxes:
            raise ValueError("No person detected")

        # Use the FIRST valid detection's position — the opening frame is what
        # hooks the viewer. If the webcam moves later, that's the source video's
        # layout, not something we can fix with a static crop.
        xs, ys, ws, hs = bboxes[0]

        # For talking-head clips the face/shoulders occupy the top ~70% of the YOLO person bbox.
        # Use only that region — avoids showing too much torso below.
        face_h = hs * 0.80       # top 80% of person bbox = head + neck + shoulders
        pad_x = ws * 0.06        # 6% each side horizontally
        pad_y_top = face_h * 0.04  # small room above head
        pad_y_bot = face_h * 0.10  # some room below shoulders
        cx = xs + ws / 2
        cy = ys + face_h / 2    # center on face region (top of bbox + half face height)
        new_w = ws + pad_x * 2
        new_h = face_h + pad_y_top + pad_y_bot

        # Enforce minimum size (at least 10% of video width) to avoid over-zooming tiny detections
        new_w = max(new_w, vid_w * 0.10)
        new_h = max(new_h, vid_h * 0.10)

        # If the detected region is > 75% of the frame, the person is full-screen
        # (e.g. a large body bbox in a whole-screen recording). No useful tight zoom possible.
        if new_w > vid_w * 0.75 or new_h > vid_h * 0.75:
            raise ValueError(f"Person too large for tight zoom ({new_w:.0f}x{new_h:.0f}), using x-only fallback")

        # Cap to video dimensions before computing final coords
        new_w = min(new_w, float(vid_w))
        new_h = min(new_h, float(vid_h))

        # Clamp center so crop fits inside video
        cx = max(new_w / 2, min(vid_w - new_w / 2, cx))
        cy = max(new_h / 2, min(vid_h - new_h / 2, cy))

        x0 = max(0, int(cx - new_w / 2))
        y0 = max(0, int(cy - new_h / 2))
        cw = min(int(new_w), vid_w - x0)
        ch = min(int(new_h), vid_h - y0)
        # Make even
        cw = (cw // 2) * 2
        ch = (ch // 2) * 2

        if cw < 50 or ch < 50:
            raise ValueError(f"Crop too small ({cw}x{ch}), skipping")

        state_log("INFO", f"🎯 Face bbox: crop={cw}x{ch} at ({x0},{y0}) in {vid_w}x{vid_h} source")
        return (x0, y0, cw, ch)

    except Exception as _e:
        state_log("INFO", f"🎯 Face bbox detection failed ({_e}), using x-only crop")
        return None


def detect_face_trajectory(video_path: str, start_time: float, end_time: float,
                           num_keyframes: int = 12) -> list[dict]:
    """Sample keyframes across [start_time, end_time] and detect person bbox at each.

    Returns list of dicts: [{t, x, y, w, h}, ...] where x/y/w/h may be None if no detection.
    All coordinates are in source pixels.
    """
    import cv2
    import numpy as np

    _yolo = _get_yolo_model()
    if _yolo is None:
        return []

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    duration = max(0.1, end_time - start_time)
    step = duration / max(1, num_keyframes - 1)
    keyframes = []

    for i in range(num_keyframes):
        t = start_time + i * step
        if t > end_time:
            t = end_time
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ret, frame = cap.read()
        kf = {"t": t, "x": None, "y": None, "w": None, "h": None}
        if ret:
            with _yolo_infer_lock:
                results = _yolo(frame, classes=[0], verbose=False)
            boxes = results[0].boxes
            if boxes is not None and len(boxes) > 0:
                areas = (boxes.xywh[:, 2] * boxes.xywh[:, 3]).cpu().numpy()
                largest_idx = int(np.argmax(areas))
                cx, cy, bw, bh = [float(v) for v in boxes.xywh[largest_idx].cpu().numpy()]
                kf["x"] = int(cx)
                kf["y"] = int(cy)
                kf["w"] = int(bw)
                kf["h"] = int(bh)
        keyframes.append(kf)

    cap.release()
    return keyframes


def smooth_face_trajectory(keyframes: list[dict], frame_w: int, frame_h: int) -> list[dict] | None:
    """Interpolate missing detections, smooth with moving average, clamp to bounds.

    Returns smoothed keyframe list, or None if fewer than 2 valid detections.
    """
    import numpy as np

    # Count valid keyframes
    valid_indices = [i for i, kf in enumerate(keyframes) if kf["x"] is not None]
    if len(valid_indices) < 2:
        return None

    # Interpolate None values for x and y
    result = [dict(kf) for kf in keyframes]  # deep copy
    for field in ("x", "y"):
        vals = [kf[field] for kf in result]
        # Forward-fill from first valid
        first_valid = valid_indices[0]
        last_valid = valid_indices[-1]
        # Fill before first valid
        for i in range(first_valid):
            vals[i] = vals[first_valid]
        # Fill after last valid
        for i in range(last_valid + 1, len(vals)):
            vals[i] = vals[last_valid]
        # Linear interpolate between valid points
        for j in range(len(valid_indices) - 1):
            a, b = valid_indices[j], valid_indices[j + 1]
            if b - a > 1:
                va, vb = vals[a], vals[b]
                for k in range(a + 1, b):
                    frac = (k - a) / (b - a)
                    vals[k] = int(va + (vb - va) * frac)
        for i, v in enumerate(vals):
            result[i][field] = v

    # Also fill w/h (use nearest valid)
    for field in ("w", "h"):
        vals = [kf[field] for kf in result]
        for i in range(len(vals)):
            if vals[i] is None:
                # Find nearest valid
                nearest = min(valid_indices, key=lambda vi: abs(vi - i))
                vals[i] = keyframes[nearest][field]
        for i, v in enumerate(vals):
            result[i][field] = v

    # Moving average smoothing (window=3) on x and y
    for field in ("x", "y"):
        vals = np.array([kf[field] for kf in result], dtype=float)
        smoothed = np.convolve(vals, np.ones(3) / 3, mode="same")
        # Fix edges (convolve pads with zeros)
        smoothed[0] = (vals[0] + vals[1]) / 2
        smoothed[-1] = (vals[-2] + vals[-1]) / 2
        for i in range(len(result)):
            result[i][field] = int(np.clip(smoothed[i], 0, frame_w - 1 if field == "x" else frame_h - 1))

    return result


def write_crop_sendcmd(trajectory: list[dict], crop_w: int, crop_h: int,
                       frame_w: int, output_path: str,
                       frame_h: int = 0, animate_y: bool = False) -> str:
    """Write an ffmpeg sendcmd file for animated crop position (x and optionally y).

    Returns the path to the written file.
    """
    t0 = trajectory[0]["t"]
    lines = []
    for kf in trajectory:
        t_rel = kf["t"] - t0
        face_cx = kf["x"]  # center x in source pixels
        crop_x = max(0, min(frame_w - crop_w, face_cx - crop_w // 2))
        crop_x = (crop_x // 2) * 2  # keep even
        lines.append(f"{t_rel:.3f} crop x {crop_x};")
        if animate_y and kf.get("y") is not None and frame_h > 0:
            face_cy = kf["y"]
            crop_y = max(0, min(frame_h - crop_h, face_cy - crop_h // 2))
            crop_y = (crop_y // 2) * 2  # keep even
            lines.append(f"{t_rel:.3f} crop y {crop_y};")
    with open(output_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return output_path


def cut_clip(video_path: str, start: float, end: float, output_path: str,
             captions: bool = True, words: list[dict] = None, title: str = "",
             caption_font_size: int = 78, caption_margin_v: int = 350,
             caption_chunk_size: int = 3, caption_highlight: bool = True,
             caption_highlight_color: str = "#ffff00",
             title_font_size: int = 78, title_margin_v: int = 200,
             caption_font: str = "Montserrat ExtraBold", title_font: str = "Montserrat ExtraBold",
             clip_format: str = "fullscreen",
             title_intro_duration: float = 3.5,
             title_position: str = "intro",
             clip_number: int = 0,
             total_clips: int = 0,
             crop_anchor: str = "center") -> Optional[str]:
    """Cut a clip from video, optionally add captions and title overlay, convert to vertical.
    
    clip_format:
      "fullscreen" — blurred background fill (existing default)
      "split"      — top 1/3 = full horizontal letterboxed, bottom 2/3 = center zoom
    """
    
    width, height = get_video_dimensions(video_path)
    is_landscape = width > height
    clip_duration = end - start

    # ── Crop anchor: fixed offset or auto face-detection ─────────────────────
    # face_x: normalized 0→1 (0=left, 0.5=center, 1=right); None = default center
    _ANCHOR_X = {"left": 0.2, "right": 0.8, "center": None, "auto": None}
    face_x: Optional[float] = _ANCHOR_X.get(crop_anchor)

    face_bbox: Optional[tuple] = None
    if is_landscape and clip_format in ("center", "split"):
        if crop_anchor == "auto":
            state_log("INFO", f"🎯 Crop: auto-detecting face for {start:.1f}s–{end:.1f}s...")
            face_x = detect_face_x_offset(video_path, start, end)
            if clip_format == "split":
                try:
                    face_bbox = detect_face_bbox(video_path, start, end)
                except Exception as _bbox_err:
                    state_log("INFO", f"🎯 Face bbox detection failed: {_bbox_err}")
        elif crop_anchor in ("left", "right"):
            state_log("INFO", f"🎯 Crop anchor: {crop_anchor} (x={face_x})")

    ass_file = None
    if captions and (words or title):
        clip_words = [w for w in (words or []) if w["start"] >= start - 0.5 and w["end"] <= end + 0.5]
        if clip_words or title:
            import hashlib as _hl
            ass_file = f"/tmp/clipper_{_hl.md5(output_path.encode()).hexdigest()[:8]}.ass"
            with open(ass_file, "w") as f:
                f.write(generate_ass_captions(
                    clip_words, start, title=title, clip_duration=clip_duration,
                    caption_font_size=caption_font_size, caption_margin_v=caption_margin_v,
                    caption_chunk_size=caption_chunk_size, caption_highlight=caption_highlight,
                    caption_highlight_color=caption_highlight_color,
                    title_font_size=title_font_size, title_margin_v=title_margin_v,
                    caption_font=caption_font, title_font=title_font,
                    title_intro_duration=title_intro_duration,
                    title_position=title_position,
                    clip_number=clip_number,
                    total_clips=total_clips,
                ))

    # ── CENTER FORMAT ─────────────────────────────────────────────────────────
    # Pure center-crop zoom: grab the center 9:16 strip and scale to fill 1080×1920.
    # No blurred bg, no split — just a tight zoomed-in center of the source video.
    if clip_format == "center" and is_landscape:
        # Compute crop width (even number for libx264)
        _crop_w = (int(height * 9 / 16) // 2) * 2
        if face_x is not None:
            # Shift crop window to keep speaker centered; clamp to valid range
            _cx = max(0, min(width - _crop_w, int(face_x * width - _crop_w / 2)))
            _cx = (_cx // 2) * 2  # keep even
            _center_crop = f"crop={_crop_w}:ih:{_cx}:0,scale=1080:1920"
        else:
            _center_crop = f"crop={_crop_w}:ih,scale=1080:1920"  # default: center

        if ass_file:
            esc = ass_file.replace(":", "\\:")
            fontsdir = FONTS_DIR.replace(':', '\\:')
            vf = (
                f"[0:v]{_center_crop}[base];"
                f"[base]ass={esc}:fontsdir={fontsdir}[out]"
            )
        else:
            vf = f"[0:v]{_center_crop}[out]"
        cmd = [
            FFMPEG, "-y",
            "-ss", str(start),
            "-to", str(end),
            "-i", video_path,
            "-filter_complex", vf,
            "-map", "[out]",
            "-map", "0:a?",
            "-c:v", "h264_videotoolbox", "-b:v", "3500k", "-maxrate", "4500k", "-allow_sw", "1",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path
        ]

    # ── SPLIT FORMAT ──────────────────────────────────────────────────────────
    # Top 1/3  (640px): full horizontal video, letterboxed with black bars
    # Bottom 2/3 (1280px): same video, center-cropped and zoomed to fill
    # Canvas: 1080 × 1920 — same as fullscreen so ASS captions work unchanged
    elif clip_format == "split" and is_landscape:
        # Bottom 2/3 — tight face zoom (bbox) or face-shifted x crop (fallback)
        if face_bbox is not None:
            _fb_x, _fb_y, _fb_w, _fb_h = face_bbox
            state_log("INFO", f"🎯 Split bottom: tight zoom crop={_fb_w}x{_fb_h} at ({_fb_x},{_fb_y})")
            _bot_crop = (f"[vb]crop={_fb_w}:{_fb_h}:{_fb_x}:{_fb_y},"
                         f"scale=1080:1280:force_original_aspect_ratio=increase,"
                         f"crop=1080:1280[bot]")
        elif face_x is not None:
            _scaled_w = (int(width * 1280 / height) // 2) * 2
            _bot_x = max(0, min(_scaled_w - 1080, int(face_x * _scaled_w - 540)))
            _bot_x = (_bot_x // 2) * 2
            state_log("INFO", f"🎯 Split bottom: x-shift crop at bot_x={_bot_x}")
            _bot_crop = f"[vb]scale=-2:1280,crop=1080:1280:{_bot_x}:0[bot]"
        else:
            state_log("INFO", f"🎯 Split bottom: center crop (no face detected)")
            _bot_crop = "[vb]scale=-2:1280,crop=1080:1280[bot]"

        if ass_file:
            esc = ass_file.replace(":", "\\:")
            fontsdir = FONTS_DIR.replace(':', '\\:')
            vf = (
                "[0:v]split=2[vt][vb];"
                "[vt]scale=1080:-2,pad=1080:640:(ow-iw)/2:(oh-ih)/2:black[top];"
                f"{_bot_crop};"
                f"[top][bot]vstack[base];"
                f"[base]ass={esc}:fontsdir={fontsdir}[out]"
            )
        else:
            vf = (
                "[0:v]split=2[vt][vb];"
                "[vt]scale=1080:-2,pad=1080:640:(ow-iw)/2:(oh-ih)/2:black[top];"
                f"{_bot_crop};"
                "[top][bot]vstack[out]"
            )
        cmd = [
            FFMPEG, "-y",
            "-ss", str(start),
            "-to", str(end),
            "-i", video_path,
            "-filter_complex", vf,
            "-map", "[out]",
            "-map", "0:a?",
            "-c:v", "h264_videotoolbox", "-b:v", "3500k", "-maxrate", "4500k", "-allow_sw", "1",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path
        ]

    # ── FULLSCREEN FORMAT (default) ───────────────────────────────────────────
    elif is_landscape:
        vf = (
            "[0:v]split[bg][fg];"
            "[bg]crop=ih*9/16:ih,scale=1080:1920,boxblur=20:20[bgout];"
            "[fg]scale=1080:-2:force_original_aspect_ratio=decrease[fgout];"
            "[bgout][fgout]overlay=(W-w)/2:(H-h)/2"
        )
        if ass_file:
            esc = ass_file.replace(":", "\\:")
            fontsdir = FONTS_DIR.replace(':', '\\:')
            vf += f",ass={esc}:fontsdir={fontsdir}"
        vf += "[out]"
        
        cmd = [
            FFMPEG, "-y",
            "-ss", str(start),
            "-to", str(end),
            "-i", video_path,
            "-filter_complex", vf,
            "-map", "[out]",
            "-map", "0:a?",
            "-c:v", "h264_videotoolbox", "-b:v", "3500k", "-maxrate", "4500k", "-allow_sw", "1",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path
        ]
    else:
        vf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
        if ass_file:
            esc = ass_file.replace(":", "\\:")
            fontsdir = FONTS_DIR.replace(':', '\\:')
            vf += f",ass={esc}:fontsdir={fontsdir}"
        
        cmd = [
            FFMPEG, "-y",
            "-ss", str(start),
            "-to", str(end),
            "-i", video_path,
            "-vf", vf,
            "-c:v", "h264_videotoolbox", "-b:v", "3500k", "-maxrate", "4500k", "-allow_sw", "1",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output_path
        ]
    
    state_log("INFO", f"Cutting clip: {start:.1f}s - {end:.1f}s → {Path(output_path).name}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if ass_file and os.path.exists(ass_file):
        os.remove(ass_file)
    
    if result.returncode != 0:
        state_log("ERROR", f"ffmpeg failed: {result.stderr[-300:]}")
        return None
    
    if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
        size_mb = os.path.getsize(output_path) / 1024 / 1024
        state_log("INFO", f"Clip saved: {Path(output_path).name} ({size_mb:.1f} MB)")
        return output_path
    return None


def clip_video(url: str, max_clips: int = 5, min_duration: int = 45,
               max_duration: int = 90, captions: bool = True,
               output_dir: str = "./clips/",
               reanalyze: bool = False,
               model_override: str = "") -> list[str]:
    """Main pipeline: download → transcribe → find moments → cut clips.

    reanalyze=True: use cached transcript but re-run LLM analysis (ignores cached moments).
    model_override: if set, use this model for LLM analysis instead of settings.json.
    Returns list of output clip file paths.
    """
    job_id = str(uuid.uuid4())[:8]
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Clean up any expired video cache files
    _cleanup_expired_video_cache()

    # Clean up old per-job state files (older than 24 hours)
    try:
        for f in Path(SCRIPT_DIR).glob("pipeline_state_*.json"):
            if time.time() - f.stat().st_mtime > 86400:
                f.unlink()
    except Exception:
        pass

    # Load settings
    settings = load_settings()
    caption_font_size = settings.get("caption_font_size", 78)
    caption_margin_v = settings.get("caption_margin_v", 350)
    caption_chunk_size = settings.get("caption_chunk_size", 3)
    caption_highlight = settings.get("caption_highlight", True)
    caption_highlight_color = settings.get("caption_highlight_color", "#ffff00")
    title_enabled = settings.get("title_enabled", True)
    title_font_size = settings.get("title_font_size", 78)
    title_margin_v = settings.get("title_margin_v", 200)
    caption_font = settings.get("caption_font", "Montserrat ExtraBold")
    title_font = settings.get("title_font", "Montserrat ExtraBold")
    clip_format = settings.get("clip_format", "fullscreen")
    title_intro_duration = float(settings.get("title_intro_duration", 3.5))
    title_position = settings.get("title_position", "intro")
    crop_anchor = settings.get("crop_anchor", "center")  # "left"|"center"|"right"|"auto"
    teaser_enabled = settings.get("teaser_enabled", True)

    # Reset state
    reset_state(url)
    _pipeline_state["settings"] = settings

    # Fetch metadata early (before download) so error jobs still have title/thumbnail
    try:
        vid_match = re.search(r'(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})', url)
        vid_id = vid_match.group(1) if vid_match else None
        oembed_url = f"https://www.youtube.com/oembed?url={urllib.parse.quote(url, safe='')}&format=json"
        with urllib.request.urlopen(oembed_url, timeout=5) as resp:
            oembed = json.loads(resp.read())
            _pipeline_state["video_title"] = oembed.get("title", "")
            _pipeline_state["channel"] = oembed.get("author_name", "")
            _pipeline_state["thumbnail"] = f"https://i.ytimg.com/vi/{vid_id}/maxresdefault.jpg" if vid_id else oembed.get("thumbnail_url", "")
            write_state()
    except:
        pass

    # ── Video cache check ─────────────────────────────────────────────────────
    _video_id = _extract_video_id(url)
    _cache_hit = False
    _reanalyze_pending = False  # True when reanalyze=True and cache has transcript
    moments: list = []          # always defined; set by cache or LLM analysis
    segments: list = []
    all_words: list = []
    content_type = "educational"

    _cached_data = _load_video_cache(_video_id) if _video_id else None
    if _cached_data:
        if reanalyze and _cached_data.get("segments"):
            # Partial cache hit — use cached transcript, re-run LLM fresh
            _cache_hit = True          # reuse video-download shortcut
            _reanalyze_pending = True  # but still need to call LLM
            segments = _cached_data["segments"]
            all_words = [w for seg in segments for w in seg.get("words", [])]
            content_type = _cached_data.get("content_type", "educational")
            _model_label = model_override or "(settings default)"
            state_log("INFO", f"🔄 Re-analyze mode — cached transcript loaded ({len(segments)} segments), LLM model: {_model_label}")
        else:
            state_log("INFO", f"📦 Cache hit for video {_video_id} — skipping download/transcription/analysis")
            _cache_hit = True
            segments = _cached_data["segments"]
            all_words = []
            for _seg in segments:
                all_words.extend(_seg.get("words", []))
            moments = _cached_data["moments"]
            content_type = _cached_data.get("content_type", "educational")
        if not _pipeline_state.get("video_title") and _cached_data.get("video_title"):
            _pipeline_state["video_title"] = _cached_data["video_title"]
        if not _pipeline_state.get("thumbnail") and _cached_data.get("thumbnail_url"):
            _pipeline_state["thumbnail"] = _cached_data["thumbnail_url"]
    
    with tempfile.TemporaryDirectory(prefix="clipper_") as tmpdir:
        # ── PARALLEL DOWNLOAD: audio-only (fast) + full video (slow) ──────────
        # Audio-only download finishes in ~3-5s, letting transcription + LLM
        # analysis run while the full video is still downloading.
        begin_step("downloading")

        video_path = None
        audio_path = None

        def _download_video_bg():
            return download_video(url, tmpdir)

        if _cache_hit:
            # Check if we have a cached video file (< 24h old)
            _cached_video_path = _get_cached_video_path(_video_id) if _video_id else None
            if _cached_video_path:
                video_path = _cached_video_path
                state_log("INFO", f"📦 Using cached video file: {_cached_video_path}")
                # Flag this step as cache-served so the dashboard shows ⚡
                _pipeline_state.setdefault("steps", {}).setdefault("downloading", {})["cached"] = True
                write_state()
            else:
                # Cache hit — only download video for rendering, skip audio/transcription/analysis
                video_path = _download_video_bg()
                if not video_path:
                    end_step("downloading", "error")
                    _pipeline_state["status"] = "error"
                    _pipeline_state["error"] = "Download failed"
                    write_state()
                    append_history(job_id, 0)
                    return []
            end_step("downloading")
            try:
                probe = subprocess.run(
                    [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", video_path],
                    capture_output=True, text=True, timeout=5
                )
                if probe.returncode == 0:
                    fmt = json.loads(probe.stdout).get("format", {})
                    _pipeline_state["duration"] = float(fmt.get("duration", 0))
                    write_state()
            except:
                pass
        else:
            # No cache — full pipeline

            def _download_audio_bg():
                return download_audio_only(url, tmpdir)

            # Launch both downloads — don't use `with` so we can proceed before video finishes
            _dl_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
            video_future = _dl_pool.submit(_download_video_bg)
            audio_future = _dl_pool.submit(_download_audio_bg)
    
            # Wait for audio first (much faster) — we need it for transcription
            audio_path = audio_future.result()
            if audio_path:
                state_log("INFO", f"Audio downloaded ({os.path.getsize(audio_path) / 1024 / 1024:.1f} MB) — transcribing while video downloads...")
            else:
                # Audio-only download failed — wait for full video and extract audio from it
                state_log("WARNING", "Audio-only download failed, waiting for full video...")
                video_path = video_future.result()
                if not video_path:
                    _dl_pool.shutdown(wait=False)
                    end_step("downloading", "error")
                    _pipeline_state["status"] = "error"
                    _pipeline_state["error"] = "Download failed"
                    write_state()
                    append_history(job_id, 0)
                    return []
    
            # Use audio file for transcription (or video if audio-only failed)
            transcribe_source = audio_path or video_path
    
            # Check if video is already done (often finishes during audio download)
            if video_future.done():
                video_path = video_future.result()
                _dl_pool.shutdown(wait=False)
                if video_path:
                    end_step("downloading")
                    try:
                        probe = subprocess.run(
                            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", video_path],
                            capture_output=True, text=True, timeout=5
                        )
                        if probe.returncode == 0:
                            fmt = json.loads(probe.stdout).get("format", {})
                            _pipeline_state["duration"] = float(fmt.get("duration", 0))
                            write_state()
                    except:
                        pass
            else:
                state_log("INFO", "Video still downloading in background...")
    
            # Step 2: Transcribe (using audio-only file — video downloads in parallel)
            begin_step("transcribing")
            try:
                segments = transcribe(transcribe_source)
            except Exception as e:
                end_step("transcribing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = f"Transcription failed: {e}"
                write_state()
                append_history(job_id, 0)
                return []
            
            if not segments:
                end_step("transcribing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "No speech detected"
                write_state()
                append_history(job_id, 0)
                return []
            end_step("transcribing")
            
            all_words = []
            for seg in segments:
                all_words.extend(seg.get("words", []))
            
            # Transcript quality gate
            total_words = len(all_words)
            if total_words == 0:
                end_step("transcribing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "No words transcribed — audio may be silent, music-only, or a foreign language"
                write_state()
                append_history(job_id, 0)
                return []
    
            # Density pre-filter: remove low-density segments before LLM
            _pre_density_count = len(segments)
            segments = _filter_low_density_segments(segments)
            state_log("INFO", f"🧹 Density filter: {len(segments)} segments after removing low-density windows (was {_pre_density_count})")
    
            video_duration = segments[-1]["end"] if segments else 1
            words_per_sec = total_words / max(video_duration, 1)
            if words_per_sec < 0.5:
                state_log("WARNING", f"⚠️ Low transcript density: {words_per_sec:.2f} words/sec ({total_words} words in {video_duration:.0f}s) — captions may be sparse")
            else:
                state_log("INFO", f"✅ Transcript quality OK: {words_per_sec:.1f} words/sec ({total_words} words)")
    
            # Dynamic clip count based on video length
            _video_mins = video_duration / 60.0
    
            # Clip count:
            # <10 min  → ~1 per 5 min (don't over-clip short videos)
            # 10-30 min → use settings max_clips directly
            # >30 min  → allow up to 8 regardless of settings
            _settings_max = settings.get("max_clips", 5)
            if _video_mins < 10:
                _dynamic_max_clips = max(1, int(_video_mins / 5))
            elif _video_mins > 30:
                _dynamic_max_clips = max(_settings_max, 8)
            else:
                _dynamic_max_clips = _settings_max
    
            if max_clips:  # hard override from caller
                _dynamic_max_clips = min(_dynamic_max_clips, max_clips)
            state_log("INFO", f"🎯 Dynamic clip target: {_dynamic_max_clips} clips for {_video_mins:.0f}-min video")
    
            # Step 3: Find viral moments
            begin_step("analyzing")
            openrouter_key = settings.get("openrouter_api_key", "") or os.environ.get("OPENROUTER_API_KEY", "")
            selected_model = model_override or settings.get("model", "google/gemini-2.0-flash-001")
            if model_override:
                state_log("INFO", f"🔧 Model override active: {model_override}")
                _pipeline_state["settings"]["model"] = model_override

            # All LLM analysis goes through OpenRouter (supports Gemini, Claude, GPT-4o, etc.)
            # No separate Gemini SDK needed — OpenRouter routes to the right provider.
            moments, content_type = find_viral_moments_openrouter(
                segments, max_clips=_dynamic_max_clips,
                min_duration=min_duration or settings.get("min_duration", 45),
                max_duration=max_duration or settings.get("max_duration", 90),
                model=selected_model, api_key=openrouter_key,
                video_path=video_path or "",
            )
    
            # Content-type strategy
            _ct_config = {
                "rant":        {"hook_threshold": 8, "min_gap": 120},
                "interview":   {"hook_threshold": 7, "min_gap": 240},
                "podcast":     {"hook_threshold": 7, "min_gap": 240},
                "educational": {"hook_threshold": 7, "min_gap": 180},
                "other":       {"hook_threshold": 7, "min_gap": 180},
            }
            _ct = _ct_config.get(content_type, _ct_config["other"])
            _hook_threshold = _ct["hook_threshold"]
            _min_gap_secs = _ct["min_gap"]
    
            # Relax thresholds for longer videos — be less aggressive filtering
            if _video_mins > 20:
                _hook_threshold = max(5, _hook_threshold - 1)
            # Scale min gap with video length — short videos get tighter gaps
            if _video_mins < 15:
                _min_gap_secs = min(90, _min_gap_secs)   # short: max 90s gap
            elif _video_mins < 30:
                _min_gap_secs = min(100, _min_gap_secs)  # medium: max 100s gap
            else:
                _min_gap_secs = min(120, _min_gap_secs)  # long: max 120s gap
    
            state_log("INFO", f"📺 Content type: {content_type} → hook threshold ≥{_hook_threshold}, min gap {_min_gap_secs}s")
    
            if not moments:
                end_step("analyzing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "No moments identified"
                write_state()
                append_history(job_id, 0)
                return []
    
            # Clamp moments to actual video duration — LLM sometimes hallucinates
            # timestamps past the end of the transcript (e.g. 3599s in a 3046s video).
            # ffmpeg seeking past EOF produces a 0-byte file that the quality gate then kills.
            _max_ts = video_duration - 2  # 2s buffer from the hard end
            _min_dur = settings.get("min_duration", 45)
            _valid_moments = []
            for m in moments:
                _s = float(m["start"])
                if _s >= _max_ts:
                    state_log("WARNING", f"Dropping '{m.get('title','')}' — start {_s:.0f}s is past video end ({_max_ts:.0f}s)")
                    continue
                # Clamp end, then re-check duration is still long enough
                _e_orig = float(m["end"])
                m["end"] = min(_e_orig, _max_ts)
                _dur = float(m["end"]) - _s
                if _dur < _min_dur:
                    state_log("WARNING", f"Dropping '{m.get('title','')}' — only {_dur:.0f}s after bounds clamp (min={_min_dur}s)")
                    continue
                _valid_moments.append(m)
            moments = _valid_moments
            if not moments:
                end_step("analyzing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "All moments were out of bounds"
                write_state()
                append_history(job_id, 0)
                return []
    
            # Apply hook threshold (content-type driven)
            _pre_threshold = len(moments)
            moments = [m for m in moments if m.get("hook_score", 7) >= _hook_threshold]
            if len(moments) < _pre_threshold:
                state_log("INFO", f"🎣 Hook filter: dropped {_pre_threshold - len(moments)} clips below hook score {_hook_threshold}")
    
            # Enforce minimum gap between clips (prevent clustering)
            if moments and _min_gap_secs > 0:
                moments.sort(key=lambda m: float(m["start"]))
                _gapped = [moments[0]]
                for m in moments[1:]:
                    last_start = float(_gapped[-1]["start"])
                    this_start = float(m["start"])
                    if this_start - last_start >= _min_gap_secs:
                        _gapped.append(m)
                    else:
                        # Keep the one with higher hook_score
                        if m.get("hook_score", 7) > _gapped[-1].get("hook_score", 7):
                            _gapped[-1] = m
                _pre_gap = len(moments)
                moments = _gapped
                if len(moments) < _pre_gap:
                    state_log("INFO", f"📏 Gap filter: dropped {_pre_gap - len(moments)} clustered clips (min gap {_min_gap_secs}s)")
    
            if not moments:
                end_step("analyzing", "error")
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "All moments filtered out by hook/gap thresholds"
                write_state()
                append_history(job_id, 0)
                return []
    
            end_step("analyzing")

            # Save to video cache for future runs
            if _video_id:
                _cache_duration = segments[-1]["end"] if segments else 0
                _save_video_cache(_video_id, {
                    "video_id": _video_id,
                    "video_url": url,
                    "video_title": _pipeline_state.get("video_title", ""),
                    "thumbnail_url": _pipeline_state.get("thumbnail", ""),
                    "channel_name": _pipeline_state.get("channel", ""),
                    "duration_seconds": float(_cache_duration),
                    "content_type": content_type,
                    "segments": segments,
                    "moments": moments,
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                })
                state_log("INFO", f"📦 Analysis cached for {_video_id}")

        # ── Wait for video download if still running ──────────────────────────
        if not _cache_hit and not video_path:
            state_log("INFO", "Waiting for video download to finish...")
            video_path = video_future.result()
            _dl_pool.shutdown(wait=False)
            if not video_path:
                end_step("downloading", "error") if "downloading" not in _pipeline_state.get("steps", {}) else None
                _pipeline_state["status"] = "error"
                _pipeline_state["error"] = "Video download failed"
                write_state()
                append_history(job_id, 0)
                return []
            end_step("downloading")
            state_log("INFO", f"Video ready: {os.path.basename(video_path)} ({os.path.getsize(video_path) / 1024 / 1024:.1f} MB)")
            # Get duration
            try:
                probe = subprocess.run(
                    [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", video_path],
                    capture_output=True, text=True, timeout=5
                )
                if probe.returncode == 0:
                    fmt = json.loads(probe.stdout).get("format", {})
                    _pipeline_state["duration"] = float(fmt.get("duration", 0))
                    write_state()
            except:
                pass

        # Cache the video file for future runs (unified — covers all download paths)
        if _video_id and video_path and os.path.exists(video_path):
            _cache_dest_final = os.path.join(VIDEO_CACHE_DIR, f"{_video_id}.mp4")
            if os.path.abspath(video_path) != os.path.abspath(_cache_dest_final) and not os.path.exists(_cache_dest_final):
                try:
                    import shutil
                    shutil.copy2(video_path, _cache_dest_final)
                    state_log("INFO", f"📦 Video cached for 24h: {_video_id}.mp4 ({os.path.getsize(_cache_dest_final) // 1_048_576}MB)")
                except Exception as _ce:
                    state_log("WARNING", f"Failed to cache video file: {_ce}")

        # ── Re-analyze: run LLM on cached transcript with (optional) model override ──
        if _reanalyze_pending and segments:
            begin_step("analyzing")
            _ra_settings = dict(settings)
            if model_override:
                _ra_settings["model"] = model_override
                _pipeline_state["settings"]["model"] = model_override
            _ra_model = _ra_settings.get("model", "google/gemini-2.0-flash-001")
            state_log("INFO", f"🔄 Re-analyzing with model: {_ra_model}")
            _ra_or_key = _ra_settings.get("openrouter_api_key", "") or os.environ.get("OPENROUTER_API_KEY", "")
            _ra_max = max_clips or _ra_settings.get("max_clips", 5)
            _ra_min = min_duration or _ra_settings.get("min_duration", 45)
            _ra_max_dur = max_duration or _ra_settings.get("max_duration", 90)
            try:
                if "gemini" in _ra_model.lower():
                    # Reanalyze: use text-only (transcript already cached — no need to re-upload video)
                    state_log("INFO", f"🔄 Re-analyze using text transcript (skipping video upload)")
                    moments, content_type = find_viral_moments_gemini_text(
                        segments, max_clips=_ra_max, min_duration=_ra_min,
                        max_duration=_ra_max_dur, model_name=_ra_model,
                    )
                elif _ra_or_key:
                    moments, content_type = find_viral_moments_openrouter(
                        segments, max_clips=_ra_max, min_duration=_ra_min,
                        max_duration=_ra_max_dur, model=_ra_model, api_key=_ra_or_key,
                        video_path=video_path or "",
                    )
                else:
                    moments, content_type = find_viral_moments_gemini_text(
                        segments, max_clips=_ra_max, min_duration=_ra_min,
                        max_duration=_ra_max_dur, model_name=_ra_model,
                    )
                end_step("analyzing")
                state_log("INFO", f"🔄 Re-analysis complete: {len(moments)} moments found")
                # Update cache with fresh moments (keep cached segments/video)
                if _video_id and moments:
                    _save_video_cache(_video_id, {
                        "segments": segments,
                        "moments": moments,
                        "content_type": content_type,
                        "video_title": _pipeline_state.get("video_title", ""),
                        "channel": _pipeline_state.get("channel", ""),
                        "model_used": _ra_model,
                    })
                    state_log("INFO", f"💾 Cache updated with fresh moments (model: {_ra_model})")
            except Exception as _ra_e:
                end_step("analyzing", "error")
                state_log("ERROR", f"Re-analyze LLM failed: {_ra_e}")
                if not moments:
                    _pipeline_state["status"] = "error"
                    _pipeline_state["error"] = f"Re-analyze failed: {_ra_e}"
                    write_state()
                    append_history(job_id, 0)
                    return []

        # Step 4+5: Cut clips AND upload to R2 in parallel.
        # Each render thread uploads its clip immediately after rendering —
        # uploads overlap with other clips still being rendered, saving ~15s.
        begin_step("clipping")
        _upload_step_lock = threading.Lock()
        _uploading_begun = [False]  # guarded by _upload_step_lock

        r2_bucket = "clipper-clips"
        r2_base_url = "https://pub-6c9b679f62af448d805c844943944bf8.r2.dev"
        vid_match_r2 = re.search(r'(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})', url)
        vid_id_r2 = vid_match_r2.group(1) if vid_match_r2 else job_id

        clip_paths = []
        total_moments = len(moments)

        def _render_one(args):
            idx, moment = args
            start = float(moment["start"])
            end = float(moment["end"])
            title = moment.get("title", f"clip_{idx+1}")
            safe_title = re.sub(r'[^\w\s-]', '', title)[:40].strip().replace(' ', '_')
            output_path = os.path.join(output_dir, f"clip_{idx+1:02d}_{safe_title}.mp4")
            state_log("INFO", f"⚙️ Rendering {idx+1}/{total_moments}: {title} ({end-start:.0f}s)")

            # Acquire global render slot — caps total concurrent ffmpeg across all jobs
            with _render_semaphore:
                clip_title = title if title_enabled else ""
                # If a valid peak_offset exists, title lives on the teaser only.
                # Main clip gets captions from second 0 (no title intro).
                _po_raw = moment.get("peak_offset")
                if clip_title and teaser_enabled and _po_raw is not None:
                    try:
                        _po_check = float(_po_raw)
                        if 2.0 <= _po_check <= (end - start) - 7.0:
                            clip_title = ""  # teaser carries title; suppress in main clip
                    except (TypeError, ValueError):
                        pass

                result = cut_clip(video_path, start, end, output_path,
                                  captions=captions, words=all_words, title=clip_title,
                                  caption_font_size=caption_font_size, caption_margin_v=caption_margin_v,
                                  caption_chunk_size=caption_chunk_size, caption_highlight=caption_highlight,
                                  caption_highlight_color=caption_highlight_color,
                                  title_font_size=title_font_size, title_margin_v=title_margin_v,
                                  caption_font=caption_font, title_font=title_font,
                                  clip_format=clip_format,
                                  title_intro_duration=title_intro_duration,
                                  title_position=title_position,
                                  clip_number=idx + 1,
                                  total_clips=total_moments,
                                  crop_anchor=crop_anchor)

                # ── Teaser prepend (peak_offset hook) ────────────────────────
                # If Gemini identified a peak_offset, prepend a 6s teaser to the
                # clip. Title is shown during the teaser (fades out at end) and
                # suppressed in the main clip so captions start at second 0.
                _peak_offset = moment.get("peak_offset")
                if teaser_enabled and result and _peak_offset is not None:
                    try:
                        _peak_offset = float(_peak_offset)
                        _clip_dur = end - start
                        # Validate: peak must be inside the clip with room for 6s
                        if 2.0 <= _peak_offset <= _clip_dur - 7.0:
                            # Validate speech at peak_offset using transcript segments
                            _abs_peak_candidate = start + _peak_offset
                            _speech_near_peak = [
                                s for s in segments
                                if s["start"] >= _abs_peak_candidate - 2.0
                                and s["end"] <= _abs_peak_candidate + 4.0
                                and len(s.get("text", "").strip()) > 10
                            ]
                            if not _speech_near_peak:
                                # No speech here — find nearest high-speech moment in this clip
                                _clip_segs = [
                                    s for s in segments
                                    if s["start"] >= start + 2.0 and s["end"] <= end - 7.0
                                ]
                                if _clip_segs:
                                    # Pick segment with most words
                                    _best = max(_clip_segs, key=lambda s: len(s.get("text", "").split()))
                                    _peak_offset = _best["start"] - start
                                    _abs_peak_candidate = _best["start"]
                                    state_log("INFO", f"⚠️ peak_offset had no speech, shifted to transcript peak at +{_peak_offset:.1f}s for clip {idx+1}")
                                else:
                                    state_log("WARNING", f"No speech found for teaser in clip {idx+1}, skipping hook")
                                    raise ValueError("no speech for teaser")
                            abs_peak_start = _abs_peak_candidate
                            abs_peak_end   = abs_peak_start + 6.0
                            teaser_path = output_path + ".teaser.mp4"
                            combined_path = output_path + ".combined.mp4"

                            # Render teaser: same vertical format, no captions, face-aware crop
                            _w, _h = get_video_dimensions(video_path)
                            _is_land = _w > _h
                            if _is_land:
                                if clip_format == "center":
                                    _tcrop_w = (int(_h * 9 / 16) // 2) * 2
                                    _tvf = f"crop={_tcrop_w}:ih,scale=1080:1920"
                                elif clip_format == "split":
                                    # Detect face in teaser segment (same logic as main clip)
                                    _t_face_x = None
                                    _t_face_bbox = None
                                    try:
                                        _anchor_map = {"left": 0.2, "right": 0.8, "center": None}
                                        if crop_anchor == "auto":
                                            _t_face_x = detect_face_x_offset(video_path, abs_peak_start, abs_peak_end)
                                            if _t_face_x is not None:
                                                _t_face_bbox = detect_face_bbox(video_path, abs_peak_start, abs_peak_end)
                                        else:
                                            _t_face_x = _anchor_map.get(crop_anchor)
                                    except Exception as _tfe:
                                        state_log("INFO", f"Teaser face detect skipped: {_tfe}")
                                    if _t_face_bbox is not None:
                                        _t_fb_x, _t_fb_y, _t_fb_w, _t_fb_h = _t_face_bbox
                                        _t_bot_crop = (f"[vb]crop={_t_fb_w}:{_t_fb_h}:{_t_fb_x}:{_t_fb_y},"
                                                       f"scale=1080:1280:force_original_aspect_ratio=increase,"
                                                       f"crop=1080:1280[bot]")
                                    elif _t_face_x is not None:
                                        _t_scaled_w = int(_w * (1280 / _h)) if _h > 0 else 1920
                                        _t_bot_x = max(0, min(_t_scaled_w - 1080, int(_t_face_x * _t_scaled_w - 540)))
                                        _t_bot_crop = f"[vb]scale=-2:1280,crop=1080:1280:{_t_bot_x}:0[bot]"
                                    else:
                                        _t_bot_crop = "[vb]scale=-2:1280,crop=1080:1280[bot]"
                                    _tvf = (f"[0:v]split=2[vt][vb];"
                                            f"[vt]scale=1080:-2,pad=1080:640:(ow-iw)/2:(oh-ih)/2:black[top];"
                                            f"{_t_bot_crop};"
                                            "[top][bot]vstack[out]")
                                else:  # fullscreen
                                    _tvf = ("[0:v]split[bg][fg];"
                                            "[bg]crop=ih*9/16:ih,scale=1080:1920,boxblur=20:20[bgout];"
                                            "[fg]scale=1080:-2[fgout];"
                                            "[bgout][fgout]overlay=(W-w)/2:(H-h)/2[out]")
                            else:
                                _tvf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black[out]"

                            # Build teaser ffmpeg command
                            if "[out]" in _tvf:
                                _tcmd = [FFMPEG, "-y", "-ss", str(abs_peak_start), "-to", str(abs_peak_end),
                                         "-i", video_path, "-filter_complex", _tvf, "-map", "[out]",
                                         "-map", "0:a?", "-c:v", "h264_videotoolbox", "-b:v", "3500k",
                                         "-allow_sw", "1", "-c:a", "aac", "-b:a", "128k",
                                         "-movflags", "+faststart", teaser_path]
                            else:
                                _tcmd = [FFMPEG, "-y", "-ss", str(abs_peak_start), "-to", str(abs_peak_end),
                                         "-i", video_path, "-vf", _tvf,
                                         "-c:v", "h264_videotoolbox", "-b:v", "3500k",
                                         "-allow_sw", "1", "-c:a", "aac", "-b:a", "128k",
                                         "-movflags", "+faststart", teaser_path]

                            tr = subprocess.run(_tcmd, capture_output=True, text=True)
                            if tr.returncode == 0 and os.path.exists(teaser_path) and os.path.getsize(teaser_path) > 10_000:
                                # ── Burn title onto teaser (shows from frame 1, no fade) ──────
                                # Use original title (clip_title may be "" if suppressed for main clip)
                                _teaser_title = (title if title_enabled else "")
                                if _teaser_title:
                                    _t_titled_path = teaser_path + ".titled.mp4"
                                    _t_dur = abs_peak_end - abs_peak_start
                                    _t_title_text = _wrap_title(_teaser_title)
                                    def _fmt_t(t):
                                        h, r = divmod(t, 3600); m, s = divmod(r, 60)
                                        return f"{int(h)}:{int(m):02d}:{int(s):02d}.{int((t%1)*100):02d}"
                                    import hashlib as _hl2
                                    _t_ass_path = f"/tmp/clipper_th_{_hl2.md5(teaser_path.encode()).hexdigest()[:8]}.ass"
                                    _t_ass = (
                                        "[Script Info]\nTitle: TeaserTitle\nScriptType: v4.00+\nWrapStyle: 0\n"
                                        "ScaledBorderAndShadow: yes\nPlayResX: 1080\nPlayResY: 1920\n\n"
                                        "[V4+ Styles]\n"
                                        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
                                        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
                                        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
                                        f"Style: Title,{title_font},{title_font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
                                        f"-1,0,0,0,100,100,0,0,1,5,2,2,40,40,{caption_margin_v},1\n\n"
                                        "[Events]\n"
                                        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                                        f"Dialogue: 0,{_fmt_t(0)},{_fmt_t(_t_dur + 0.1)},Title,,0,0,0,,{{\\fad(0,500)}}{_t_title_text}\n"
                                    )
                                    with open(_t_ass_path, "w") as _taf:
                                        _taf.write(_t_ass)
                                    _t_esc = _t_ass_path.replace(":", "\\:")
                                    _t_fdir = FONTS_DIR.replace(":", "\\:")
                                    _t_title_cmd = [
                                        FFMPEG, "-y", "-i", teaser_path,
                                        "-vf", f"ass={_t_esc}:fontsdir={_t_fdir}",
                                        "-c:v", "h264_videotoolbox", "-b:v", "3500k", "-allow_sw", "1",
                                        "-c:a", "copy", "-movflags", "+faststart", _t_titled_path
                                    ]
                                    _tr2 = subprocess.run(_t_title_cmd, capture_output=True, text=True)
                                    if _tr2.returncode == 0 and os.path.exists(_t_titled_path) and os.path.getsize(_t_titled_path) > 10_000:
                                        os.replace(_t_titled_path, teaser_path)
                                        state_log("INFO", f"🏷️ Title burned onto teaser for clip {idx+1}")
                                    else:
                                        state_log("WARNING", f"Teaser title burn failed clip {idx+1}, using plain teaser")
                                        if os.path.exists(_t_titled_path):
                                            os.remove(_t_titled_path)
                                    if os.path.exists(_t_ass_path):
                                        os.remove(_t_ass_path)
                                # Concat teaser + main clip
                                _concat_cmd = [
                                    FFMPEG, "-y",
                                    "-i", teaser_path,
                                    "-i", result,
                                    "-filter_complex",
                                    "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
                                    "-map", "[v]", "-map", "[a]",
                                    "-c:v", "h264_videotoolbox", "-b:v", "3500k",
                                    "-allow_sw", "1", "-c:a", "aac", "-b:a", "128k",
                                    "-movflags", "+faststart", combined_path
                                ]
                                cr = subprocess.run(_concat_cmd, capture_output=True, text=True)
                                if cr.returncode == 0 and os.path.exists(combined_path) and os.path.getsize(combined_path) > 0:
                                    os.replace(combined_path, result)
                                    state_log("INFO", f"🎬 Teaser hook prepended to clip {idx+1} (peak at +{_peak_offset:.0f}s)")
                                else:
                                    state_log("WARNING", f"Teaser concat failed for clip {idx+1}, using main clip only")
                                # Clean up temp files
                                for _tmp in [teaser_path, combined_path]:
                                    if os.path.exists(_tmp):
                                        os.remove(_tmp)
                            else:
                                state_log("WARNING", f"Teaser render failed for clip {idx+1}, skipping hook")
                                if os.path.exists(teaser_path):
                                    os.remove(teaser_path)
                    except Exception as _pe:
                        state_log("WARNING", f"Teaser hook error clip {idx+1}: {_pe}")

            # Quality gate: reject 0-byte or tiny files (silent ffmpeg failures)
            r2_url = None
            if result and os.path.exists(result):
                fsize = os.path.getsize(result)
                if fsize < 100_000:
                    state_log("WARNING", f"🗑️ Clip {idx+1} quality gate FAILED: {fsize} bytes, discarding")
                    os.remove(result)
                    result = None
                else:
                    try:
                        probe = subprocess.run(
                            [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", result],
                            capture_output=True, text=True, timeout=10
                        )
                        probe_data = json.loads(probe.stdout)
                        actual_dur = float(probe_data["format"]["duration"])
                        expected_dur = float(end) - float(start)
                        drift = abs(actual_dur - expected_dur)
                        if drift > 10:
                            state_log("WARNING", f"⚠️ Clip {idx+1} duration drift: {actual_dur:.1f}s vs expected {expected_dur:.1f}s")
                        else:
                            state_log("INFO", f"✅ Clip {idx+1} quality OK: {fsize//1024}KB, {actual_dur:.1f}s")
                    except Exception:
                        pass

                    # ── Upload to R2 immediately (overlaps with other renders) ──
                    # Start the "uploading" step indicator on the very first upload (thread-safe)
                    _trigger_upload_step = False
                    with _upload_step_lock:
                        if not _uploading_begun[0]:
                            _uploading_begun[0] = True
                            _trigger_upload_step = True
                    if _trigger_upload_step:
                        begin_step("uploading")
                    fname = os.path.basename(result)
                    r2_key = f"default/{vid_id_r2}/{fname}"
                    try:
                        res = subprocess.run(
                            ["wrangler", "r2", "object", "put", f"{r2_bucket}/{r2_key}",
                             "--file", result, "--remote", "--content-type", "video/mp4"],
                            capture_output=True, text=True, timeout=120
                        )
                        if res.returncode == 0:
                            r2_url = f"{r2_base_url}/{r2_key}"
                            state_log("INFO", f"☁️ Clip {idx+1} uploaded: {fname}")
                        else:
                            state_log("WARNING", f"R2 upload failed for clip {idx+1}: {res.stderr[-100:]}")
                    except Exception as e:
                        state_log("WARNING", f"R2 upload error clip {idx+1}: {e}")

            return idx, result, title, float(end) - float(start), r2_url

        # Cap workers at min(clips, 4) — ffmpeg is CPU-bound
        max_workers = min(total_moments, 4)
        results_by_idx = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_render_one, (i, m)): i for i, m in enumerate(moments)}
            for future in concurrent.futures.as_completed(futures):
                idx, result_path, title, duration, r2_url = future.result()
                if result_path:
                    fsize = os.path.getsize(result_path) if os.path.exists(result_path) else 0
                    clip_entry = {
                        "path": result_path,
                        "filename": os.path.basename(result_path),
                        "title": title,
                        "duration": round(duration, 1),
                        "size_bytes": fsize,
                    }
                    if r2_url:
                        clip_entry["r2_url"] = r2_url
                    results_by_idx[idx] = clip_entry
                    with _state_lock:
                        _pipeline_state["clips"].append(clip_entry)
                        write_state()
                    state_log("INFO", f"✅ Clip {idx+1}/{total_moments} done: {title}")
                else:
                    state_log("WARNING", f"❌ Clip {idx+1} failed: {title}")

        clip_paths = [results_by_idx[i]["path"] for i in sorted(results_by_idx)]
        uploaded_count = sum(1 for c in results_by_idx.values() if c.get("r2_url"))
        end_step("clipping")
        if _uploading_begun[0]:
            end_step("uploading")
        state_log("INFO", f"☁️ {uploaded_count}/{len(clip_paths)} clips uploaded to R2")

        _pipeline_state["status"] = "done"
        write_state()
        
        state_log("INFO", f"🎬 Done! {len(clip_paths)}/{len(moments)} clips generated")
        append_history(job_id, len(clip_paths))
        
        return clip_paths


def main():
    parser = argparse.ArgumentParser(description="Local Video Clipper")
    parser.add_argument("url", help="YouTube URL to clip")
    parser.add_argument("--max-clips", type=int, default=5)
    parser.add_argument("--min-duration", type=int, default=20)
    parser.add_argument("--max-duration", type=int, default=90)
    parser.add_argument("--no-captions", action="store_true")
    parser.add_argument("--output-dir", default="./clips/")
    parser.add_argument("--job-id", type=str, default=None, help="Unique job ID for state file")
    parser.add_argument("--reanalyze", action="store_true", help="Re-run LLM on cached transcript (skip audio/transcription)")
    parser.add_argument("--model-override", type=str, default="", help="Use this model for LLM analysis instead of settings.json")
    
    args = parser.parse_args()
    
    # If job-id provided, use per-job state file and enable Convex sync
    if args.job_id:
        global STATE_FILE, _convex_job_id
        STATE_FILE = os.path.join(SCRIPT_DIR, f"pipeline_state_{args.job_id}.json")
        _convex_job_id = args.job_id
    
    clips = clip_video(
        url=args.url,
        max_clips=args.max_clips,
        min_duration=args.min_duration,
        max_duration=args.max_duration,
        captions=not args.no_captions,
        output_dir=args.output_dir,
        reanalyze=args.reanalyze,
        model_override=args.model_override,
    )
    
    if clips:
        print(f"\n📁 Generated {len(clips)} clips:")
        for c in clips:
            print(f"  → {c}")
    else:
        print("\n❌ No clips generated")
        sys.exit(1)


if __name__ == "__main__":
    main()
