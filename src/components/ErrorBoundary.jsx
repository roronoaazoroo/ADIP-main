// ============================================================
// FILE: src/components/ErrorBoundary.jsx
// ROLE: Catches render errors, shows fallback UI with retry
// ============================================================
import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.7)' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#ef4444' }}>error</span>
          <h3 style={{ margin: '12px 0 8px', color: '#fff' }}>Something went wrong</h3>
          <p style={{ fontSize: 13, marginBottom: 16 }}>{this.state.error?.message || 'An unexpected error occurred'}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
