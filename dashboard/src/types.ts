export interface PipelineState {
  status: 'idle' | 'downloading' | 'transcribing' | 'analyzing' | 'clipping' | 'done' | 'error'
  video_url?: string
  video_title?: string
  thumbnail?: string
  channel?: string
  duration?: number
  error?: string
  steps: Record<string, { started_at?: string; ended_at?: string; status: string; cached?: boolean }>
  logs: LogEntry[]
  clips: ClipInfo[]
  settings?: Settings
}

export interface LogEntry {
  timestamp: string
  level: string
  message: string
}

export interface ClipInfo {
  filename: string
  title: string
  duration: number
  size_bytes: number
  path: string
}

export interface Settings {
  model: string
  max_clips: number
  min_duration: number
  max_duration: number
  openrouter_api_key: string
  groq_api_key: string
  gemini_api_key: string
  transcription_provider: 'groq' | 'local'
  caption_font_size: number
  caption_margin_v: number
  caption_chunk_size: number
  caption_highlight: boolean
  title_enabled: boolean
  teaser_enabled?: boolean
  title_font_size: number
  title_margin_v: number
  caption_highlight_color?: string
  caption_font?: string
  title_font?: string
  clip_format?: 'fullscreen' | 'split' | 'center'
  crop_anchor?: 'auto' | 'left' | 'center' | 'right'
  title_intro_duration?: number
  title_position?: 'intro' | 'top'
}

export interface JobState extends PipelineState {
  jobId: string
  isActive: boolean
}

export interface HistoryEntry {
  id: string
  video_url: string
  video_title: string
  thumbnail?: string
  channel?: string
  status: string
  started_at: string
  ended_at?: string
  model: string
  clips_count: number
  clips: ClipInfo[]
  steps: Record<string, { started_at?: string; ended_at?: string; status: string; cached?: boolean }>
  logs: LogEntry[]
}
