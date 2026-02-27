import { create } from 'zustand'

// UI-only store (expanded states, etc). Data comes from Convex hooks now.
interface UIStore {
  expandedJobs: Set<string>
  toggleExpanded: (id: string) => void
}

export const useUIStore = create<UIStore>((set) => ({
  expandedJobs: new Set<string>(),
  toggleExpanded: (id) => set((state) => {
    const next = new Set(state.expandedJobs)
    next.has(id) ? next.delete(id) : next.add(id)
    return { expandedJobs: next }
  }),
}))
