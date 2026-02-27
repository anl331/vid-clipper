import { useEffect, useRef } from 'react'
import type { LogEntry } from '../types'
import { Terminal } from 'lucide-react'

export function LogsPanel({ logs, maxHeight = '400px' }: { logs: LogEntry[]; maxHeight?: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  const levelColor: Record<string, string> = {
    INFO: 'text-blue-400',
    WARNING: 'text-yellow-400',
    ERROR: 'text-red-400',
    DEBUG: 'text-white/30',
  }

  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-xl p-5 flex flex-col">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Terminal className="w-4 h-4" />
        Logs <span className="text-white/20 font-normal">({logs.length})</span>
      </h2>
      <div className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 bg-black/30 rounded-lg p-3" style={{ maxHeight }}>
        {logs.length === 0 && <div className="text-white/20 text-center py-8">No logs yet</div>}
        {logs.map((l, i) => (
          <div key={i} className="flex gap-2 leading-5 hover:bg-white/[0.02] px-1 -mx-1 rounded transition-colors">
            <span className="text-white/15 shrink-0">
              {new Date(l.timestamp).toLocaleTimeString()}
            </span>
            <span className={`shrink-0 w-12 ${levelColor[l.level] || 'text-white/40'}`}>
              {l.level}
            </span>
            <span className="text-white/70">{l.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
