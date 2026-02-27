import { useState, useEffect } from 'react'
import './index.css'
import { SettingsPanel } from './components/SettingsPanel'
import { JobHistory } from './components/JobHistory'
import { ActiveJobCard } from './components/ActiveJobCard'
import { Scissors, Zap, Settings as SettingsIcon, ClipboardList, Play, Loader2, Clock, Inbox } from 'lucide-react'
import { useUIStore } from './store/useClipperStore'
import type { Settings, HistoryEntry, JobState } from './types'
import { useLocalJobs, mapLocalJob } from './hooks/useJobs'

function App() {
  const { expandedJobs, toggleExpanded } = useUIStore()
  const [tab, setTab] = useState<'pipeline' | 'settings' | 'history'>('pipeline')
  const [fileSettings, setFileSettings] = useState<Settings | null>(null)

  // Load settings from local file
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => setFileSettings({
        model: data.model || 'google/gemini-2.0-flash-001',
        max_clips: data.max_clips ?? 5,
        min_duration: data.min_duration ?? 45,
        max_duration: data.max_duration ?? 90,
        transcription_provider: data.transcription_provider || 'local',
        openrouter_api_key: data.openrouter_api_key || '',
        groq_api_key: data.groq_api_key || '',
        gemini_api_key: data.gemini_api_key || '',
      }))
      .catch(() => {})
  }, [])

  // Job data — local polling (no Convex required)
  const { activeJobs: localActiveJobs, history, deleteJob, stopJob: stopLocalJob, clearHistory, retryJob: retryLocalJob } = useLocalJobs()

  const settings: Settings = fileSettings ?? {
    model: 'google/gemini-2.0-flash-001',
    max_clips: 5,
    min_duration: 45,
    max_duration: 90,
    openrouter_api_key: '',
    groq_api_key: '',
    gemini_api_key: '',
    transcription_provider: 'local' as const,
  }

  const saveSettings = async (s: Settings) => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    })
    setFileSettings(s)
  }

  const [videoUrl, setVideoUrl] = useState('')
  const [launching, setLaunching] = useState(false)
  const [jobMaxClips, setJobMaxClips] = useState<number | null>(null)
  const [jobMinDuration, setJobMinDuration] = useState<number | null>(null)
  const [jobMaxDuration, setJobMaxDuration] = useState<number | null>(null)
  const [jobModel, setJobModel] = useState<string>('')
  const [availableModels, setAvailableModels] = useState<{id: string, name: string}[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  // Fetch OR model list once on mount
  useEffect(() => {
    setLoadingModels(true)
    fetch('/api/models')
      .then(r => r.json())
      .then((data: any) => { if (Array.isArray(data)) setAvailableModels(data) })
      .catch(() => {})
      .finally(() => setLoadingModels(false))
  }, [])

  const [preview, setPreview] = useState<{
    title: string; thumbnail: string; channel: string; duration: number;
    view_count: number; upload_date: string; video_id: string;
  } | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  const [cacheStatus, setCacheStatus] = useState<{ cached: boolean; model: string | null; moments: number } | null>(null)

  // Check cache status whenever preview changes (has video_id)
  useEffect(() => {
    if (!preview?.video_id) { setCacheStatus(null); return }
    fetch(`/api/cache-status?videoId=${preview.video_id}`)
      .then(r => r.json())
      .then(data => setCacheStatus(data))
      .catch(() => setCacheStatus(null))
  }, [preview?.video_id])

  // Auto-derive re-analyze: cache exists + user explicitly picked a different model
  const reanalyze = !!(cacheStatus?.cached && jobModel && jobModel !== (cacheStatus?.model || ''))
  const [optimisticJob, setOptimisticJob] = useState<JobState | null>(null)

  useEffect(() => {
    const url = videoUrl.trim()
    const isYT = /(?:youtube\.com\/watch\?v=|youtu\.be\/)/.test(url)
    if (!isYT) { setPreview(null); return }
    const timeout = setTimeout(async () => {
      setLoadingPreview(true)
      try {
        const res = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`)
        if (res.ok) setPreview(await res.json())
        else setPreview(null)
      } catch { setPreview(null) }
      finally { setLoadingPreview(false) }
    }, 500)
    return () => clearTimeout(timeout)
  }, [videoUrl])

  // Clear optimistic job once the real job appears in Convex
  useEffect(() => {
    if (!optimisticJob) return
    const url = optimisticJob.video_url
    const found = localActiveJobs.some(j => j.video_url === url && !j.jobId?.startsWith('optimistic-'))
    if (found) setOptimisticJob(null)
  }, [localActiveJobs, optimisticJob])

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}` : `${m}:${sec.toString().padStart(2,'0')}`
  }

  const formatViews = (n: number) => {
    if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M views`
    if (n >= 1_000) return `${(n/1_000).toFixed(1)}K views`
    return `${n} views`
  }

  const runPipeline = async () => {
    if (!videoUrl.trim()) return
    setLaunching(true)

    // Optimistic: show job immediately before API responds
    const _optimisticJob: JobState = {
      jobId: `optimistic-${Date.now()}`,
      status: 'queued',
      video_url: videoUrl.trim(),
      video_title: preview?.title || videoUrl.trim(),
      thumbnail: preview?.thumbnail || null,
      channel: preview?.channel || null,
      error: undefined,
      steps: {},
      logs: [{ ts: new Date().toISOString(), level: 'INFO', msg: 'Starting...' }],
      clips: [],
      isActive: true,
      settings: {},
    }
    setOptimisticJob(_optimisticJob)

    // Clear form immediately (don't wait for API)
    const _url = videoUrl.trim()
    const _maxClips = jobMaxClips ?? settings.max_clips
    const _minDuration = jobMinDuration ?? settings.min_duration
    const _maxDuration = jobMaxDuration ?? settings.max_duration
    setVideoUrl('')
    setPreview(null)
    setJobMaxClips(null)
    setJobMinDuration(null)
    setJobMaxDuration(null)
    setJobModel('')
    setCacheStatus(null)

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: _url,
          max_clips: _maxClips,
          min_duration: _minDuration,
          max_duration: _maxDuration,
          reanalyze,
          model_override: jobModel || '',
        })
      })
      const data = await res.json()
      if (!data.ok) {
        setOptimisticJob(null)
        alert(data.error || 'Failed to start')
      }
      // On success: leave optimisticJob in place — the useEffect below will clear it
      // once Convex picks up the real job
    } catch (e: any) {
      setOptimisticJob(null)
      alert(e.message)
    } finally {
      setLaunching(false)
    }
  }

  const retryJob = retryLocalJob

  const stopJob = async (jobId: string) => {
    stopLocalJob(jobId)
  }

  const tabs = [
    { id: 'pipeline' as const, label: 'New Clip', icon: Scissors },
    { id: 'history' as const, label: 'History', icon: ClipboardList },
    { id: 'settings' as const, label: 'Settings', icon: SettingsIcon },
  ]

  const activeJobs = [
    ...(optimisticJob ? [optimisticJob] : []),
    ...localActiveJobs.filter(j => !optimisticJob || j.video_url !== optimisticJob.video_url),
  ]
  const recentCompleted = history.slice(0, 5)

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Header */}
      <header className="border-b border-white/5 px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <Scissors className="w-4 h-4 sm:w-5 sm:h-5 text-blue-400" />
            <h1 className="text-lg sm:text-xl font-bold text-white/90">Clipper</h1>
            {activeJobs.length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-medium bg-blue-500/20 text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                {activeJobs.length}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="border-b border-white/5 px-2 sm:px-6 flex">
        {tabs.map(t => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
                tab === t.id
                  ? 'text-white border-b-2 border-blue-500'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              {t.label}
            </button>
          )
        })}
      </nav>

      {/* Content */}
      <main className="p-3 sm:p-6 max-w-7xl mx-auto">
        {tab === 'pipeline' && (
          <div className="space-y-6">
            {/* New Job Input */}
            <div className="bg-white/[0.03] border border-white/5 rounded-xl p-3 sm:p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={videoUrl}
                  onChange={e => setVideoUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && runPipeline()}
                  placeholder="Paste YouTube URL..."
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 sm:px-4 py-2.5 text-white text-sm placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 transition-colors"
                />
                <button
                  onClick={runPipeline}
                  disabled={!videoUrl.trim() || launching}
                  className="flex items-center gap-1.5 px-3 sm:px-5 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                >
                  {launching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">{launching ? 'Starting...' : 'Clip'}</span>
                </button>
              </div>

              {/* Video Preview */}
              {loadingPreview && (
                <div className="mt-3 flex items-center gap-2 text-white/30 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Fetching video info...
                </div>
              )}
              {preview && !loadingPreview && (
                <div className="mt-3 flex items-center gap-2.5 sm:gap-3 bg-white/[0.02] rounded-lg px-2.5 sm:px-3 py-2 border border-white/5 overflow-hidden">
                  <img src={preview.thumbnail} alt="" className="w-14 h-9 sm:w-20 sm:h-12 object-cover rounded flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-white/80 font-medium text-xs sm:text-sm leading-tight truncate">{preview.title}</h3>
                    <div className="flex items-center gap-1.5 sm:gap-2 mt-0.5 text-[10px] sm:text-xs text-white/30 truncate">
                      <span className="truncate">{preview.channel}</span>
                      {preview.duration > 0 && <><span className="text-white/10">·</span><span className="flex items-center gap-1 flex-shrink-0"><Clock className="w-3 h-3" />{formatDuration(preview.duration)}</span></>}
                    </div>
                  </div>
                </div>
              )}

              {/* Per-job fine-tuning */}
              {(preview || videoUrl.trim()) && !loadingPreview && (
                <div className="mt-3 pt-3 border-t border-white/5">
                  <div className="flex items-center gap-1.5 mb-3">
                    <SettingsIcon className="w-3.5 h-3.5 text-white/30" />
                    <span className="text-xs text-white/30">Job settings</span>
                    {cacheStatus?.cached && !reanalyze && (
                      <span className="ml-1 flex items-center gap-1 text-[10px] text-purple-400/70 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">
                        ⚡ cached · {cacheStatus.moments} moments
                      </span>
                    )}
                    {reanalyze && (
                      <span className="ml-1 flex items-center gap-1 text-[10px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                        🔄 will re-analyze with {jobModel.split('/').pop()}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-2 sm:mb-3">
                    <div>
                      <label className="block text-[10px] text-white/25 mb-1">Clips</label>
                      <input
                        type="number" min={1} max={15}
                        value={jobMaxClips ?? ''}
                        onChange={e => setJobMaxClips(e.target.value ? +e.target.value : null)}
                        placeholder={String(settings.max_clips)}
                        className="w-full bg-white/5 border border-white/10 rounded-md px-2 sm:px-2.5 py-1.5 text-xs sm:text-sm text-white placeholder:text-white/15 focus:outline-none focus:border-blue-500/50"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/25 mb-1">Min (s)</label>
                      <input
                        type="number" min={10} max={120} step={5}
                        value={jobMinDuration ?? ''}
                        onChange={e => setJobMinDuration(e.target.value ? +e.target.value : null)}
                        placeholder={String(settings.min_duration)}
                        className="w-full bg-white/5 border border-white/10 rounded-md px-2 sm:px-2.5 py-1.5 text-xs sm:text-sm text-white placeholder:text-white/15 focus:outline-none focus:border-blue-500/50"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/25 mb-1">Max (s)</label>
                      <input
                        type="number" min={30} max={180} step={5}
                        value={jobMaxDuration ?? ''}
                        onChange={e => setJobMaxDuration(e.target.value ? +e.target.value : null)}
                        placeholder={String(settings.max_duration)}
                        className="w-full bg-white/5 border border-white/10 rounded-md px-2 sm:px-2.5 py-1.5 text-xs sm:text-sm text-white placeholder:text-white/15 focus:outline-none focus:border-blue-500/50"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-white/25 mb-1">Model</label>
                    <select
                      value={jobModel}
                      onChange={e => setJobModel(e.target.value)}
                      disabled={loadingModels}
                      className="w-full bg-white/5 border border-white/10 rounded-md px-2 sm:px-2.5 py-1.5 text-xs sm:text-sm text-white/70 focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
                    >
                      <option value="">Default ({settings.model.split('/').pop()})</option>
                      {loadingModels && <option disabled>Loading models…</option>}
                      {!loadingModels && availableModels.length === 0 && (
                        <>
                          <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
                          <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
                          <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
                        </>
                      )}
                      {availableModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Active Jobs */}
            <div>
              <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Active Jobs {activeJobs.length > 0 && `(${activeJobs.length})`}
              </h2>
              {activeJobs.length === 0 ? (
                <div className="bg-white/[0.03] border border-white/5 rounded-xl p-8 sm:p-12 text-center">
                  <Inbox className="w-8 h-8 sm:w-10 sm:h-10 text-blue-400 mx-auto mb-2 sm:mb-3" />
                  <div className="text-white/30 text-xs sm:text-sm">No active jobs. Paste a URL above to start.</div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {activeJobs.map(job => (
                    <ActiveJobCard key={job.jobId} job={job} onStop={stopJob} />
                  ))}
                </div>
              )}
            </div>

            {/* Recent Completions - split by status */}
            {recentCompleted.filter(h => h.status === 'done').length > 0 && (
              <JobHistory history={recentCompleted.filter(h => h.status === 'done')} title="Recent Completions" expanded={expandedJobs} onToggleId={toggleExpanded} onDelete={deleteJob} />
            )}
            {recentCompleted.filter(h => h.status === 'error').length > 0 && (
              <JobHistory history={recentCompleted.filter(h => h.status === 'error')} title="Failed Jobs" expanded={expandedJobs} onToggleId={toggleExpanded} onClear={() => clearHistory('error')} onDelete={deleteJob} onRetry={retryJob} />
            )}
          </div>
        )}
        {tab === 'settings' && <SettingsPanel settings={settings} onSave={saveSettings} />}
        {tab === 'history' && (
          <div className="space-y-8">
            {history.filter(h => h.status === 'done').length > 0 && (
              <JobHistory history={history.filter(h => h.status === 'done')} title="Completed Jobs" expanded={expandedJobs} onToggleId={toggleExpanded} onDelete={deleteJob} />
            )}
            {history.filter(h => h.status === 'error').length > 0 && (
              <JobHistory history={history.filter(h => h.status === 'error')} title="Failed Jobs" expanded={expandedJobs} onToggleId={toggleExpanded} onClear={() => clearHistory('error')} onDelete={deleteJob} onRetry={retryJob} />
            )}
            {history.length === 0 && (
              <div className="bg-white/[0.03] border border-white/5 rounded-xl p-12 text-center">
                <ClipboardList className="w-10 h-10 text-white/10 mx-auto mb-3" />
                <div className="text-white/30 text-sm">No job history yet.</div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
