// FILE: src/pages/SettingsPage.jsx
// ROLE: Platform settings page — profile, notifications, monitoring, appearance, and about

// What this page does:
//   - Profile section: displays user info from sessionStorage, allows editing display name & email
//   - Notifications section: toggle switches for email alerts, drift severity thresholds, digest frequency
//   - Monitoring section: polling interval, auto-remediation toggle, data retention settings
//   - Appearance section: theme toggle (light/dark — wired to data-theme attribute)
//   - About section: platform version, build info, links

import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import NavBar from '../components/NavBar'
import { useDashboard } from '../context/DashboardContext'
import './SettingsPage.css'

// ── Toggle Switch ────────────────────────────────────────────────────────────
function ToggleSwitch({ id, checked, onChange, disabled = false }) {
  return (
    <label className="sp-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="sp-toggle-input"
      />
      <span className="sp-toggle-track">
        <span className="sp-toggle-thumb" />
      </span>
    </label>
  )
}

// ── Setting Row ──────────────────────────────────────────────────────────────
function SettingRow({ icon, label, description, children }) {
  return (
    <div className="sp-setting-row">
      <div className="sp-setting-left">
        <span className="material-symbols-outlined sp-setting-icon">{icon}</span>
        <div>
          <div className="sp-setting-label">{label}</div>
          {description && <div className="sp-setting-desc">{description}</div>}
        </div>
      </div>
      <div className="sp-setting-right">
        {children}
      </div>
    </div>
  )
}

// ── Section Card ─────────────────────────────────────────────────────────────
function SectionCard({ icon, title, badge, children }) {
  return (
    <div className="sp-card">
      <div className="sp-card-header">
        <div className="sp-card-title-row">
          <span className="material-symbols-outlined sp-card-icon">{icon}</span>
          <h2 className="sp-card-title">{title}</h2>
          {badge && <span className="sp-card-badge">{badge}</span>}
        </div>
      </div>
      <div className="sp-card-body">
        {children}
      </div>
    </div>
  )
}

// ── Nav Item for left sidebar ────────────────────────────────────────────────
function SettingsNavItem({ icon, label, active, onClick }) {
  return (
    <button
      className={`sp-nav-item ${active ? 'sp-nav-item--active' : ''}`}
      onClick={onClick}
    >
      <span className="material-symbols-outlined">{icon}</span>
      {label}
    </button>
  )
}

const SECTIONS = [
  { key: 'profile',       label: 'Profile',        icon: 'person' },
  { key: 'notifications', label: 'Notifications',   icon: 'notifications' },
  { key: 'monitoring',    label: 'Monitoring',      icon: 'monitoring' },
  { key: 'appearance',    label: 'Appearance',      icon: 'palette' },
  { key: 'suppression',   label: 'Suppression Rules', icon: 'rule_folder' },
  { key: 'about',         label: 'About',           icon: 'info' },
]

export default function SettingsPage() {
  const navigate = useNavigate()
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  // Active section in the settings sidebar
  const [activeSection, setActiveSection] = useState('profile')

  // ── Profile state ────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState(user?.name || '')
  const [email, setEmail] = useState(user?.username || user?.email || '')
  const [profileSaved, setProfileSaved] = useState(false)

  // ── Notification preferences ─────────────────────────────────────────────
  const [emailAlerts, setEmailAlerts] = useState(true)
  const [criticalAlerts, setCriticalAlerts] = useState(true)
  const [highAlerts, setHighAlerts] = useState(true)
  const [mediumAlerts, setMediumAlerts] = useState(false)
  const [lowAlerts, setLowAlerts] = useState(false)
  const [digestFrequency, setDigestFrequency] = useState('daily')

  // ── Monitoring preferences ───────────────────────────────────────────────
  const [pollingInterval, setPollingInterval] = useState('30')
  const [autoRemediate, setAutoRemediate] = useState(false)
  const [retentionDays, setRetentionDays] = useState('90')

  // ── Appearance ───────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'light'
  )

  // ── Suppression Rules ────────────────────────────────────────────────────
  const [suppressionRules, setSuppressionRules] = useState([
    { id: 1, field: 'tags.environment', resourceType: 'All', reason: 'Controlled by external system' },
    { id: 2, field: 'properties.provisioningState', resourceType: 'All', reason: 'Transient state changes' }
  ])
  const [newRuleField, setNewRuleField] = useState('')
  const [newRuleReason, setNewRuleReason] = useState('')

  // Toggle dark/light theme
  const handleThemeChange = (newTheme) => {
    setTheme(newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
    try { sessionStorage.setItem('adip.theme', newTheme) } catch {}
  }

  // Load theme on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('adip.theme')
      if (saved) {
        setTheme(saved)
        document.documentElement.setAttribute('data-theme', saved)
      }
    } catch {}
  }, [])

  // Save profile
  const handleSaveProfile = () => {
    try {
      const updated = { ...user, name: displayName, email }
      sessionStorage.setItem('user', JSON.stringify(updated))
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 2500)
    } catch {}
  }

  // ── Feedback message ─────────────────────────────────────────────────────
  const [savedMessage, setSavedMessage] = useState(null)

  const handleSaveAll = () => {
    handleSaveProfile()
    setSavedMessage('Settings saved successfully.')
    setTimeout(() => setSavedMessage(null), 3000)
  }

  // Scroll to section
  const scrollToSection = (sectionKey) => {
    setActiveSection(sectionKey)
    const el = document.getElementById(`sp-section-${sectionKey}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="sp-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="sp-main">
        {/* Left sidebar nav */}
        <aside className="sp-sidebar">
          <div className="sp-sidebar-title">Settings</div>
          <nav className="sp-sidebar-nav">
            {SECTIONS.map(s => (
              <SettingsNavItem
                key={s.key}
                icon={s.icon}
                label={s.label}
                active={activeSection === s.key}
                onClick={() => scrollToSection(s.key)}
              />
            ))}
          </nav>
          <div className="sp-sidebar-footer">
            <button className="sp-save-btn" onClick={handleSaveAll}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>save</span>
              Save Changes
            </button>
          </div>
        </aside>

        {/* Right content area */}
        <div className="sp-content">
          {/* Success banner */}
          {savedMessage && (
            <div className="sp-alert sp-alert--success">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check_circle</span>
              {savedMessage}
            </div>
          )}

          {/* ── Profile Section ────────────────────────────────────────────── */}
          <div id="sp-section-profile">
            <SectionCard icon="person" title="Profile" badge="Account">
              <div className="sp-profile-header">
                <div className="sp-avatar-large">
                  {displayName?.charAt(0)?.toUpperCase() || 'U'}
                </div>
                <div className="sp-profile-info">
                  <div className="sp-profile-name">{displayName || 'User'}</div>
                  <div className="sp-profile-role">Platform Administrator</div>
                </div>
              </div>

              <div className="sp-form-grid">
                <div className="sp-form-field">
                  <label className="sp-form-label">Display Name</label>
                  <input
                    className="sp-input"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="Enter your display name"
                  />
                </div>
                <div className="sp-form-field">
                  <label className="sp-form-label">Email Address</label>
                  <input
                    className="sp-input"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="Enter your email"
                  />
                </div>
              </div>

              {profileSaved && (
                <div className="sp-inline-success">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
                  Profile updated
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Notifications Section ───────────────────────────────────────── */}
          <div id="sp-section-notifications">
            <SectionCard icon="notifications" title="Notifications" badge="Alerts">
              <SettingRow
                icon="email"
                label="Email Notifications"
                description="Receive drift alerts via email"
              >
                <ToggleSwitch id="email-alerts" checked={emailAlerts} onChange={setEmailAlerts} />
              </SettingRow>

              <div className="sp-setting-divider" />

              <div className="sp-setting-group-title">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>tune</span>
                Alert Severity Thresholds
              </div>

              <SettingRow icon="error" label="Critical Severity" description="Critical security changes (e.g. network ACLs removed)">
                <ToggleSwitch id="critical-alerts" checked={criticalAlerts} onChange={setCriticalAlerts} disabled={!emailAlerts} />
              </SettingRow>

              <SettingRow icon="warning" label="High Severity" description="High-impact drift (e.g. encryption or identity changes)">
                <ToggleSwitch id="high-alerts" checked={highAlerts} onChange={setHighAlerts} disabled={!emailAlerts} />
              </SettingRow>

              <SettingRow icon="info" label="Medium Severity" description="Moderate drift with 5+ field changes">
                <ToggleSwitch id="medium-alerts" checked={mediumAlerts} onChange={setMediumAlerts} disabled={!emailAlerts} />
              </SettingRow>

              <SettingRow icon="check_circle" label="Low Severity" description="Minor changes (tag edits, cosmetic diffs)">
                <ToggleSwitch id="low-alerts" checked={lowAlerts} onChange={setLowAlerts} disabled={!emailAlerts} />
              </SettingRow>

              <div className="sp-setting-divider" />

              <SettingRow icon="schedule" label="Digest Frequency" description="How often to bundle non-critical alerts">
                <select
                  className="sp-select"
                  value={digestFrequency}
                  onChange={e => setDigestFrequency(e.target.value)}
                  disabled={!emailAlerts}
                >
                  <option value="realtime">Real-time</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </SettingRow>
            </SectionCard>
          </div>

          {/* ── Monitoring Section ──────────────────────────────────────────── */}
          <div id="sp-section-monitoring">
            <SectionCard icon="monitoring" title="Monitoring" badge="Scan">
              <SettingRow icon="update" label="Polling Interval" description="How frequently to check resources for drift">
                <select
                  className="sp-select"
                  value={pollingInterval}
                  onChange={e => setPollingInterval(e.target.value)}
                >
                  <option value="10">Every 10 seconds</option>
                  <option value="30">Every 30 seconds</option>
                  <option value="60">Every minute</option>
                  <option value="300">Every 5 minutes</option>
                </select>
              </SettingRow>

              <div className="sp-setting-divider" />

              <SettingRow
                icon="auto_fix_high"
                label="Auto-Remediation"
                description="Automatically revert low-severity drift without approval"
              >
                <ToggleSwitch id="auto-remediate" checked={autoRemediate} onChange={setAutoRemediate} />
              </SettingRow>

              {autoRemediate && (
                <div className="sp-warning-banner">
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>warning</span>
                  <span>Auto-remediation will automatically revert low-severity changes. Use with caution in production environments.</span>
                </div>
              )}

              <div className="sp-setting-divider" />

              <SettingRow icon="delete_sweep" label="Data Retention" description="How long to keep drift records and change history">
                <select
                  className="sp-select"
                  value={retentionDays}
                  onChange={e => setRetentionDays(e.target.value)}
                >
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="365">1 year</option>
                </select>
              </SettingRow>
            </SectionCard>
          </div>

          {/* ── Appearance Section ──────────────────────────────────────────── */}
          <div id="sp-section-appearance">
            <SectionCard icon="palette" title="Appearance" badge="Theme">
              <div className="sp-theme-grid">
                <button
                  className={`sp-theme-card ${theme === 'light' ? 'sp-theme-card--active' : ''}`}
                  onClick={() => handleThemeChange('light')}
                >
                  <div className="sp-theme-preview sp-theme-preview--light">
                    <div className="sp-theme-preview-bar" />
                    <div className="sp-theme-preview-content">
                      <div className="sp-theme-preview-line sp-theme-preview-line--short" />
                      <div className="sp-theme-preview-line" />
                      <div className="sp-theme-preview-line sp-theme-preview-line--medium" />
                    </div>
                  </div>
                  <div className="sp-theme-label">
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>light_mode</span>
                    Light
                  </div>
                  {theme === 'light' && <span className="sp-theme-check material-symbols-outlined">check_circle</span>}
                </button>

                <button
                  className={`sp-theme-card ${theme === 'dark' ? 'sp-theme-card--active' : ''}`}
                  onClick={() => handleThemeChange('dark')}
                >
                  <div className="sp-theme-preview sp-theme-preview--dark">
                    <div className="sp-theme-preview-bar" />
                    <div className="sp-theme-preview-content">
                      <div className="sp-theme-preview-line sp-theme-preview-line--short" />
                      <div className="sp-theme-preview-line" />
                      <div className="sp-theme-preview-line sp-theme-preview-line--medium" />
                    </div>
                  </div>
                  <div className="sp-theme-label">
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>dark_mode</span>
                    Dark
                  </div>
                  {theme === 'dark' && <span className="sp-theme-check material-symbols-outlined">check_circle</span>}
                </button>
              </div>
            </SectionCard>
          </div>

          {/* ── Suppression Rules Section (Feature 12) ────────────────────── */}
          <div id="sp-section-suppression">
            <SectionCard icon="rule_folder" title="Drift Suppression Rules" badge="Rules">
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
                Fields matching these rules will be ignored during baseline comparison and will not trigger drift alerts. Useful for expected tagging changes or transient properties.
              </p>
              
              <div className="an-card-body an-card-body--table" style={{ border: '1px solid var(--border-light)', borderRadius: 8, overflow: 'hidden', marginBottom: 24 }}>
                <table className="an-table" style={{ margin: 0 }}>
                  <thead>
                    <tr><th>Field Path</th><th>Resource Type</th><th>Reason</th><th style={{width: 60}}>Action</th></tr>
                  </thead>
                  <tbody>
                    {suppressionRules.map(rule => (
                      <tr key={rule.id} className="an-tr">
                        <td style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-lighter)', padding: '2px 6px', borderRadius: 4, display: 'inline-block', margin: '8px' }}>{rule.field}</td>
                        <td className="an-td-type">{rule.resourceType}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{rule.reason}</td>
                        <td>
                          <button className="cp-toolbar-btn" onClick={() => setSuppressionRules(suppressionRules.filter(r => r.id !== rule.id))}>
                            <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#ef4444' }}>delete</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ background: 'var(--bg-lighter)', padding: 16, borderRadius: 8 }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: 14 }}>Add New Rule</h4>
                <div className="sp-form-grid" style={{ gap: 12 }}>
                  <div className="sp-form-field">
                    <label className="sp-form-label">Field Path (e.g. properties.networkAcls.defaultAction)</label>
                    <input className="sp-input" value={newRuleField} onChange={e => setNewRuleField(e.target.value)} placeholder="Path to suppress" />
                  </div>
                  <div className="sp-form-field">
                    <label className="sp-form-label">Reason</label>
                    <input className="sp-input" value={newRuleReason} onChange={e => setNewRuleReason(e.target.value)} placeholder="Why is this suppressed?" />
                  </div>
                </div>
                <button className="cp-btn cp-btn--secondary" style={{ marginTop: 12 }} onClick={() => {
                  if (newRuleField) {
                    setSuppressionRules([...suppressionRules, { id: Date.now(), field: newRuleField, resourceType: 'All', reason: newRuleReason || 'No reason provided' }])
                    setNewRuleField('')
                    setNewRuleReason('')
                  }
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span> Add Rule
                </button>
              </div>
            </SectionCard>
          </div>

          {/* ── About Section ───────────────────────────────────────────────── */}
          <div id="sp-section-about">
            <SectionCard icon="info" title="About" badge="System">
              <div className="sp-about-grid">
                <div className="sp-about-item">
                  <span className="sp-about-label">Platform</span>
                  <span className="sp-about-value">Azure Drift Intelligence Platform</span>
                </div>
                <div className="sp-about-item">
                  <span className="sp-about-label">Version</span>
                  <span className="sp-about-value">1.0.0</span>
                </div>
                <div className="sp-about-item">
                  <span className="sp-about-label">Build</span>
                  <span className="sp-about-value">2026.04.27</span>
                </div>
                <div className="sp-about-item">
                  <span className="sp-about-label">Backend</span>
                  <span className="sp-about-value">Express + Azure Functions</span>
                </div>
                <div className="sp-about-item">
                  <span className="sp-about-label">AI Engine</span>
                  <span className="sp-about-value">Azure OpenAI GPT-4o</span>
                </div>
                <div className="sp-about-item">
                  <span className="sp-about-label">Storage</span>
                  <span className="sp-about-value">Azure Blob + Table Storage</span>
                </div>
              </div>

              <div className="sp-about-footer">
                <span className="sp-about-credit">
                  Built by <strong>CloudThat</strong> — Enterprise Cloud Governance
                </span>
              </div>
            </SectionCard>
          </div>
        </div>
      </main>
    </div>
  )
}
