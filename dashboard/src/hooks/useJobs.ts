import { useEffect, useState, useCallback } from 'react'
import type { JobState, HistoryEntry } from '../types'

const HAS_CONVEX = !!(import.meta.env.VITE_CONVEX_URL)
const POLL_MS = 2000

function mapLocalJob(j: any): JobState {
  return {
    jobId: j.jobId || j.id,
    status: j.status,
    video_url: j.videoUrl || j.video_url,
    video_title: j.videoTitle || j.video_title,
    thumbnail: j.thumbnail,
    channel: j.channel,
    error: j.error,
    steps: j.steps || {},
    logs: (j.logs || []).map((l: any) => ({
      timestamp: l.ts || l.timestamp,
      level: l.level,
      message: l.msg || l.message,
    })),
    clips: (j.clips || []).map((c: any) => ({ ...c, size_bytes: c.sizeBytes ?? c.size_bytes })),
    isActive: j.status !== 'done' && j.status !== 'error' && j.status !== 'idle',
    settings: {},
  }
}

function mapLocalHistory(j: any): HistoryEntry {
  return {
    id: j.jobId || j.id,
    video_url: j.videoUrl || j.video_url || '',
    video_title: j.videoTitle || j.video_title || '',
    thumbnail: j.thumbnail,
    channel: j.channel,
    status: j.status,
    started_at: j.startedAt || j.started_at || '',
    ended_at: j.endedAt || j.ended_at,
    model: j.model || '',
    clips_count: j.clipsCount ?? (j.clips || []).length,
    clips: (j.clips || []).map((c: any) => ({ ...c, size_bytes: c.sizeBytes ?? c.size_bytes })),
    steps: j.steps || {},
    logs: (j.logs || []).map((l: any) => ({
      timestamp: l.ts || l.timestamp,
      level: l.level,
      message: l.msg || l.message,
    })),
  }
}

/** Local polling mode — no Convex needed */
function useLocalJobs() {
  const [allData, setAllData] = useState<any[]>([])

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs')
      if (r.ok) setAllData(await r.json())
    } catch {}
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  const activeJobs: JobState[] = allData
    .filter(j => j.status !== 'done' && j.status !== 'error' && j.status !== 'idle')
    .map(mapLocalJob)

  const history: HistoryEntry[] = allData
    .filter(j => j.status === 'done' || j.status === 'error')
    .map(mapLocalHistory)
    .sort((a, b) => (b.ended_at || b.started_at || '').localeCompare(a.ended_at || a.started_at || ''))

  const deleteJob = async (jobId: string, clips: any[], videoId?: string) => {
    await fetch('/api/delete-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, clips, videoId }),
    }).catch(() => {})
    setAllData(prev => prev.filter(j => (j.jobId || j.id) !== jobId))
  }

  const stopJob = async (jobId: string) => {
    await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).catch(() => {})
    setAllData(prev => prev.map(j =>
      (j.jobId || j.id) === jobId ? { ...j, status: 'error', error: 'Manually stopped' } : j
    ))
  }

  const clearHistory = async (status: string) => {
    await fetch('/api/history/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
    setAllData(prev => status === 'all'
      ? prev.filter(j => j.status !== 'done' && j.status !== 'error')
      : prev.filter(j => j.status !== status)
    )
  }

  const retryJob = async (url: string) => {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).catch(() => {})
  }

  return { activeJobs, history, deleteJob, stopJob, clearHistory, retryJob, hasConvex: false }
}

export { useLocalJobs, HAS_CONVEX, mapLocalJob, mapLocalHistory }
