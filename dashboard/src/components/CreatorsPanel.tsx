import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Users, Plus, Trash2, ExternalLink, Youtube, Tag, Loader2 } from 'lucide-react'

export function CreatorsPanel() {
  const creators = useQuery(api.creators.list, {})
  const addCreator = useMutation(api.creators.add)
  const removeCreator = useMutation(api.creators.remove)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newHandle, setNewHandle] = useState('')
  const [newChannelId, setNewChannelId] = useState('')
  const [newTags, setNewTags] = useState('')

  const handleAdd = async () => {
    if (!newName.trim() || !newHandle.trim()) return
    await addCreator({
      name: newName.trim(),
      youtubeHandle: newHandle.trim().startsWith('@') ? newHandle.trim() : `@${newHandle.trim()}`,
      channelId: newChannelId.trim() || undefined,
      tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
    })
    // Also save to local creators.json for the Python pipeline
    fetch('/api/creators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        creator: {
          name: newName.trim(),
          youtube_handle: newHandle.trim().startsWith('@') ? newHandle.trim() : `@${newHandle.trim()}`,
          channel_id: newChannelId.trim(),
          tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
        }
      }),
    })
    setNewName('')
    setNewHandle('')
    setNewChannelId('')
    setNewTags('')
    setAdding(false)
  }

  const handleRemove = async (handle: string) => {
    await removeCreator({ youtubeHandle: handle })
    fetch('/api/creators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', youtube_handle: handle }),
    })
  }

  const inputClass = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/50 transition-colors'

  if (creators === undefined) {
    return (
      <div className="flex items-center justify-center py-20 text-white/30">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider flex items-center gap-2">
          <Users className="w-4 h-4" />
          Tracked Creators ({creators.length})
        </h2>
        <button
          onClick={() => setAdding(!adding)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Creator
        </button>
      </div>

      {adding && (
        <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-white/30 mb-1">Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="TJR" className={inputClass} />
            </div>
            <div>
              <label className="block text-[10px] text-white/30 mb-1">YouTube Handle</label>
              <input value={newHandle} onChange={e => setNewHandle(e.target.value)} placeholder="@TJRTrades" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-white/30 mb-1">Channel ID (optional)</label>
              <input value={newChannelId} onChange={e => setNewChannelId(e.target.value)} placeholder="UCxxxxxxx" className={inputClass} />
            </div>
            <div>
              <label className="block text-[10px] text-white/30 mb-1">Tags (comma separated)</label>
              <input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="trading, forex, scalping" className={inputClass} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="px-3 py-1.5 text-xs text-white/30 hover:text-white/50 transition-colors">Cancel</button>
            <button onClick={handleAdd} disabled={!newName.trim() || !newHandle.trim()} className="px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-30 transition-colors">Add</button>
          </div>
        </div>
      )}

      {creators.length === 0 ? (
        <div className="bg-white/[0.03] border border-white/5 rounded-xl p-12 text-center">
          <Users className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <div className="text-white/30 text-sm">No creators tracked yet. Add creators to start monitoring their videos.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {creators.map(c => (
            <div key={c._id} className="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:border-white/10 transition-colors group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-red-500/10 flex items-center justify-center">
                    <Youtube className="w-4 h-4 text-red-400" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white/80">{c.name}</div>
                    <div className="text-xs text-white/30">{c.youtubeHandle}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a
                    href={`https://youtube.com/${c.youtubeHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-white/25 hover:text-white/60 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <button
                    onClick={() => handleRemove(c.youtubeHandle)}
                    className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-red-500/10 text-white/25 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {c.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {c.tags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.04] text-[10px] text-white/30">
                      <Tag className="w-2.5 h-2.5" />
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 text-[10px] text-white/15">
                {c.channelId && <span className="font-mono truncate">{c.channelId}</span>}
                {c.videosClipped !== undefined && c.videosClipped > 0 && (
                  <span>{c.videosClipped} videos clipped</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
