# vid-clipper

**AI-powered video clipper with a visual dashboard.** Paste a video URL, get short-form vertical clips with animated captions — ready to post anywhere.

No cloud account required. Everything runs locally. Works out of the box — no API key needed.

---

## Dashboard

![dashboard](dashboard/src/assets/dashaboard.png)

Paste a URL, hit Clip, and watch the pipeline run in real time. Adjust clip count, duration, AI model, caption style, fonts, and more — all from the UI.

---

## How it works

### 1. Smart clip selection
The AI reads the full transcript and picks the best moments worth clipping — things with a strong hook, a clear story arc, and a satisfying payoff. It avoids intros, dead air, and mid-sentence cuts. Each clip is scored on how well it would stop someone from scrolling.

### 2. Face detection and smart framing
For landscape videos (standard YouTube, podcasts, screencasts), vid-clipper automatically detects the speaker using computer vision (YOLO person detection with MediaPipe and Haar cascade fallbacks) and reframes the shot into vertical 9:16.

The output is a **split-panel layout**:
- **Top third** — the full horizontal video, letterboxed, showing context (slides, screen, B-roll)
- **Bottom two thirds** — tight face crop, automatically centered on the speaker, scaled to fill the frame

No manual cropping. The speaker stays in frame even if they're off-center in the original.

### 3. Animated captions
Word-by-word captions are burned into each clip with highlight sync — the current word lights up as it's spoken. Font, size, color, and position are all configurable.

### 4. Hook teaser (optional)
Before each clip plays, a 6-second teaser pulls the most compelling spoken moment from inside the clip and prepends it as a hook — the kind of thing that makes someone stop scrolling before the full clip even starts.

---

## Features

- Downloads any video via yt-dlp (YouTube, Twitter/X, and 1000+ sites)
- Local transcription with [faster-whisper](https://github.com/guillaumekynast/faster-whisper) — no API key, runs on your machine
- AI moment selection via [OpenRouter](https://openrouter.ai) — free by default, supports any model
- YOLO + MediaPipe face detection for automatic speaker framing
- 9:16 split-panel output (top context + bottom face crop)
- Animated word-by-word captions with highlight
- Hook teaser auto-generated from the best spoken moment
- Visual dashboard — job queue, live progress, clip preview, history
- Everything saved locally — no uploads, no cloud, clips are yours

---

## Quick Start

**Requirements:** Python 3.10+, Node.js 18+, ffmpeg

```bash
# 1. Install ffmpeg
brew install ffmpeg        # macOS
apt install ffmpeg         # Linux

# 2. Clone and set up backend
git clone https://github.com/anl331/vid-clipper.git
cd vid-clipper/backend
pip install -r requirements.txt
cp settings.example.json settings.json
```

Open `settings.json`. No API key needed — it uses a free model by default. Optionally add an [OpenRouter](https://openrouter.ai) key for faster/better paid models:

```json
{
  "openrouter_api_key": ""
}
```

> **Free by default.** Leave `openrouter_api_key` blank and vid-clipper uses `google/gemini-2.0-flash-exp:free` automatically. Add a key to unlock paid models like Gemini Flash or Claude.

```bash
# 3. Start the dashboard
cd ../dashboard
npm install
npm run dev
```

Open `http://localhost:5180` — that's it.

---

## Customization

![settings](dashboard/src/assets/settings.png)

Everything is configurable from the Settings tab — no code edits needed.

### Clip settings
| Setting | What it does |
|---|---|
| **Max clips** | How many clips to generate per video (default: 5) |
| **Min duration** | Shortest a clip can be, in seconds (default: 20s) |
| **Max duration** | Longest a clip can be, in seconds (default: 90s) |
| **AI model** | Which LLM picks the moments — swap anytime |

### Video format
| Setting | What it does |
|---|---|
| **Clip format** | `split` (top context + bottom face), `center` (tight face crop only), `fullscreen` (original framing scaled) |
| **Crop anchor** | `auto` (face detection), `left`, `center`, or `right` — controls where the speaker is framed |

### Captions
| Setting | What it does |
|---|---|
| **Font** | Caption font (Squada One, Impact, Arial, etc.) |
| **Font size** | Caption text size |
| **Vertical margin** | How high/low captions sit on the frame |
| **Words per line** | How many words appear at a time (caption chunk size) |
| **Highlight** | Toggle word-by-word highlight on/off |
| **Highlight color** | Color of the active word highlight |

### Title card
| Setting | What it does |
|---|---|
| **Title enabled** | Show/hide the clip title overlay |
| **Title font** | Font for the title (can differ from captions) |
| **Title font size** | Title text size |
| **Title position** | `intro` (shows at start then fades) or `persistent` (stays on screen) |
| **Intro duration** | How many seconds the title shows before fading (default: 3.5s) |
| **Title margin** | Vertical position of the title on the frame |

### Transcription
| Setting | What it does |
|---|---|
| **Provider** | `local` (faster-whisper, free, private) or `groq` (cloud, ~10s for 1hr video) |
| **Groq API key** | Optional — only needed for cloud transcription |

---

## AI Models

Any model on OpenRouter works. Pick based on speed vs quality:

| Model | Speed | Quality | Notes |
|---|---|---|---|
| `google/gemini-2.0-flash-exp:free` | Fast | Good | **Default — free, no key needed** |
| `google/gemini-2.0-flash-001` | Fast | Great | Paid, best all-around |
| `google/gemini-2.5-flash` | Fast | Excellent | Newer, slightly better |
| `anthropic/claude-3.5-sonnet` | Medium | Excellent | Best for nuanced content |
| `openai/gpt-4o` | Medium | Excellent | Solid alternative |

Switch models anytime from the Settings tab — or per-job from the clip form.

---

## Speed

On a modern machine (M-series Mac or equivalent), a 1-hour video goes from URL to 5 finished clips in under 2 minutes:

| Step | Time |
|---|---|
| Download | ~15s |
| Transcription (Groq) | ~10s |
| AI clip selection | ~15s |
| Rendering 5 clips | ~60s |
| **Total** | **~2 min** |

Running transcription locally (no Groq key) adds ~3 min for a 1-hour video. Everything else stays the same.

## Transcription

By default, transcription runs locally using `faster-whisper` — free, private, no API key needed. It takes ~3 min for a 1-hour video on a modern machine.

Want faster transcription? Add a [Groq](https://console.groq.com) API key in Settings. Groq's Whisper API is free and cuts that to ~10 seconds.

---

## Output

Clips are saved to `backend/clips/<video_id>/`:

```
backend/clips/
  dQw4w9WgXcQ/
    clip_01_The_hook_moment.mp4
    clip_02_Key_insight.mp4
```

---

## Tech Stack

- **Backend:** Python, yt-dlp, ffmpeg, faster-whisper, OpenRouter, YOLO, MediaPipe
- **Dashboard:** React, Vite, Tailwind CSS
- **Storage:** Local JSON files — no database, no cloud required

---

## Contributing

PRs welcome. Open an issue first for big changes.

## License

MIT
