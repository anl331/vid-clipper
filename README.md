# clipper

Automatically clips YouTube videos into short-form vertical content using AI. Includes a visual dashboard to manage jobs, tweak settings, and preview clips.

![dashboard preview](https://i.imgur.com/placeholder.png)

## How it works

1. Paste a YouTube URL (or add channels to monitor)
2. The pipeline downloads the video, transcribes it locally, and uses an LLM to find the best moments
3. Clips are rendered as vertical 9:16 video with animated captions
4. Preview and download from the dashboard

## Requirements

- Python 3.10+
- Node.js 18+
- `ffmpeg` — `brew install ffmpeg` or `apt install ffmpeg`
- One API key: [OpenRouter](https://openrouter.ai) (free tier available)

Transcription runs locally with `faster-whisper` — no extra API key needed.

## Setup

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
cp settings.example.json settings.json
```

Edit `settings.json` and add your OpenRouter key:

```json
{
  "openrouter_api_key": "sk-or-v1-...",
  "model": "google/gemini-2.0-flash-001"
}
```

### 2. Dashboard

```bash
cd dashboard
npm install
npm run dev
```

Open `http://localhost:5176` in your browser.

## CLI (no dashboard)

```bash
# Clip a specific video
python3 backend/clipper.py add "https://youtube.com/watch?v=..."

# Monitor channels for new videos
python3 backend/clipper.py scan

# Add a channel to monitor
python3 backend/clipper.py add-creator @channelhandle

# View status
python3 backend/clipper.py status
```

## Models

Any model on OpenRouter works. Recommended:

| Model | Speed | Quality |
|---|---|---|
| `google/gemini-2.0-flash-001` | Fast | Great |
| `anthropic/claude-3.5-sonnet` | Medium | Excellent |
| `openai/gpt-4o` | Medium | Excellent |

## Output

Clips are saved to `backend/clips/<video_id>/`:

```
backend/clips/
  dQw4w9WgXcQ/
    clip_01_Hook_moment.mp4
    clip_02_Key_insight.mp4
```

## License

MIT
