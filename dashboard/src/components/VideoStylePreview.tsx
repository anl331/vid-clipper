import { useState, useEffect } from 'react'
import type { Settings } from '../types'

const W = 148
const H = Math.round(W * 1920 / 1080)  // ≈ 263px
const SCALE = W / 1080

const loadedFonts = new Set<string>()

async function loadFontIfNeeded(
  displayName: string,
  availableFonts: { filename: string; displayName: string }[]
) {
  if (loadedFonts.has(displayName)) return
  const entry = availableFonts.find(f => f.displayName === displayName)
  if (!entry) return
  try {
    const font = new FontFace(displayName, `url(/api/fonts/file/${encodeURIComponent(entry.filename)})`)
    await font.load()
    document.fonts.add(font)
    loadedFonts.add(displayName)
  } catch { /* fall back */ }
}

interface Props {
  settings: Settings
  onFormatChange?: (format: 'fullscreen' | 'split' | 'center') => void
}

export function VideoStylePreview({ settings, onFormatChange }: Props) {
  const [availableFonts, setAvailableFonts] = useState<{ filename: string; displayName: string }[]>([])

  const {
    caption_font_size = 78,
    caption_margin_v = 350,
    caption_chunk_size = 3,
    caption_highlight = true,
    caption_highlight_color = '#ffff00',
    title_enabled = true,
    title_font_size = 78,
    title_margin_v = 200,
    caption_font = 'Montserrat ExtraBold',
    title_font = 'Montserrat ExtraBold',
    clip_format = 'fullscreen',
    title_position = 'intro',
  } = settings

  useEffect(() => {
    fetch('/api/fonts').then(r => r.json()).then(setAvailableFonts).catch(() => {})
  }, [])

  useEffect(() => {
    if (!availableFonts.length) return
    Promise.all([
      loadFontIfNeeded(caption_font, availableFonts),
      loadFontIfNeeded(title_font, availableFonts),
    ]).catch(() => {})
  }, [caption_font, title_font, availableFonts])

  const captionFF   = `"${caption_font}", "Arial Black", sans-serif`
  const titleFF     = `"${title_font}", "Arial Black", sans-serif`
  const capSize     = Math.round(caption_font_size * SCALE)
  const titleSize   = Math.round(title_font_size * SCALE)
  const capMargin   = Math.round(caption_margin_v * SCALE)
  const titleMargin = Math.round(title_margin_v * SCALE)
  const textShadow  = '0 0 6px #000, 1px 1px 0 #000, -1px -1px 0 #000'

  // Generic sample text — not niche-specific
  const titleText   = 'NEVER DO\nTHIS AGAIN'
  const capWords    = caption_chunk_size <= 2 ? ['WATCH', 'THIS'] : ['YOU', 'NEED', 'THIS']

  // ── Shared overlays ──────────────────────────────────────────────────────

  // Title position depends on mode:
  // "intro" — bottom (caption zone), first N seconds then fades
  // "top"   — pinned at top for full duration
  const titleOverlay = title_enabled && (
    <div style={{
      position: 'absolute',
      ...(title_position === 'top'
        ? { top: titleMargin }
        : { bottom: capMargin }),
      left: 0, right: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 8px',
    }}>
      <p style={{
        fontFamily: titleFF, fontSize: titleSize, fontWeight: 900,
        color: '#fff', textShadow, textAlign: 'center',
        lineHeight: 1.15, whiteSpace: 'pre-line', textTransform: 'uppercase',
        letterSpacing: '0.02em',
      }}>
        {titleText}
      </p>
    </div>
  )

  // In "intro" mode: preview shows the intro (title only at bottom), no captions
  // In "top" mode: preview shows title at top + captions at bottom simultaneously
  const captionOverlay = (!title_enabled || title_position === 'top') && (
    <div style={{
      position: 'absolute', bottom: capMargin, left: 0, right: 0,
      display: 'flex', justifyContent: 'center', padding: '0 6px',
    }}>
      <p style={{
        fontFamily: captionFF, fontSize: capSize, fontWeight: 900,
        textShadow, textAlign: 'center',
        textTransform: 'uppercase', letterSpacing: '0.02em',
      }}>
        {capWords.map((w, i) => (
          <span key={i} style={{ color: caption_highlight && i === 1 ? caption_highlight_color : '#fff' }}>
            {w}{i < capWords.length - 1 ? ' ' : ''}
          </span>
        ))}
      </p>
    </div>
  )

  const videoH = Math.round(W * 9 / 16)  // 16:9 height at preview width

  // ── FULLSCREEN ───────────────────────────────────────────────────────────

  const fullscreenPreview = (
    <div style={{ width: W, height: H, background: '#0a0c10', position: 'relative' }}
      className="rounded-xl overflow-hidden flex-shrink-0">

      {/* Blurred bg zone — fills entire frame */}
      <div style={{ position: 'absolute', inset: 0, background: '#0f1318' }} />

      {/* Video band — centered, clearly distinct */}
      <div style={{
        position: 'absolute', top: '50%', left: 0, right: 0,
        transform: 'translateY(-50%)',
        height: videoH,
        background: '#1c2a3a',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }} />

      {titleOverlay}
      {captionOverlay}
    </div>
  )

  // ── SPLIT ────────────────────────────────────────────────────────────────

  const topH = Math.round(H / 3)

  const splitPreview = (
    <div style={{ width: W, height: H, background: '#000', position: 'relative' }}
      className="rounded-xl overflow-hidden flex-shrink-0">

      {/* Top 1/3 — letterboxed: black bars + video strip */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topH, background: '#000' }}>
        <div style={{
          position: 'absolute', top: '50%', left: 0, right: 0,
          transform: 'translateY(-50%)',
          height: videoH,
          background: '#1c2a3a',
        }} />
      </div>

      {/* Divider */}
      <div style={{
        position: 'absolute', top: topH, left: 0, right: 0,
        height: 1, background: 'rgba(255,255,255,0.15)', zIndex: 2,
      }} />

      {/* Bottom 2/3 — zoomed: fills full width, no bars */}
      <div style={{
        position: 'absolute', top: topH + 1, left: 0, right: 0, bottom: 0,
        background: '#1c2a3a',
      }} />

      {titleOverlay}
      {captionOverlay}
    </div>
  )

  // ── CENTER ───────────────────────────────────────────────────────────────

  const centerPreview = (
    <div style={{ width: W, height: H, background: '#000', position: 'relative' }}
      className="rounded-xl overflow-hidden flex-shrink-0">

      {/* Full-frame zoomed video — no blur, no split */}
      <div style={{ position: 'absolute', inset: 0, background: '#1c2a3a' }} />

      {titleOverlay}
      {captionOverlay}
    </div>
  )

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-xs text-white/30 uppercase tracking-wider">Format Preview</p>

      <div className="flex gap-4 flex-wrap justify-center">
        {([
          { key: 'fullscreen' as const, label: 'Fullscreen', preview: fullscreenPreview },
          { key: 'split' as const,      label: 'Split',       preview: splitPreview      },
          { key: 'center' as const,     label: 'Center Zoom', preview: centerPreview     },
        ]).map(({ key, label, preview }) => {
          const active = clip_format === key
          return (
            <button
              key={key}
              onClick={() => onFormatChange?.(key)}
              className={`flex flex-col items-center gap-2 group transition-all duration-200 ${
                onFormatChange ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              <div className={`rounded-xl p-0.5 transition-all duration-200 ${
                active
                  ? 'ring-2 ring-blue-500 shadow-[0_0_14px_rgba(59,130,246,0.4)]'
                  : 'ring-1 ring-white/8 group-hover:ring-white/20'
              }`}>
                {preview}
              </div>
              <div className="flex items-center gap-1.5">
                {active && <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
                <span className={`text-xs font-medium tracking-wide transition-colors ${
                  active ? 'text-blue-400' : 'text-white/25 group-hover:text-white/45'
                }`}>
                  {label}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-white/20 text-center">
        {onFormatChange ? 'Tap to select · Sliders update live' : 'Adjust sliders to preview live'}
      </p>
    </div>
  )
}
