import type { PipelineState } from '../types'
import { Download, Mic, Brain, Scissors, Check, Loader2, Clock, AlertCircle, CheckCircle, Zap } from 'lucide-react'

const STEPS = ['downloading', 'transcribing', 'analyzing', 'clipping'] as const

const STEP_ICONS: Record<string, typeof Download> = {
  downloading: Download,
  transcribing: Mic,
  analyzing: Brain,
  clipping: Scissors,
}

export function PipelineStatus({ state }: { state: PipelineState }) {
  return <PipelineStatusInner steps={state.steps} status={state.status} error={state.error} clips={state.clips} videoUrl={state.video_url} videoTitle={state.video_title} channel={state.channel} thumbnail={state.thumbnail} duration={state.duration} />
}

export function PipelineStatusInner({ steps, status, error, clips, videoUrl, videoTitle, channel, thumbnail, duration }: {
  steps: Record<string, { started_at?: string; ended_at?: string; status: string; cached?: boolean }>
  status?: string
  error?: string
  clips?: { filename: string }[]
  videoUrl?: string
  videoTitle?: string
  channel?: string
  thumbnail?: string
  duration?: number
}) {
  const elapsed = (step: string) => {
    const s = steps[step]
    if (!s?.started_at) return null
    const start = new Date(s.started_at).getTime()
    const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now()
    const sec = Math.round((end - start) / 1000)
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  const stepStatus = (step: string) => {
    const s = steps[step]
    if (!s) return 'pending'
    if (s.ended_at || s.status === 'done') return 'done'
    if (s.started_at) return 'active'
    return 'pending'
  }

  // A step is "cached" if it never started but a later step ran,
  // OR the step data has cached:true (e.g. download used cached video file)
  const isSkipped = (step: string) => {
    if (steps[step]?.cached === true) return true
    const idx = STEPS.indexOf(step as typeof STEPS[number])
    if (stepStatus(step) !== 'pending') return false
    return STEPS.slice(idx + 1).some(s => {
      const st = stepStatus(s)
      return st === 'done' || st === 'active'
    })
  }

  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Pipeline Status</h2>

      {videoUrl && (
        <div className="mb-4 p-3 bg-white/[0.02] rounded-lg border border-white/5 flex gap-3">
          {thumbnail && (
            <img src={thumbnail} alt="" className="w-32 h-20 object-cover rounded-md flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            {videoTitle && <div className="text-sm text-white/80 font-medium leading-tight line-clamp-2">{videoTitle}</div>}
            {channel && <div className="text-xs text-white/40 mt-1">{channel}</div>}
            <a href={videoUrl} target="_blank" className="text-xs text-blue-400/70 hover:text-blue-400 truncate block mt-1 transition-colors">
              {videoUrl}
            </a>
            {duration != null && duration > 0 && (
              <div className="flex items-center gap-1 text-xs text-white/30 mt-1">
                <Clock className="w-3 h-3" />
                {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
              </div>
            )}
          </div>
        </div>
      )}

      {status === 'error' && error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-0">
        {STEPS.map((step, i) => {
          const st = stepStatus(step)
          const el = elapsed(step)
          const cached = isSkipped(step)
          const StepIcon = STEP_ICONS[step]
          return (
            <div key={step} className="flex items-stretch gap-3">
              {/* Vertical connector + icon */}
              <div className="flex flex-col items-center w-8">
                {i > 0 && <div className={`w-px h-3 ${st !== 'pending' || cached ? 'bg-white/15' : 'bg-white/5'}`} />}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${
                  cached ? 'bg-purple-500/20' :
                  st === 'done' ? 'bg-green-500/20' :
                  st === 'active' ? 'bg-blue-500/20' :
                  'bg-white/5'
                }`}>
                  {cached ? <Zap className="w-4 h-4 text-purple-400" /> :
                   st === 'done' ? <Check className="w-4 h-4 text-green-400" /> :
                   st === 'active' ? <Loader2 className="w-4 h-4 text-blue-400 animate-spin" /> :
                   <StepIcon className="w-4 h-4 text-white/20" />}
                </div>
                {i < STEPS.length - 1 && <div className={`w-px flex-1 min-h-[12px] ${st !== 'pending' || cached ? 'bg-white/15' : 'bg-white/5'}`} />}
              </div>
              {/* Content */}
              <div className="flex-1 flex items-center justify-between py-2">
                <span className={`text-sm font-medium ${
                  cached ? 'text-purple-300/70' :
                  st === 'active' ? 'text-white' :
                  st === 'done' ? 'text-white/60' :
                  'text-white/30'
                }`}>
                  {step.charAt(0).toUpperCase() + step.slice(1)}
                </span>
                <div className="flex items-center gap-2">
                  {cached && (
                    <span className="text-xs text-purple-400/70 font-medium flex items-center gap-1">
                      <Zap className="w-3 h-3" /> cached
                    </span>
                  )}
                  {!cached && el && <span className="text-xs text-white/30 font-mono">{el}</span>}
                  {st === 'active' && (
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {status === 'done' && (
        <div className="mt-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-400 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          Complete — {clips?.length || 0} clip{(clips?.length || 0) !== 1 ? 's' : ''} generated
        </div>
      )}

      {status === 'idle' && (
        <div className="mt-4 text-center text-white/20 text-sm py-8">
          No active job. Run the clipper to see progress here.
        </div>
      )}
    </div>
  )
}
