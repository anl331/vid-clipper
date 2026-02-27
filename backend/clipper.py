#!/usr/bin/env python3
"""Clipper - Automated YouTube → local clip pipeline"""

import sys
import os
import json
import time
import hashlib
import requests
import feedparser
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).parent
STATE_FILE = BASE_DIR / "state.json"
CLIPS_DIR = BASE_DIR / "clips"
LOGS_DIR = BASE_DIR / "logs"

# Ensure dirs
CLIPS_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

# Timezone
EST = timezone(timedelta(hours=-5))


def log(msg, level="INFO"):
    ts = datetime.now(EST).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    log_file = LOGS_DIR / f"{datetime.now(EST).strftime('%Y-%m-%d')}.log"
    with open(log_file, "a") as f:
        f.write(line + "\n")


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"processed_videos": {}, "last_scan": {}, "clip_history": []}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))





# --- Local clipping ---
def process_video(video, creator, state):
    """Download and clip a video locally."""
    vid_id = video["id"]
    title = video["title"]
    url = video["url"]

    log(f"Processing: {title} by {creator['name']}")

    output_dir = CLIPS_DIR / vid_id
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        from local_clipper import clip_video as local_clip_video
        clips = local_clip_video(
            url=url,
            max_clips=5,
            min_duration=20,
            max_duration=90,
            captions=True,
            output_dir=str(output_dir)
        )
        if not clips:
            log(f"No clips produced for {title}", "WARN")
            return

        log(f"Done: {title} → {len(clips)} clip(s) saved to clips/{vid_id}/")

        state["processed_videos"][vid_id] = {
            "title": title,
            "creator": creator["name"],
            "url": url,
            "processed_at": datetime.now(EST).isoformat(),
            "clips_count": len(clips),
            "output_dir": str(output_dir)
        }
        state.setdefault("clip_history", []).append({
            "video_id": vid_id,
            "creator": creator["name"],
            "title": title,
            "clips": clips,
            "timestamp": datetime.now(EST).isoformat()
        })
        save_state(state)

    except Exception as e:
        log(f"Clipping failed for {title}: {e}", "ERROR")


# --- CLI Commands ---


def cmd_add(url):
    """Manually clip a YouTube video by URL."""
    state = load_state()

    # Extract video ID
    if "v=" in url:
        vid_id = url.split("v=")[1].split("&")[0]
    elif "youtu.be/" in url:
        vid_id = url.split("youtu.be/")[1].split("?")[0]
    else:
        vid_id = hashlib.md5(url.encode()).hexdigest()[:11]

    if vid_id in state.get("processed_videos", {}):
        log(f"Video {vid_id} already processed. Use --force to reprocess.")
        return

    # Try to get video title
    title = f"Manual clip ({vid_id})"
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        m = re.search(r'<title>(.*?)</title>', r.text)
        if m:
            title = m.group(1).replace(" - YouTube", "").strip()
    except Exception:
        pass

    video = {
        "id": vid_id,
        "title": title,
        "url": url,
        "published": datetime.now(EST).isoformat(),
        "creator": "Manual"
    }
    creator = {"name": "Manual", "youtube_handle": "", "channel_id": "", "tags": []}
    process_video(video, creator, state)





def cmd_status():
    """Show recent activity and clip history."""
    state = load_state()

    print("\n📊 Clipper Status\n")

    total = len(state.get("processed_videos", {}))
    print(f"  Total videos processed: {total}")
    print()

    history = state.get("clip_history", [])[-5:]
    if history:
        print("  Recent clips:")
        for h in reversed(history):
            clips = h.get("clips", [])
            print(f"    • {h.get('title', 'Unknown')} ({h.get('creator', '?')}) — {len(clips)} clip(s)")
    print()


def main():
    if len(sys.argv) < 2:
        print("Usage: clipper.py <command> [args]")
        print("Commands: add <URL>, status")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "add":
        if len(sys.argv) < 3:
            print("Usage: clipper.py add <YOUTUBE_URL>")
            sys.exit(1)
        cmd_add(sys.argv[2])
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
