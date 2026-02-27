import { useState, useEffect, useRef, Fragment } from 'react'
import type { JobState } from '../types'
import { Download, Mic, Brain, Scissors, Upload, Check, Loader2, X, Clock, ChevronDown, ChevronUp, Terminal, Zap } from 'lucide-react'

const STEPS = ['downloading', 'transcribing', 'analyzing', 'clipping', 'uploading'] as const
const STEP_ICONS: Record<string, typeof Download> = {
  downloading: Download,
  transcribing: Mic,
  analyzing: Brain,
  clipping: Scissors,
  uploading: Upload,
}
const STEP_LABELS: Record<string, string> = {
  downloading: 'DL',
  transcribing: 'STT',
  analyzing: 'AI',
  clipping: 'Clip',
  uploading: 'Saving',
}

function ElapsedTime({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    const update = () => {
      const sec = Math.round((Date.now() - new Date(since).getTime()) / 1000)
      setElapsed(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`)
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [since])
  return <span className="text-[11px] text-white/40 font-mono">{elapsed}</span>
}

// Live ticking timer shown inside the active step pill
function ActiveStepTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    const update = () => {
      const sec = Math.round((Date.now() - new Date(since).getTime()) / 1000)
      setElapsed(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`)
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [since])
  return <span className="text-[9px] text-blue-400/70 font-mono">{elapsed}</span>
}

export function ActiveJobCard({ job, onStop }: { job: JobState; onStop: (id: string) => void }) {
  const [showLogs, setShowLogs] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const stepStatus = (step: string) => {
    const s = job.steps[step]
    if (!s) return 'pending'
    if (s.ended_at || s.status === 'done') return 'done'
    if (s.started_at) return 'active'
    return 'pending'
  }

  // Step was skipped (cached) if it's pending but a later step already ran,
  // OR the step's data has cached:true (e.g. download used cached video file)
  const isSkipped = (step: string) => {
    if (job.steps[step]?.cached === true) return true
    const idx = STEPS.indexOf(step as typeof STEPS[number])
    if (stepStatus(step) !== 'pending') return false
    return STEPS.slice(idx + 1).some(s => {
      const st = stepStatus(s)
      return st === 'done' || st === 'active'
    })
  }

  const recentLogs = job.logs?.slice(-50) ?? []

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (showLogs) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [recentLogs.length, showLogs])

  const levelColor: Record<string, string> = {
    INFO: 'text-blue-400/70',
    WARNING: 'text-yellow-400/80',
    ERROR: 'text-red-400/80',
    DEBUG: 'text-white/20',
  }

  return (
    <div className="bg-white/[0.03] border border-blue-500/20 rounded-xl overflow-hidden shadow-[0_0_12px_rgba(59,130,246,0.07)] animate-pulse-border">
      {/* Card body */}
      <div className="p-3 sm:p-4">
        {/* Top: Thumbnail + Title + Stop */}
        <div className="flex items-start gap-2.5">
          {job.thumbnail && (
            <img src={job.thumbnail} alt="" className="w-16 h-10 sm:w-24 sm:h-[60px] object-cover rounded-lg flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-xs sm:text-sm text-white/80 font-medium leading-tight line-clamp-2">
                  {job.video_title || job.video_url || 'Processing...'}
                </h3>
                {job.channel && <p className="text-[10px] sm:text-xs text-white/30 mt-0.5">{job.channel}</p>}
              </div>
              {/* Status + stop */}
              <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                {(() => {
                  const active = STEPS.find(s => {
                    const st = job.steps[s]
                    return st && st.started_at && !st.ended_at && st.status !== 'done'
                  })
                  if (active) return (
                    <div className="flex items-center gap-1 text-[10px] text-blue-400/70">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span className="capitalize font-medium">{active}…</span>
                      <ActiveStepTimer since={job.steps[active].started_at!} />
                    </div>
                  )
                  if (!job.steps?.downloading?.started_at) return (
                    <span className="text-[10px] text-white/25 italic">Starting…</span>
                  )
                  return null
                })()}
                <button
                  onClick={() => onStop(job.jobId)}
                  className="p-1 rounded-lg bg-red-500/10 text-red-400/70 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                  title="Stop job"
                >
                  <X className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Steps row — compact pills with flex connector lines between them */}
        <div className="flex items-center mt-3 w-full">
          {STEPS.map((step, i) => {
            const st = stepStatus(step)
            const Icon = STEP_ICONS[step]
            const isActive = st === 'active'
            const stepData = job.steps[step]

            let duration: string | null = null
            if (st === 'done' && stepData?.started_at && stepData?.ended_at) {
              const sec = Math.round((new Date(stepData.ended_at).getTime() - new Date(stepData.started_at).getTime()) / 1000)
              duration = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`
            }

            const cached = isSkipped(step)
            return (
              <Fragment key={step}>
                {/* Connector line — BEFORE each pill except the first */}
                {i > 0 && (
                  <div className={`flex-1 h-px ${
                    st === 'done' ? 'bg-green-500/30' :
                    cached ? 'bg-purple-500/20' :
                    st === 'active' ? 'bg-blue-500/25' : 'bg-white/8'
                  }`} />
                )}

                {/* Step pill */}
                <div className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-all flex-shrink-0 ${
                  isActive ? 'bg-blue-500/15 ring-1 ring-blue-500/25' :
                  st === 'done' ? 'bg-green-500/10 ring-1 ring-green-500/15' :
                  cached ? 'bg-purple-500/10 ring-1 ring-purple-500/20' :
                  'bg-white/[0.04]'
                }`}>
                  <div className="flex items-center gap-1">
                    {st === 'done'
                      ? <Check className="w-3 h-3 text-green-400" />
                      : isActive
                        ? <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                        : cached
                          ? <Zap className="w-3 h-3 text-purple-400" />
                          : <Icon className="w-3 h-3 text-white/20" />
                    }
                    <span className={`text-[10px] font-semibold ${
                      isActive ? 'text-blue-300' :
                      st === 'done' ? 'text-green-300/70' :
                      cached ? 'text-purple-300/70' :
                      'text-white/20'
                    }`}>
                      {STEP_LABELS[step]}
                    </span>
                  </div>
                  {duration
                    ? <span className="text-[9px] text-green-400/60 font-mono leading-none">{duration}</span>
                    : isActive && stepData?.started_at
                      ? <ActiveStepTimer since={stepData.started_at} />
                      : cached
                        ? <span className="text-[9px] text-purple-400/50 leading-none">cached</span>
                        : <span className="text-[9px] text-white/10 leading-none">–</span>
                  }
                </div>
              </Fragment>
            )
          })}
        </div>

        {/* Bottom row: total elapsed + logs toggle */}
        <div className="flex items-center justify-between mt-2.5">
          {job.steps?.downloading?.started_at ? (
            <div className="flex items-center gap-1 text-[10px] text-white/20">
              <Clock className="w-3 h-3" />
              <span>Total</span>
              <ElapsedTime since={job.steps.downloading.started_at} />
            </div>
          ) : <div />}
          <button
            onClick={() => setShowLogs(v => !v)}
            className="flex items-center gap-1 text-[10px] text-white/25 hover:text-white/50 transition-colors py-0.5 px-1.5 rounded"
          >
            <Terminal className="w-3 h-3" />
            {recentLogs.length > 0 ? `${recentLogs.length} logs` : 'logs'}
            {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Logs panel */}
      {showLogs && (
        <div className="border-t border-white/5 bg-black/30 px-3 py-2 max-h-40 overflow-y-auto">
          {recentLogs.length === 0 ? (
            <div className="text-[10px] text-white/20 text-center py-2">No logs yet...</div>
          ) : (
            <div className="space-y-px font-mono text-[10px]">
              {recentLogs.map((l, i) => (
                <div key={i} className="flex gap-2 leading-4">
                  <span className="text-white/15 shrink-0">
                    {new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`shrink-0 w-10 text-right ${levelColor[l.level] || 'text-white/30'}`}>{l.level}</span>
                  <span className="text-white/50 break-all">{l.message}</span>
                </div>
              ))}
                <div ref={logsEndRef} />
            </div>
          )}
          {/* Live running indicator */}
          <div className="flex items-center gap-1.5 mt-1.5 pt-1.5 border-t border-white/5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            <span className="text-[10px] text-blue-400/60 font-mono">running</span>
          </div>
        </div>
      )}
    </div>
  )
}
