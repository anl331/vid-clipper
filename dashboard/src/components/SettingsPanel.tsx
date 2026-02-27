import { useState, useEffect } from 'react'
import type { Settings } from '../types'
import { Zap, Monitor, Eye, EyeOff, Check, Key, SlidersHorizontal, Loader2, Film, Download, Type } from 'lucide-react'
import { FontBrowser } from './FontBrowser'
import { VideoStylePreview } from './VideoStylePreview'

const FALLBACK_MODELS = [
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'anthropic/claude-haiku-3-5', name: 'Claude Haiku 3.5' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
]

const DEFAULTS: Settings = {
  model: 'google/gemini-2.0-flash-001',
  max_clips: 5,
  min_duration: 45,
  max_duration: 90,
  openrouter_api_key: '',
  groq_api_key: '',
  gemini_api_key: '',
  transcription_provider: 'groq',
  caption_font_size: 78,
  caption_margin_v: 350,
  caption_chunk_size: 3,
  caption_highlight: true,
  title_enabled: true,
  teaser_enabled: true,
  title_font_size: 78,
  title_margin_v: 200,
  caption_highlight_color: '#ffff00',
  caption_font: 'Montserrat ExtraBold',
  title_font: 'Montserrat ExtraBold',
  clip_format: 'fullscreen' as const,
  title_intro_duration: 3.5,
  title_position: 'intro' as const,
  crop_anchor: 'center' as const,
}

// SettingsPanel is fully self-contained: loads from /api/settings, saves to /api/settings.
// No dependency on parent props for data — onSave only notifies the parent of changes.
export function SettingsPanel({ onSave }: { settings?: Settings; onSave: (s: Settings) => void }) {
  const [local, setLocal] = useState<Settings>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [availableFonts, setAvailableFonts] = useState<{filename: string, displayName: string}[]>([])
  const [fontDownloadInput, setFontDownloadInput] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [showFontBrowser, setShowFontBrowser] = useState(false)
  const [availableModels, setAvailableModels] = useState<{id: string, name: string}[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  // Load settings from the file on mount — this is the single source of truth
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setLocal({
          model: data.model || DEFAULTS.model,
          max_clips: data.max_clips ?? DEFAULTS.max_clips,
          min_duration: data.min_duration ?? DEFAULTS.min_duration,
          max_duration: data.max_duration ?? DEFAULTS.max_duration,
          transcription_provider: data.transcription_provider || DEFAULTS.transcription_provider,
          openrouter_api_key: data.openrouter_api_key || '',
          groq_api_key: data.groq_api_key || '',
          gemini_api_key: data.gemini_api_key || '',
          caption_font_size: data.caption_font_size ?? DEFAULTS.caption_font_size,
          caption_margin_v: data.caption_margin_v ?? DEFAULTS.caption_margin_v,
          caption_chunk_size: data.caption_chunk_size ?? DEFAULTS.caption_chunk_size,
          caption_highlight: data.caption_highlight ?? DEFAULTS.caption_highlight,
          title_enabled: data.title_enabled ?? DEFAULTS.title_enabled,
          title_font_size: data.title_font_size ?? DEFAULTS.title_font_size,
          title_margin_v: data.title_margin_v ?? DEFAULTS.title_margin_v,
          caption_highlight_color: data.caption_highlight_color || '#ffff00',
          caption_font: data.caption_font || DEFAULTS.caption_font,
          title_font: data.title_font || DEFAULTS.title_font,
          clip_format: data.clip_format ?? DEFAULTS.clip_format,
          title_intro_duration: data.title_intro_duration ?? DEFAULTS.title_intro_duration,
          title_position: data.title_position ?? DEFAULTS.title_position,
          crop_anchor: data.crop_anchor ?? DEFAULTS.crop_anchor,
          teaser_enabled: data.teaser_enabled ?? DEFAULTS.teaser_enabled,
        })
      })
      .catch(() => {}) // keep defaults on error
      .finally(() => setLoading(false))

    fetch('/api/fonts').then(r => r.json()).then(setAvailableFonts).catch(() => {})

    setLoadingModels(true)
    fetch('/api/models')
      .then(r => r.json())
      .then((data: any) => { if (Array.isArray(data)) setAvailableModels(data) })
      .catch(() => {})
      .finally(() => setLoadingModels(false))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(local),
      })
      onSave(local) // notify parent (Convex sync, etc.)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Failed to save settings:', e)
    } finally {
      setSaving(false)
    }
  }

  const downloadFont = async () => {
    if (!fontDownloadInput.trim()) return
    setDownloading(true)
    setDownloadError('')
    try {
      const res = await fetch('/api/fonts/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family: fontDownloadInput.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setAvailableFonts(prev => [...prev, { filename: data.filename, displayName: data.displayName }])
        setFontDownloadInput('')
      } else {
        setDownloadError(data.error || 'Download failed')
      }
    } catch {
      setDownloadError('Network error')
    } finally {
      setDownloading(false)
    }
  }

  const handleFontSelect = (fontName: string, target: 'caption' | 'title' | 'both') => {
    if (target === 'caption' || target === 'both') {
      setLocal(prev => ({ ...prev, caption_font: fontName }))
    }
    if (target === 'title' || target === 'both') {
      setLocal(prev => ({ ...prev, title_font: fontName }))
    }
    // Refresh font list
    fetch('/api/fonts').then(r => r.json()).then(setAvailableFonts).catch(() => {})
  }

  const inputClass = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50 transition-colors'

  const KeyInput = ({ label, field, placeholder }: { label: string; field: keyof Settings; placeholder: string }) => (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-white/40">{label}</label>
        <button
          onClick={() => setShowKeys(p => ({ ...p, [field]: !p[field] }))}
          className="text-white/20 hover:text-white/40 transition-colors"
        >
          {showKeys[field] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <input
        type={showKeys[field] ? 'text' : 'password'}
        value={(local[field] as string) || ''}
        onChange={e => setLocal({ ...local, [field]: e.target.value })}
        placeholder={placeholder}
        className={inputClass}
      />
      {(local[field] as string) && (
        <div className="flex items-center gap-1 text-xs text-green-400/50 mt-1">
          <Check className="w-3 h-3" /> Set
        </div>
      )}
    </div>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-white/30">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading settings...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider flex items-center gap-2">
        <SlidersHorizontal className="w-4 h-4" />
        Settings
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

      {/* Pipeline Settings */}
      <div className="bg-white/[0.03] border border-white/5 rounded-xl p-5 space-y-5">
        <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider flex items-center gap-2">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Pipeline
        </h3>

        {/* Model */}
        <div>
          <label className="block text-xs text-white/40 mb-1.5">AI Model (moment selection)</label>
          <select
            value={local.model}
            onChange={e => setLocal({ ...local, model: e.target.value })}
            disabled={loadingModels}
            className={`${inputClass} disabled:opacity-50`}
          >
            {loadingModels && <option>Loading models...</option>}
            {(availableModels.length > 0 ? availableModels : FALLBACK_MODELS).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        {/* Transcription Provider */}
        <div>
          <label className="block text-xs text-white/40 mb-1.5">Transcription</label>
          <div className="flex gap-2">
            {(['groq', 'local'] as const).map(p => (
              <button
                key={p}
                onClick={() => setLocal({ ...local, transcription_provider: p })}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  local.transcription_provider === p
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'bg-white/5 text-white/30 border border-white/10 hover:text-white/50 hover:border-white/15'
                }`}
              >
                <span className="flex items-center justify-center gap-1.5">
                  {p === 'groq' ? <Zap className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
                  {p === 'groq' ? 'Groq Cloud' : 'Local Whisper'}
                </span>
                {p === 'groq' && <span className="block text-xs text-white/20 mt-0.5">~10s for 17min</span>}
                {p === 'local' && <span className="block text-xs text-white/20 mt-0.5">~3min for 17min</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Max clips */}
        <div>
          <label className="block text-xs text-white/40 mb-1.5">Max Clips: {local.max_clips}</label>
          <input
            type="range" min={1} max={10} value={local.max_clips}
            onChange={e => setLocal({ ...local, max_clips: +e.target.value })}
            className="w-full accent-blue-500"
          />
        </div>

        {/* Duration range */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-white/40 mb-1.5">Min Duration: {local.min_duration}s</label>
            <input
              type="range" min={10} max={60} step={5} value={local.min_duration}
              onChange={e => setLocal({ ...local, min_duration: +e.target.value })}
              className="w-full accent-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1.5">Max Duration: {local.max_duration}s</label>
            <input
              type="range" min={30} max={180} step={5} value={local.max_duration}
              onChange={e => setLocal({ ...local, max_duration: +e.target.value })}
              className="w-full accent-blue-500"
            />
          </div>
        </div>
      </div>

      {/* API Keys */}
      <div className="bg-white/[0.03] border border-white/5 rounded-xl p-5 space-y-5">
        <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider flex items-center gap-2">
          <Key className="w-3.5 h-3.5" />
          API Keys
        </h3>

        <KeyInput label="OpenRouter" field="openrouter_api_key" placeholder="sk-or-..." />
        <KeyInput label="Groq (transcription)" field="groq_api_key" placeholder="gsk_..." />
        <KeyInput label="Gemini (fallback)" field="gemini_api_key" placeholder="AIza..." />

        <p className="text-xs text-white/20">
          Keys are saved to settings.json and passed to the pipeline. They override environment variables.
        </p>
      </div>

      {/* Video Style */}
      <div className="bg-white/[0.03] border border-white/5 rounded-xl overflow-hidden lg:col-span-2">

        {/* Card header */}
        <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
          <Film className="w-3.5 h-3.5 text-white/40" />
          <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Video Style</h3>
        </div>

        {/* ── Section 1: Layout + Preview ─────────────────────────────── */}
        <div className="px-5 py-5 space-y-5">
          <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Layout</p>

          {/* Dual-format preview — click to select, adjust sliders to preview */}
          <div className="flex justify-center py-2">
            <VideoStylePreview
              settings={local}
              onFormatChange={f => setLocal({ ...local, clip_format: f })}
            />
          </div>

          {/* Crop Anchor — only meaningful for split/center formats */}
          <div className={`space-y-2 rounded-lg px-3 py-3 transition-colors ${
            (local.clip_format === 'split' || local.clip_format === 'center')
              ? 'bg-white/4'
              : 'opacity-35 pointer-events-none'
          }`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-white/80">Crop Anchor</p>
                <p className="text-[11px] text-white/35 mt-0.5">
                  {local.clip_format === 'split' ? 'Shifts the bottom zoom panel.' : 'Shifts the center crop.'}
                  {local.crop_anchor === 'auto' && ' Auto-detects the speaker\'s face.'}
                </p>
              </div>
              <div className="flex gap-1">
                {(['left', 'center', 'right', 'auto'] as const).map(v => (
                  <button key={v}
                    onClick={() => setLocal({ ...local, crop_anchor: v })}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all capitalize ${
                      local.crop_anchor === v
                        ? 'bg-blue-500/20 text-blue-400'
                        : 'bg-white/5 text-white/25 hover:text-white/50'
                    }`}>
                    {v === 'auto' ? '🎯 Auto' : v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Section 2: Captions + Title ─────────────────────────────── */}
        <div className="border-t border-white/5 px-5 py-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

            {/* Captions column */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Captions</p>

              {/* Size */}
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <label className="text-xs text-white/40">Size</label>
                  <span className="text-xs text-white/55 tabular-nums">{local.caption_font_size}px</span>
                </div>
                <input type="range" min={40} max={120} step={2} value={local.caption_font_size}
                  onChange={e => setLocal({ ...local, caption_font_size: +e.target.value })}
                  className="w-full accent-blue-500" />
              </div>

              {/* Position */}
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <label className="text-xs text-white/40">Position from bottom</label>
                  <span className="text-xs text-white/55 tabular-nums">{local.caption_margin_v}px</span>
                </div>
                <input type="range" min={100} max={600} step={10} value={local.caption_margin_v}
                  onChange={e => setLocal({ ...local, caption_margin_v: +e.target.value })}
                  className="w-full accent-blue-500" />
              </div>

              {/* Words per chunk */}
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <label className="text-xs text-white/40">Words per caption</label>
                  <span className="text-xs text-white/55 tabular-nums">{local.caption_chunk_size}</span>
                </div>
                <input type="range" min={1} max={5} step={1} value={local.caption_chunk_size}
                  onChange={e => setLocal({ ...local, caption_chunk_size: +e.target.value })}
                  className="w-full accent-blue-500" />
              </div>

              {/* Font */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40">Font</label>
                <select value={local.caption_font || 'Montserrat ExtraBold'}
                  onChange={e => setLocal({ ...local, caption_font: e.target.value })}
                  className={inputClass}>
                  {availableFonts.map(f => (
                    <option key={f.filename} value={f.displayName}>{f.displayName}</option>
                  ))}
                </select>
              </div>

              {/* Highlight — inline row */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40">Keyword Highlight</label>
                <div className="flex gap-1">
                  {([true, false] as const).map(v => (
                    <button key={String(v)}
                      onClick={() => setLocal({ ...local, caption_highlight: v })}
                      className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                        local.caption_highlight === v
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-white/5 text-white/25 hover:text-white/50'
                      }`}>
                      {v ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Highlight color — only when highlight is on */}
              {local.caption_highlight && (
                <div className="flex items-center justify-between">
                  <label className="text-xs text-white/40">Highlight Color</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/35 tabular-nums">
                      {(local.caption_highlight_color || '#ffff00').toUpperCase()}
                    </span>
                    <input type="color"
                      value={local.caption_highlight_color || '#ffff00'}
                      onChange={e => setLocal({ ...local, caption_highlight_color: e.target.value })}
                      className="w-8 h-7 rounded cursor-pointer bg-transparent border border-white/10" />
                  </div>
                </div>
              )}
            </div>

            {/* Title Overlay column */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Title Overlay</p>

              {/* Enabled toggle — inline row */}
              <div className="flex items-center justify-between">
                <label className="text-xs text-white/40">Show title</label>
                <div className="flex gap-1">
                  {([true, false] as const).map(v => (
                    <button key={String(v)}
                      onClick={() => setLocal({ ...local, title_enabled: v })}
                      className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                        local.title_enabled === v
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-white/5 text-white/25 hover:text-white/50'
                      }`}>
                      {v ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Teaser hook toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs text-white/40">Teaser hook</label>
                  <p className="text-[10px] text-white/20 mt-0.5">Prepends a 6s peak moment before the clip</p>
                </div>
                <div className="flex gap-1">
                  {([true, false] as const).map(v => (
                    <button key={String(v)}
                      onClick={() => setLocal({ ...local, teaser_enabled: v })}
                      className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                        (local.teaser_enabled ?? true) === v
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-white/5 text-white/25 hover:text-white/50'
                      }`}>
                      {v ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </div>

              {local.title_enabled && (
                <>
                  {/* Title position mode */}
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-white/40">Style</label>
                    <div className="flex gap-1">
                      {([
                        { v: 'intro', label: 'Intro' },
                        { v: 'top',   label: 'Static Top' },
                      ] as const).map(({ v, label }) => (
                        <button key={v}
                          onClick={() => setLocal({ ...local, title_position: v })}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                            (local.title_position ?? 'intro') === v
                              ? 'bg-blue-500/20 text-blue-400'
                              : 'bg-white/5 text-white/25 hover:text-white/50'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Title size */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <label className="text-xs text-white/40">Size</label>
                      <span className="text-xs text-white/55 tabular-nums">{local.title_font_size}px</span>
                    </div>
                    <input type="range" min={40} max={120} step={2} value={local.title_font_size}
                      onChange={e => setLocal({ ...local, title_font_size: +e.target.value })}
                      className="w-full accent-blue-500" />
                  </div>

                  {/* Intro duration — only for intro mode */}
                  {(local.title_position ?? 'intro') === 'intro' && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between">
                        <label className="text-xs text-white/40">Intro duration</label>
                        <span className="text-xs text-white/55 tabular-nums">{(local.title_intro_duration ?? 3.5).toFixed(1)}s</span>
                      </div>
                      <input type="range" min={1} max={6} step={0.5} value={local.title_intro_duration ?? 3.5}
                        onChange={e => setLocal({ ...local, title_intro_duration: +e.target.value })}
                        className="w-full accent-blue-500" />
                    </div>
                  )}

                  {/* Position from top — only for static top mode */}
                  {(local.title_position ?? 'intro') === 'top' && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between">
                        <label className="text-xs text-white/40">Position from top</label>
                        <span className="text-xs text-white/55 tabular-nums">{local.title_margin_v}px</span>
                      </div>
                      <input type="range" min={50} max={500} step={10} value={local.title_margin_v}
                        onChange={e => setLocal({ ...local, title_margin_v: +e.target.value })}
                        className="w-full accent-blue-500" />
                    </div>
                  )}

                  {/* Title font */}
                  <div className="space-y-1.5">
                    <label className="text-xs text-white/40">Font</label>
                    <select value={local.title_font || 'Montserrat ExtraBold'}
                      onChange={e => setLocal({ ...local, title_font: e.target.value })}
                      className={inputClass}>
                      {availableFonts.map(f => (
                        <option key={f.filename} value={f.displayName}>{f.displayName}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Section 3: Font Management ───────────────────────────────── */}
        <div className="border-t border-white/5 px-5 py-5 space-y-3">
          <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Font Management</p>
          <div className="flex gap-2">
            <input type="text"
              value={fontDownloadInput}
              onChange={e => setFontDownloadInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && downloadFont()}
              placeholder="Google Font name (e.g. Bebas Neue, Anton...)"
              className={inputClass}
            />
            <button onClick={downloadFont}
              disabled={downloading || !fontDownloadInput.trim()}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {downloading ? 'Adding...' : 'Add Font'}
            </button>
          </div>
          {downloadError && <p className="text-xs text-red-400">{downloadError}</p>}
          <button onClick={() => setShowFontBrowser(true)}
            className="flex items-center gap-1.5 text-xs text-blue-400/70 hover:text-blue-400 transition-colors">
            <Type className="w-3.5 h-3.5" />
            Browse Google Fonts
          </button>
        </div>

      </div>

      </div>{/* end grid */}

      {showFontBrowser && (
        <FontBrowser
          onClose={() => setShowFontBrowser(false)}
          onSelect={(name, target) => { handleFontSelect(name, target); setShowFontBrowser(false) }}
          downloadedFonts={availableFonts.map(f => f.displayName)}
        />
      )}

      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
        >
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
           : saved ? <><Check className="w-4 h-4" /> Saved</>
           : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
