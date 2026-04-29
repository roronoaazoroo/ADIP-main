import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import ctMsLogo from '../assets/ct-logo-x-ms.png'
import { isSSOConfigured, getDemoUser } from '../services/auth'
import './LoginPage.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState(null)
  const [username, setUsername]   = useState('')
  const [password, setPassword]   = useState('')
  const [showPass, setShowPass]   = useState(false)
  const usernameRef = useRef(null)
  const errorRef = useRef(null)


// Dummy credentials — replace with real auth in production
const DUMMY_USERS = [
  { username: 'saksham', password: 'Admin@123', name: 'Saksham Midha',      email: 'saksham@cloudthat.com' },
  { username: 'rounak',  password: 'Admin@123', name: 'Rounak Chandrakar',  email: 'rounak@cloudthat.com' },
  { username: 'ravi',    password: 'Admin@123', name: 'Ravi Davadra',       email: 'ravi@cloudthat.com' },
]

  // Auto-focus username field on mount
  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  // Move focus to error message when it appears (screen reader announcement)
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.focus()
    }
  }, [error])


  /**
   * Handle Microsoft Sign-In.

   * When SSO is configured (VITE_AZURE_CLIENT_ID + VITE_AZURE_TENANT_ID set),
   * this will use MSAL to authenticate via Azure AD popup.
   
   * In demo mode (no env vars), it navigates directly to dashboard.
   
   * To enable real SSO:
   * 1. npm install @azure/msal-browser
   * 2. Set VITE_AZURE_CLIENT_ID and VITE_AZURE_TENANT_ID in .env
   * 3. Uncomment the MSAL code in services/api.js
   * 4. Replace the demo branch below with:
   
   *    import { msalInstance, loginWithMicrosoft } from '../services/api'
   *    const result = await loginWithMicrosoft()
   *    // Store account info in context/state
   *    navigate('/home')*/
   
  const handleLogin = () => {
    setError(null)
    if (!username.trim()) { setError('Please enter your username.'); return }
    if (!password) { setError('Please enter your password.'); return }
    
    setIsLoading(true)
    
    // Simulate network delay for perceived performance
    setTimeout(() => {
      const user = DUMMY_USERS.find(u => u.username === username.trim().toLowerCase() && u.password === password)
      if (!user) {
        setError('Invalid username or password. Please try again.')
        setIsLoading(false)
        return
      }
      sessionStorage.setItem('user', JSON.stringify(user))
      navigate('/dashboard')
    }, 600)
  }

  const dismissError = () => setError(null)

  return (
    <div className="login-page">
      {/* Animated background */}
      <div className="login-bg" aria-hidden="true">
        <div className="login-bg-gradient" />
        <div className="login-bg-grid" />
        {/* Floating particles */}
        {[...Array(20)].map((_, i) => (
          <div
            key={i}
            className="login-particle"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              width: `${Math.random() * 4 + 2}px`,
              height: `${Math.random() * 4 + 2}px`,
              animationDelay: `${Math.random() * 8}s`,
              animationDuration: `${Math.random() * 10 + 8}s`,
            }}
          />
        ))}
        {/* Floating cloud shapes */}
        <div className="login-cloud login-cloud-1" />
        <div className="login-cloud login-cloud-2" />
        <div className="login-cloud login-cloud-3" />
      </div>

      {/* Main content */}
      <div className="login-content">
        {/* Logos bar */}
        <div className="login-logos-bar">
          <img src={ctMsLogo} alt="CloudThat x Microsoft" style={{ height: 48, objectFit: 'contain' }} />
        </div>

        {/* Login card */}
        <div className="login-card" role="main">
          <div className="login-card-glow" />
          
          {/* Card header */}
          <div className="login-card-header">
            <div className="login-icon-ring">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <h1 className="login-title">Azure Drift Intelligence</h1>
            <p className="login-subtitle">Configuration drift detection & monitoring platform</p>
          </div>

          {/* Info badges */}
          <div className="login-badges" aria-label="Platform features">
            <div className="login-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>Real-time Monitoring</span>
            </div>
            <div className="login-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span>Enterprise Security</span>
            </div>
            <div className="login-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              <span>Drift Analytics</span>
            </div>
          </div>

          {/* Error message — with dismiss and screen reader announcement */}
          {error && (
            <div
              className="login-error"
              role="alert"
              aria-live="assertive"
              ref={errorRef}
              tabIndex={-1}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span>{error}</span>
              <button 
                className="login-error-dismiss"
                onClick={dismissError}
                aria-label="Dismiss error"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* Username & Password fields — proper form with labels */}
          <form className="login-fields" onSubmit={(e) => { e.preventDefault(); handleLogin(); }} noValidate>
            <div className="login-field-wrap">
              <label htmlFor="login-username" className="sr-only">Username</label>
              <div className="login-input-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <input
                id="login-username"
                ref={usernameRef}
                type="text"
                className="login-input login-input--with-icon"
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                aria-required="true"
                aria-invalid={error && !username ? 'true' : undefined}
                disabled={isLoading}
              />
            </div>
            <div className="login-field-wrap">
              <label htmlFor="login-password" className="sr-only">Password</label>
              <div className="login-input-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <input
                id="login-password"
                type={showPass ? 'text' : 'password'}
                className="login-input login-input--with-icon login-input--password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-required="true"
                aria-invalid={error && !password ? 'true' : undefined}
                disabled={isLoading}
              />
              <button
                type="button"
                className="login-pass-toggle"
                onClick={() => setShowPass(p => !p)}
                aria-label={showPass ? 'Hide password' : 'Show password'}
                tabIndex={0}
              >
                {showPass
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>

            {/* Login button */}
            <button
              type="submit"
              className={`login-btn ${isLoading ? 'login-btn-loading' : ''}`}
              disabled={isLoading}
              id="login-button"
              aria-busy={isLoading}
            >
              {isLoading ? (
                <>
                  <div className="login-btn-spinner" aria-hidden="true" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <svg width="20" height="20" viewBox="0 0 21 21" fill="none" aria-hidden="true">
                    <rect x="0" y="0" width="10" height="10" fill="#f25022" />
                    <rect x="11" y="0" width="10" height="10" fill="#7fba00" />
                    <rect x="0" y="11" width="10" height="10" fill="#00a4ef" />
                    <rect x="11" y="11" width="10" height="10" fill="#ffb900" />
                  </svg>
                  <span>Sign In</span>
                  <svg className="login-btn-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <p className="login-footer-text">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Secured by Azure Active Directory
          </p>
        </div>

       
      
       
      </div>
    </div>
  )
}
