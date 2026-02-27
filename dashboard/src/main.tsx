import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL

function Root() {
  // If Convex URL is configured, wrap with ConvexProvider for real-time sync
  if (CONVEX_URL) {
    const { ConvexProvider } = require('convex/react')
    const { convex } = require('./convex')
    return (
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    )
  }

  // Default: no Convex needed — local file storage only
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
)
