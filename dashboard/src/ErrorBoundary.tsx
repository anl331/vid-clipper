import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  
  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#ff6b6b', background: '#0a0a0f', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h2>React Error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#fff', marginTop: 20 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#888', marginTop: 10, fontSize: 12 }}>
            {this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 20, padding: '8px 16px', background: '#333', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
