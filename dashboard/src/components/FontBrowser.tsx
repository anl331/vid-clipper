import { useState, useEffect } from 'react'
import { X, Download, Loader2, Search, Type } from 'lucide-react'

// Curated list of fonts that work great for video titles/captions
const GOOGLE_FONTS = [
  'Bebas Neue', 'Anton', 'Oswald', 'Barlow Condensed', 'Permanent Marker',
  'Russo One', 'Black Ops One', 'Bungee', 'Archivo Black', 'Alfa Slab One',
  'Staatliches', 'Big Shoulders Display', 'Ultra', 'Lilita One', 'Righteous',
  'Bangers', 'Rajdhani', 'Teko', 'Squada One', 'Six Caps',
  'Pathway Gothic One', 'Francois One', 'Carter One', 'Racing Sans One',
  'Saira Condensed', 'Kanit', 'Chakra Petch', 'Exo 2', 'Prompt', 'Boogaloo',
  'Paytone One', 'Fugaz One', 'Passion One', 'Graduate', 'Poller One',
]

const SAMPLE_TEXT = 'TRADE THE\nSETUP'

interface Props {
  onClose: () => void
  onSelect: (fontName: string, target: 'caption' | 'title' | 'both') => void
  downloadedFonts: string[] // displayNames already downloaded
}

export function FontBrowser({ onClose, onSelect, downloadedFonts }: Props) {
  const [search, setSearch] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set(downloadedFonts))
  const [loadedFonts, setLoadedFonts] = useState<Set<string>>(new Set())
  const [error, setError] = useState<Record<string, string>>({})

  const filtered = GOOGLE_FONTS.filter(f => f.toLowerCase().includes(search.toLowerCase()))

  // Load Google Fonts for preview via CSS injection (not local, just for browser rendering)
  useEffect(() => {
    const fontsToLoad = filtered.slice(0, 20) // load first 20 visible
    fontsToLoad.forEach(family => {
      if (loadedFonts.has(family)) return
      const id = `gfont-${family.replace(/\s+/g, '-')}`
      if (document.getElementById(id)) {
        setLoadedFonts(prev => new Set([...prev, family]))
        return
      }
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`
      link.onload = () => setLoadedFonts(prev => new Set([...prev, family]))
      document.head.appendChild(link)
    })
  }, [filtered.slice(0, 20).join(',')])

  const downloadFont = async (family: string, target: 'caption' | 'title' | 'both') => {
    setDownloading(family)
    setError(prev => ({ ...prev, [family]: '' }))
    try {
      const res = await fetch('/api/fonts/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ family }),
      })
      const data = await res.json()
      if (data.ok) {
        setDownloaded(prev => new Set([...prev, family]))
        onSelect(data.displayName, target)
      } else {
        setError(prev => ({ ...prev, [family]: data.error || 'Failed' }))
      }
    } catch {
      setError(prev => ({ ...prev, [family]: 'Network error' }))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-[#0a0a0f] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Type className="w-5 h-5 text-blue-400" />
            <h2 className="text-white font-semibold">Browse Google Fonts</h2>
            <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">{filtered.length} fonts</span>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-white/5 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search fonts..."
              autoFocus
              className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50"
            />
          </div>
        </div>

        {/* Font Grid */}
        <div className="overflow-y-auto flex-1 p-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {filtered.map(family => {
            const isDownloaded = downloaded.has(family)
            const isDownloading = downloading === family
            const fontErr = error[family]

            return (
              <div key={family} className="bg-white/[0.03] border border-white/5 rounded-xl p-4 flex flex-col gap-3 hover:border-white/15 transition-colors">
                {/* Font name */}
                <p className="text-xs text-white/40 font-medium">{family}</p>
                
                {/* Sample text preview */}
                <div className="flex-1 flex items-center justify-center py-2 min-h-[60px]">
                  <p
                    style={{ fontFamily: `"${family}", sans-serif`, lineHeight: 1.1 }}
                    className="text-white text-center text-lg font-bold uppercase whitespace-pre-line"
                  >
                    {SAMPLE_TEXT}
                  </p>
                </div>

                {fontErr && <p className="text-xs text-red-400">{fontErr}</p>}

                {/* Action buttons */}
                {isDownloaded ? (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => onSelect(family, 'caption')}
                      className="flex-1 py-1.5 text-xs bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors"
                    >
                      Caption
                    </button>
                    <button
                      onClick={() => onSelect(family, 'title')}
                      className="flex-1 py-1.5 text-xs bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors"
                    >
                      Title
                    </button>
                    <button
                      onClick={() => onSelect(family, 'both')}
                      className="flex-1 py-1.5 text-xs bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition-colors"
                    >
                      Both
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => downloadFont(family, 'caption')}
                      disabled={!!downloading}
                      className="flex-1 py-1.5 text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 disabled:opacity-40 transition-colors flex items-center justify-center gap-1"
                    >
                      {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      Caption
                    </button>
                    <button
                      onClick={() => downloadFont(family, 'title')}
                      disabled={!!downloading}
                      className="flex-1 py-1.5 text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 disabled:opacity-40 transition-colors flex items-center justify-center gap-1"
                    >
                      {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      Title
                    </button>
                    <button
                      onClick={() => downloadFont(family, 'both')}
                      disabled={!!downloading}
                      className="flex-1 py-1.5 text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 disabled:opacity-40 transition-colors flex items-center justify-center gap-1"
                    >
                      {isDownloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      Both
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
