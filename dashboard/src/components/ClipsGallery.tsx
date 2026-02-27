import type { ClipInfo } from '../types'
import { Film, Clock, HardDrive } from 'lucide-react'

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ClipsGallery({ clips }: { clips: ClipInfo[] }) {
  if (!clips.length) {
    return (
      <div className="bg-white/[0.03] border border-white/5 rounded-xl p-12 text-center">
        <Film className="w-10 h-10 text-white/10 mx-auto mb-3" />
        <div className="text-white/30 text-sm">No clips yet. Run the clipper to generate clips.</div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Film className="w-4 h-4" />
        Clips ({clips.length})
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clips.map((clip, i) => (
          <div key={i} className="bg-white/[0.03] border border-white/5 rounded-xl overflow-hidden group hover:border-white/10 transition-colors">
            <div className="aspect-[9/16] max-h-[360px] bg-black relative">
              <video
                src={`/api/clips/${clip.path ? clip.path.split('/clips/').pop() : encodeURIComponent(clip.filename)}`}
                controls
                preload="metadata"
                className="w-full h-full object-contain"
              />
              {/* Duration badge */}
              <div className="absolute bottom-2 right-2 bg-black/80 text-white/80 text-xs px-1.5 py-0.5 rounded font-mono pointer-events-none">
                {formatDuration(clip.duration)}
              </div>
            </div>
            <div className="p-3">
              <div className="text-sm font-medium text-white/80 truncate">{clip.title}</div>
              <div className="flex items-center gap-3 mt-1.5 text-xs text-white/30">
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(clip.duration)}</span>
                <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />{formatSize(clip.size_bytes)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
