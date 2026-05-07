// ============================================================
// FILE: src/pages/LoginPage.jsx
// ROLE: Authentication — Sign In / Join Org (invite code + OTP) / Create Org (OTP)
// ============================================================
import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import ctMsLogo from '../assets/ct-logo-x-ms.png'
import { loginUser, createOrganization, joinOrganization, sendOtp, verifyOtp } from '../services/authService'
import './LoginPage.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [authMode, setAuthMode] = useState('joinOrg') // 'login' | 'createOrg' | 'joinOrg'
  const [step, setStep] = useState('form') // 'form' | 'otp' | 'orgConfig'

  // Form fields
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [name, setName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [otpCode, setOtpCode] = useState('')

  // Org config fields (create org step 2)
  const [organizationName, setOrganizationName] = useState('')
  const [subscriptionId, setSubscriptionId] = useState('')
  const [retentionDays, setRetentionDays] = useState(30)
  const [requiredApprovals, setRequiredApprovals] = useState(2)
  const [allowedDomain, setAllowedDomain] = useState('')

  // Invite code shown after org creation
  const [createdInviteCode, setCreatedInviteCode] = useState(null)

  const emailRef = useRef(null)
  const otpRef = useRef(null)

  useEffect(() => { if (step === 'form') emailRef.current?.focus() }, [step, authMode])
  useEffect(() => { if (step === 'otp') otpRef.current?.focus() }, [step])

  const dismissError = () => setError(null)

  // Step 1: Send OTP
  const handleSendOtp = async () => {
    setError(null)
    if (!email.trim()) { setError('Please enter your email.'); return }
    if (authMode !== 'login' && !password) { setError('Please enter a password.'); return }
    if (authMode !== 'login' && password.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (authMode === 'joinOrg' && !inviteCode.trim()) { setError('Please enter the invite code.'); return }
    if (authMode === 'createOrg' && !name.trim()) { setError('Please enter your name.'); return }

    setIsLoading(true)
    try {
      await sendOtp(email.trim().toLowerCase())
      setStep('otp')
    } catch (err) { setError(err.message) }
    finally { setIsLoading(false) }
  }

  // Step 2: Verify OTP then complete action
  const handleVerifyAndComplete = async () => {
    setError(null)
    if (!otpCode || otpCode.length < 6) { setError('Please enter the 6-digit code.'); return }

    setIsLoading(true)
    try {
      await verifyOtp(email.trim().toLowerCase(), otpCode)

      if (authMode === 'joinOrg') {
        const result = await joinOrganization({ inviteCode: inviteCode.trim().toUpperCase(), email: email.trim().toLowerCase(), password })
        sessionStorage.setItem('user', JSON.stringify({ name: result.name, username: result.email || email, email: result.email || email, role: result.role, orgId: result.orgId }))
        navigate('/dashboard')
      } else if (authMode === 'createOrg') {
        setStep('orgConfig')
      }
    } catch (err) { setError(err.message) }
    finally { setIsLoading(false) }
  }

  // Step 3 (create org only): Complete org creation
  const handleCreateOrg = async () => {
    setError(null)
    if (!organizationName || !subscriptionId) { setError('Organization name and subscription ID are required.'); return }

    setIsLoading(true)
    try {
      const result = await createOrganization({
        organizationName, name, email: email.trim().toLowerCase(), password,
        subscriptionId, retentionDays, requiredApprovals, allowedDomain,
      })
      setCreatedInviteCode(result.inviteCode)
      sessionStorage.setItem('user', JSON.stringify({ name: result.organizationName, username: email, email, role: result.role, orgId: result.orgId }))
    } catch (err) { setError(err.message) }
    finally { setIsLoading(false) }
  }

  // Login (no OTP needed for returning users)
  const handleLogin = async () => {
    setError(null)
    if (!email.trim() || !password) { setError('Email and password required.'); return }
    setIsLoading(true)
    try {
      const result = await loginUser({ email: email.trim().toLowerCase(), password })
      sessionStorage.setItem('user', JSON.stringify({ name: result.name, username: result.email || email, email: result.email || email, role: result.role, orgId: result.orgId }))
      navigate('/dashboard')
    } catch (err) { setError(err.message) }
    finally { setIsLoading(false) }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (authMode === 'login') handleLogin()
    else if (step === 'form') handleSendOtp()
    else if (step === 'otp') handleVerifyAndComplete()
    else if (step === 'orgConfig') handleCreateOrg()
  }

  // After org creation — show invite code
  if (createdInviteCode) {
    return (
      <div className="login-page">
        <div className="login-bg" aria-hidden="true"><div className="login-bg-gradient" /><div className="login-bg-grid" /></div>
        <div className="login-content">
          <div className="login-card" role="main">
            <div className="login-card-header">
              <h1 className="login-title">Organization Created!</h1>
              <p className="login-subtitle">Share this invite code with your team members</p>
            </div>
            <div style={{ background: 'rgba(0,96,169,0.08)', border: '1px solid rgba(0,96,169,0.2)', borderRadius: 12, padding: '20px', textAlign: 'center', margin: '20px 0' }}>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 4, color: '#fff', fontFamily: 'monospace' }}>{createdInviteCode}</div>
              <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 8 }}>Team members use this code to join your organization</p>
            </div>
            <button className="login-btn" onClick={() => navigate('/dashboard')}>Continue to Dashboard</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden="true">
        <div className="login-bg-gradient" />
        <div className="login-bg-grid" />
        <div className="login-bubbles">
          {Array.from({ length: 15 }).map((_, i) => (
            <span key={i} className="login-bubble" />
          ))}
        </div>
      </div>

      <div className="login-content">
        <div className="login-logos-bar">
          <img src={ctMsLogo} alt="CloudThat × Microsoft" style={{ height: 32 }} />
        </div>

        <div className="login-card" role="main">
          <div className="login-card-glow" />

          <div className="login-card-header">
            <h1 className="login-title">
              {authMode === 'login' ? 'Sign In' : authMode === 'createOrg' ? 'Create Organization' : 'Join Organization'}
            </h1>
            <p className="login-subtitle">
              {step === 'otp' ? `Enter the verification code sent to ${email}` :
               step === 'orgConfig' ? 'Configure your organization' :
               authMode === 'login' ? 'Sign in with your credentials' :
               authMode === 'joinOrg' ? 'Enter your invite code and email to get started' :
               'Set up your organization on ADIP'}
            </p>
          </div>

          {error && (
            <div className="login-error" role="alert">
              <span>{error}</span>
              <button className="login-error-dismiss" onClick={dismissError} aria-label="Dismiss">✕</button>
            </div>
          )}

          <form className="login-fields" onSubmit={handleSubmit} noValidate>
            {/* OTP Step */}
            {step === 'otp' && (
              <div className="login-field-wrap">
                <input ref={otpRef} type="text" className="login-input" placeholder="Enter 6-digit code"
                  value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6} autoComplete="one-time-code" disabled={isLoading}
                  style={{ textAlign: 'center', fontSize: 20, letterSpacing: 8, fontWeight: 700 }} />
              </div>
            )}

            {/* Org Config Step */}
            {step === 'orgConfig' && (
              <>
                <div className="login-field-wrap">
                  <input type="text" className="login-input" placeholder="Organization Name" value={organizationName} onChange={e => setOrganizationName(e.target.value)} disabled={isLoading} />
                </div>
                <div className="login-field-wrap">
                  <input type="text" className="login-input" placeholder="Azure Subscription ID" value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} disabled={isLoading} />
                </div>
                <div className="login-field-wrap">
                  <input type="text" className="login-input" placeholder="Allowed email domain (optional, e.g. cloudthat.com)" value={allowedDomain} onChange={e => setAllowedDomain(e.target.value)} disabled={isLoading} />
                </div>
                <div className="login-field-wrap" style={{ display: 'flex', gap: 8 }}>
                  <select className="login-input" value={retentionDays} onChange={e => setRetentionDays(Number(e.target.value))} disabled={isLoading}>
                    <option value={30}>30 days retention</option>
                    <option value={60}>60 days retention</option>
                    <option value={90}>90 days retention</option>
                    <option value={365}>365 days retention</option>
                  </select>
                  <select className="login-input" value={requiredApprovals} onChange={e => setRequiredApprovals(Number(e.target.value))} disabled={isLoading}>
                    <option value={1}>1 approval</option>
                    <option value={2}>2 approvals</option>
                    <option value={3}>3 approvals</option>
                  </select>
                </div>
              </>
            )}

            {/* Main Form Step */}
            {step === 'form' && (
              <>
                {authMode === 'createOrg' && (
                  <div className="login-field-wrap">
                    <input type="text" className="login-input" placeholder="Your Full Name" value={name} onChange={e => setName(e.target.value)} disabled={isLoading} />
                  </div>
                )}
                {authMode === 'joinOrg' && (
                  <div className="login-field-wrap">
                    <input type="text" className="login-input" placeholder="Invite Code (e.g. ADIP-7F3A)" value={inviteCode} onChange={e => setInviteCode(e.target.value.toUpperCase())} disabled={isLoading} />
                  </div>
                )}
                <div className="login-field-wrap">
                  <input ref={emailRef} type="email" className="login-input" placeholder="Work Email" value={email} onChange={e => setEmail(e.target.value)} disabled={isLoading} autoComplete="email" />
                </div>
                <div className="login-field-wrap">
                  <input type={showPass ? 'text' : 'password'} className="login-input" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} disabled={isLoading} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
                </div>
              </>
            )}

            <button type="submit" className={`login-btn ${isLoading ? 'login-btn-loading' : ''}`} disabled={isLoading}>
              {isLoading ? <><div className="login-btn-spinner" /><span>Please wait...</span></> : (
                step === 'otp' ? 'Verify Code' :
                step === 'orgConfig' ? 'Create Organization' :
                authMode === 'login' ? 'Sign In' :
                'Send Verification Code'
              )}
            </button>
          </form>

          {/* Resend OTP */}
          {step === 'otp' && (
            <button type="button" className="login-btn-secondary" onClick={() => { setOtpCode(''); handleSendOtp() }} disabled={isLoading}>
              Resend Code
            </button>
          )}

          {/* Mode switcher — only on form step */}
          {step === 'form' && (
            <div style={{ display: 'flex', gap: 12, marginTop: 16, width: '100%', justifyContent: 'center' }}>
              {authMode === 'joinOrg' && (
                <>
                  <button type="button" className="login-btn-secondary" onClick={() => { setAuthMode('login'); setError(null) }}>Already a member? Sign In</button>
                  <button type="button" className="login-btn-secondary" onClick={() => { setAuthMode('createOrg'); setError(null) }}>Create Organization</button>
                </>
              )}
              {authMode === 'login' && (
                <button type="button" className="login-btn-secondary" onClick={() => { setAuthMode('joinOrg'); setError(null) }}>← Back</button>
              )}
              {authMode === 'createOrg' && (
                <button type="button" className="login-btn-secondary" onClick={() => { setAuthMode('joinOrg'); setError(null) }}>← Back</button>
              )}
            </div>
          )}

          {/* Back from OTP/config */}
          {step !== 'form' && (
            <button type="button" className="login-btn-secondary" style={{ marginTop: 12 }}
              onClick={() => { setStep('form'); setOtpCode(''); setError(null) }}>
              ← Back
            </button>
          )}

          <p className="login-footer-text">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Secured by Azure Communication Services
          </p>
        </div>
      </div>
    </div>
  )
}
