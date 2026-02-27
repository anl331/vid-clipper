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
CREATORS_FILE = BASE_DIR / "creators.json"
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


def load_creators():
    return json.loads(CREATORS_FILE.read_text())


def save_creators(data):
    CREATORS_FILE.write_text(json.dumps(data, indent=2))


# --- YouTube RSS ---
def fetch_new_videos(channel_id, channel_name, hours=24):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    try:
        feed = feedparser.parse(url)
        videos = []
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        for entry in feed.entries:
            published = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            if published > cutoff:
                videos.append({
                    "id": entry.yt_videoid,
                    "title": entry.title,
                    "url": entry.link,
                    "published": published.isoformat(),
                    "creator": channel_name
                })
        return videos
    except Exception as e:
        log(f"RSS fetch failed for {channel_name}: {e}", "ERROR")
        return []


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
def cmd_scan(hours=24):
    """Scan all creators for new videos and clip them."""
    creators_data = load_creators()
    state = load_state()
    total_new = 0

    for creator in creators_data["creators"]:
        log(f"Scanning {creator['name']} ({creator['youtube_handle']})...")
        state["last_scan"][creator["channel_id"]] = datetime.now(EST).isoformat()

        videos = fetch_new_videos(creator["channel_id"], creator["name"], hours=hours)
        new_videos = [v for v in videos if v["id"] not in state.get("processed_videos", {})]

        if new_videos:
            log(f"Found {len(new_videos)} new video(s) from {creator['name']}")
            for video in new_videos:
                process_video(video, creator, state)
                total_new += 1
        else:
            log(f"No new videos from {creator['name']}")

    save_state(state)
    log(f"Scan complete. {total_new} new video(s) processed.")


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


def cmd_creators():
    """List configured creators."""
    data = load_creators()
    print(f"\n📋 Configured Creators ({len(data['creators'])}):\n")
    for c in data["creators"]:
        print(f"  • {c['name']} ({c['youtube_handle']})")
        print(f"    Channel ID: {c['channel_id']}")
        print(f"    Tags: {', '.join(c.get('tags', []))}")
        print()


def cmd_add_creator(handle):
    """Add a new creator by YouTube handle."""
    if not handle.startswith("@"):
        handle = f"@{handle}"

    log(f"Resolving channel ID for {handle}...")
    try:
        r = requests.get(f"https://www.youtube.com/{handle}", timeout=15,
                         headers={"User-Agent": "Mozilla/5.0"})
        m = re.search(r'"externalId":"([^"]+)"', r.text)
        if not m:
            log(f"Could not resolve channel ID for {handle}", "ERROR")
            return
        channel_id = m.group(1)

        nm = re.search(r'"channelMetadataRenderer":\{"title":"([^"]+)"', r.text)
        name = nm.group(1) if nm else handle.strip("@")
    except Exception as e:
        log(f"Failed to fetch channel: {e}", "ERROR")
        return

    data = load_creators()
    if any(c["channel_id"] == channel_id for c in data["creators"]):
        log(f"{handle} already configured!")
        return

    data["creators"].append({
        "name": name,
        "youtube_handle": handle,
        "channel_id": channel_id,
        "tags": []
    })
    save_creators(data)
    log(f"Added {name} ({handle}) - Channel: {channel_id}")


def cmd_status():
    """Show recent activity and clip history."""
    state = load_state()

    print("\n📊 Clipper Status\n")

    total = len(state.get("processed_videos", {}))
    print(f"  Total videos processed: {total}")
    print()

    print("  Last scans:")
    creators = load_creators()
    for c in creators["creators"]:
        last = state.get("last_scan", {}).get(c["channel_id"], "Never")
        print(f"    {c['name']}: {last}")
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
        print("Commands: scan, add <URL>, creators, add-creator <handle>, status")
        sys.exit(1)

    cmd = sys.argv[1].lower()

    if cmd == "scan":
        hours = int(sys.argv[2]) if len(sys.argv) > 2 else 24
        cmd_scan(hours=hours)
    elif cmd == "add":
        if len(sys.argv) < 3:
            print("Usage: clipper.py add <YOUTUBE_URL>")
            sys.exit(1)
        cmd_add(sys.argv[2])
    elif cmd == "creators":
        cmd_creators()
    elif cmd == "add-creator":
        if len(sys.argv) < 3:
            print("Usage: clipper.py add-creator <YOUTUBE_HANDLE>")
            sys.exit(1)
        cmd_add_creator(sys.argv[2])
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
