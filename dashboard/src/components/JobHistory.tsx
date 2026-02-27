import { useState, useRef, useEffect } from 'react'
import type { HistoryEntry, ClipInfo, LogEntry } from '../types'
import { ClipboardList, ChevronRight, ChevronDown, CheckCircle, AlertCircle, Clock, Film, Download, Mic, Brain, Scissors, Check, Terminal, HardDrive, ExternalLink, Trash2, RotateCcw } from 'lucide-react'

const STEPS_ORDER = ['downloading', 'transcribing', 'analyzing', 'clipping'] as const

const STEP_ICONS: Record<string, typeof Download> = {
  downloading: Download,
  transcribing: Mic,
  analyzing: Brain,
  clipping: Scissors,
  uploading: HardDrive,
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function elapsed(step: { started_at?: string; ended_at?: string }) {
  if (!step?.started_at) return null
  const start = new Date(step.started_at).getTime()
  const end = step.ended_at ? new Date(step.ended_at).getTime() : start
  const sec = Math.round((end - start) / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

function fmtSec(sec: number) {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

function shortModelName(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('gemini-2.5-pro')) return 'Gemini 2.5 Pro'
  if (m.includes('gemini-2.5-flash')) return 'Gemini 2.5 Flash'
  if (m.includes('gemini-2.0-flash')) return 'Gemini 2.0 Flash'
  if (m.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro'
  if (m.includes('claude-opus')) return 'Claude Opus'
  if (m.includes('claude-sonnet')) return 'Claude Sonnet'
  if (m.includes('claude-haiku')) return 'Claude Haiku'
  if (m.includes('gpt-4o')) return 'GPT-4o'
  // fallback: last segment after /
  return model.split('/').pop() || model
}

function totalDuration(h: HistoryEntry) {
  // 1. Prefer explicit startedAt / endedAt
  if (h.started_at && h.ended_at) {
    const sec = Math.round((new Date(h.ended_at).getTime() - new Date(h.started_at).getTime()) / 1000)
    if (sec > 0) return fmtSec(sec)
  }
  // 2. Fall back to step timing — first step start → last step end
  if (h.steps && Object.keys(h.steps).length > 0) {
    const stepVals = Object.values(h.steps) as any[]
    const starts = stepVals.map(s => s.started_at).filter(Boolean).map((t: string) => new Date(t).getTime())
    const ends   = stepVals.map(s => s.ended_at).filter(Boolean).map((t: string) => new Date(t).getTime())
    if (starts.length && ends.length) {
      const sec = Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)
      if (sec > 0) return fmtSec(sec)
    }
  }
  return null
}

function StepsAndLogs({ entry: h }: { entry: HistoryEntry }) {
  return (
    <div className="flex flex-col lg:flex-row gap-3 sm:gap-4">
      {/* Pipeline Steps - Left */}
      <div className="bg-black/20 rounded-lg p-3 sm:p-4 lg:w-[280px] shrink-0 overflow-y-auto h-[415px]">
        <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Scissors className="w-3.5 h-3.5" /> Pipeline
        </h4>
        {(h.thumbnail || h.video_title) && (
          <div className="flex gap-2.5 mb-4 pb-4 border-b border-white/5">
            {h.thumbnail && (
              <img src={h.thumbnail} alt="" className="w-16 h-10 object-cover rounded flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-xs text-white/60 font-medium leading-tight line-clamp-2">{h.video_title}</div>
              {h.channel && <div className="text-[10px] text-white/25 mt-0.5">{h.channel}</div>}
            </div>
            {h.video_url && (
              <a
                href={h.video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-white/25 hover:text-white/60 transition-colors"
                title="Open original video"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        )}
        {h.steps && Object.keys(h.steps).length > 0 ? (
          <div className="space-y-0">
            {STEPS_ORDER.map((step, i) => {
              const s = h.steps?.[step]
              if (!s) return null
              const st = s.ended_at || s.status === 'done' ? 'done' : s.started_at ? 'active' : 'pending'
              const el = elapsed(s)
              const StepIcon = STEP_ICONS[step]
              return (
                <div key={step} className="flex items-stretch gap-3">
                  <div className="flex flex-col items-center w-8">
                    {i > 0 && <div className="w-px h-2 bg-white/10" />}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      st === 'done' ? 'bg-green-500/15 ring-1 ring-green-500/20' : 'bg-white/[0.04] ring-1 ring-white/5'
                    }`}>
                      {st === 'done' ? <Check className="w-4 h-4 text-green-400" /> : <StepIcon className="w-4 h-4 text-white/20" />}
                    </div>
                    {i < STEPS_ORDER.length - 1 && h.steps?.[STEPS_ORDER[i + 1]] && <div className="w-px flex-1 min-h-[8px] bg-white/10" />}
                  </div>
                  <div className="flex-1 flex items-center justify-between py-2">
                    <span className="text-xs text-white/50 font-medium">{step.charAt(0).toUpperCase() + step.slice(1)}</span>
                    {el && (
                      <span className="text-[11px] text-white/30 font-mono bg-white/[0.04] px-1.5 py-0.5 rounded">{el}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-xs text-white/15 text-center py-4">No step data</div>
        )}
        {totalDuration(h) && (
          <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
            <span className="text-[10px] text-white/25 uppercase tracking-wider">Total</span>
            <span className="text-xs text-white/40 font-mono">{totalDuration(h)}</span>
          </div>
        )}
      </div>

      {/* Logs - Right */}
      <div className="bg-black/20 rounded-lg p-3 sm:p-4 flex flex-col overflow-hidden flex-1 h-[415px]">
        <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3 flex items-center gap-1.5 shrink-0">
          <Terminal className="w-3.5 h-3.5" /> Logs {h.logs?.length ? `(${h.logs.length})` : ''}
        </h4>
        {h.logs && h.logs.length > 0 ? (
          <div className="overflow-y-auto flex-1 font-mono text-[11px] space-y-px min-h-0">
            {h.logs.map((l: LogEntry, i: number) => {
              const levelColor: Record<string, string> = {
                INFO: 'text-blue-400/80',
                WARNING: 'text-yellow-400/80',
                ERROR: 'text-red-400/80',
                DEBUG: 'text-white/20'
              }
              const levelBg: Record<string, string> = {
                ERROR: 'bg-red-500/5',
                WARNING: 'bg-yellow-500/5',
              }
              return (
                <div key={i} className={`flex gap-2 leading-5 px-1 py-0.5 rounded ${levelBg[l.level] || ''}`}>
                  <span className="text-white/15 shrink-0 tabular-nums">{new Date(l.timestamp).toLocaleTimeString()}</span>
                  <span className={`shrink-0 w-14 text-right ${levelColor[l.level] || 'text-white/30'}`}>{l.level}</span>
                  <span className="text-white/50">{l.message}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-xs text-white/15 text-center flex-1 flex items-center justify-center">No logs available</div>
        )}
      </div>
    </div>
  )
}

export function JobHistory({ history, title = 'Job History', expanded: externalExpanded, onToggleId, onClear, onDelete, onRetry }: {
  history: HistoryEntry[];
  title?: string;
  expanded?: Set<string>;
  onToggleId?: (id: string) => void;
  onClear?: () => void;
  onDelete?: (jobId: string, clips: any[], videoId?: string) => void;
  onRetry?: (url: string) => void;
}) {
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  if (!history.length) {
    return (
      <div className="bg-white/[0.03] border border-white/5 rounded-xl p-12 text-center">
        <ClipboardList className="w-10 h-10 text-white/10 mx-auto mb-3" />
        <div className="text-white/30 text-sm">No job history yet.</div>
      </div>
    )
  }

  const expanded = externalExpanded || internalExpanded
  const toggle = (id: string) => {
    if (onToggleId) {
      onToggleId(id)
    } else {
      setInternalExpanded(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      })
    }
  }

  const reversed = history.slice().reverse()

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider flex items-center gap-2">
          <ClipboardList className="w-4 h-4" />
          {title} ({history.length})
        </h2>
        {onClear && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-white/25 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        )}
        {onClear && confirming && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-white/30">Clear all?</span>
            <button
              onClick={() => { onClear(); setConfirming(false) }}
              className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors font-medium"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-2 py-0.5 rounded text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
            >
              No
            </button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {reversed.map((h) => {
          const isOpen = expanded.has(h.id)
          const hasDetails = h.steps && Object.keys(h.steps).length > 0
          return (
            <div key={h.id} className="group bg-white/[0.03] border border-white/5 rounded-xl overflow-hidden">
              {/* Row header */}
              <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-white/[0.02] transition-colors">
                {/* Expand toggle */}
                <div className="cursor-pointer flex-shrink-0" onClick={() => toggle(h.id)}>
                  {hasDetails
                    ? isOpen ? <ChevronDown className="w-4 h-4 text-white/30" /> : <ChevronRight className="w-4 h-4 text-white/30" />
                    : <div className="w-4" />
                  }
                </div>
                {/* Thumbnail - hidden on mobile */}
                {h.thumbnail && (
                  <img src={h.thumbnail} alt="" className="w-12 h-8 object-cover rounded flex-shrink-0 hidden sm:block cursor-pointer" onClick={() => toggle(h.id)} />
                )}
                {/* Status indicator */}
                <div className="flex-shrink-0 cursor-pointer" onClick={() => toggle(h.id)}>
                  {h.status === 'done'
                    ? <CheckCircle className="w-4 h-4 text-green-400" />
                    : h.status === 'error'
                      ? <AlertCircle className="w-4 h-4 text-red-400" />
                      : <div className="w-2 h-2 rounded-full bg-white/20" />
                  }
                </div>
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => toggle(h.id)}>
                  <span className="text-xs sm:text-sm text-white/70 truncate block">{h.video_title || h.video_url}</span>
                  {h.channel && <span className="text-[10px] sm:text-xs text-white/25 truncate block">{h.channel}</span>}
                </div>
                {/* Pills */}
                <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0 text-[10px] sm:text-[11px] text-white/30 cursor-pointer" onClick={() => toggle(h.id)}>
                  <span className="bg-white/[0.06] px-1.5 sm:px-2 py-0.5 rounded-md font-medium">{h.clips_count} clips</span>
                  {totalDuration(h) && (
                    <span className="bg-white/[0.06] px-1.5 sm:px-2 py-0.5 rounded-md hidden sm:flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {totalDuration(h)}
                    </span>
                  )}

                  {h.started_at && (
                    <span className="bg-white/[0.06] px-1.5 sm:px-2 py-0.5 rounded-md hidden sm:block">
                      {new Date(h.started_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {/* Retry button — error rows only */}
                {onRetry && h.status === 'error' && h.video_url && (
                  <button
                    onClick={() => onRetry(h.video_url!)}
                    title="Retry this job"
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors flex-shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span className="hidden sm:inline">Retry</span>
                  </button>
                )}

                {/* Per-row delete */}
                {onDelete && (
                  pendingDeleteId === h.id ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => {
                          setDeletingId(h.id)
                          setPendingDeleteId(null)
                          const vidMatch = (h.video_url || '').match(/[?&]v=([^&]+)|youtu\.be\/([^?]+)/)
                          const videoId = vidMatch ? (vidMatch[1] || vidMatch[2]) : undefined
                          onDelete(h.id, h.clips || [], videoId)
                        }}
                        className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                      >
                        {deletingId === h.id ? '...' : 'Delete'}
                      </button>
                      <button
                        onClick={() => setPendingDeleteId(null)}
                        className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-white/30 hover:bg-white/10 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setPendingDeleteId(h.id)}
                      className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                      title="Delete job"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )
                )}
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-white/5 px-3 sm:px-4 py-3 sm:py-4 space-y-4 sm:space-y-5">
                  {/* Top row: Steps (left) + Logs (right) */}
                  <StepsAndLogs entry={h} />

                  {/* Clips - Full width below */}
                  {h.clips && h.clips.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                        <Film className="w-3.5 h-3.5" /> Generated Clips ({h.clips.length})
                      </h4>
                      <div className="flex gap-2 overflow-x-auto pb-2">
                        {h.clips.map((clip: ClipInfo, i: number) => (
                          <div key={i} className="group shrink-0 w-[180px] bg-white/[0.02] border border-white/5 rounded-xl overflow-hidden hover:border-white/15 hover:bg-white/[0.04] transition-all duration-200">
                            <div className="aspect-[9/16] bg-black relative">
                              <video
                                src={`/api/clips/${clip.path ? clip.path.split('/clips/').pop() : encodeURIComponent(clip.filename)}`}
                                controls
                                preload="metadata"
                                className="w-full h-full object-cover"
                              />
                              {/* Duration badge */}
                              <div className="absolute bottom-2 right-2 bg-black/90 text-white/90 text-[10px] px-1.5 py-0.5 rounded-md font-mono pointer-events-none backdrop-blur-sm">
                                {formatDuration(clip.duration)}
                              </div>
                              {/* Clip number badge */}
                              <div className="absolute top-2 left-2 bg-blue-500/80 text-white text-[10px] w-5 h-5 rounded-md flex items-center justify-center font-bold pointer-events-none">
                                {i + 1}
                              </div>
                            </div>
                            <div className="p-2">
                              <div className="text-[11px] text-white/70 font-medium leading-tight line-clamp-2 group-hover:text-white/90 transition-colors">{clip.title}</div>
                              <div className="flex items-center gap-2 mt-1 text-[10px] text-white/25">
                                <span>{formatDuration(clip.duration)}</span>
                                <span>{formatSize(clip.size_bytes)}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* No details fallback */}
                  {(!h.steps || Object.keys(h.steps).length === 0) && (!h.logs || h.logs.length === 0) && (!h.clips || h.clips.length === 0) && (
                    <div className="text-xs text-white/20 text-center py-4">No detailed data available for this job.</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
