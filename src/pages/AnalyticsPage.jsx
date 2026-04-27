// FILE: src/pages/AnalyticsPage.jsx
// ROLE: Drift Analytics & Insights — trend reports, impact analysis, prediction & forecasting

// Three tabs:
//   1. Drift Analysis & Trend Reports  — trend charts, severity breakdown, top drifted resources
//   2. Drift Impact Analysis            — impact scores, risk matrix, most impacted groups
//   3. Drift Prediction & Forecasting   — AI predictions, forecast chart, risk projections

import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import NavBar from '../components/NavBar'
import { useDashboard } from '../context/DashboardContext'
import ReportsDashboard from '../components/ReportsDashboard'
import ChangeAttribution from '../components/ChangeAttribution'
import './AnalyticsPage.css'

// ── Mock data generators ──────────────────────────────────────────────────────
function generateTrendData(days) {
  const data = []
  const now = Date.now()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000)
    data.push({
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      critical: Math.floor(Math.random() * 4),
      high: Math.floor(Math.random() * 8) + 1,
      medium: Math.floor(Math.random() * 15) + 3,
      low: Math.floor(Math.random() * 20) + 5,
    })
  }
  return data
}

const SEVERITY_DIST = [
  { label: 'Critical', count: 12, color: '#ef4444', pct: 8 },
  { label: 'High', count: 34, color: '#f97316', pct: 23 },
  { label: 'Medium', count: 58, color: '#f59e0b', pct: 39 },
  { label: 'Low', count: 45, color: '#10b981', pct: 30 },
]

const TOP_DRIFTED = [
  { name: 'prod-storage-acct', type: 'Microsoft.Storage/storageAccounts', group: 'rg-production', drifts: 23, severity: 'high', lastDrift: '2 hours ago' },
  { name: 'api-keyvault-01', type: 'Microsoft.KeyVault/vaults', group: 'rg-production', drifts: 18, severity: 'critical', lastDrift: '45 min ago' },
  { name: 'web-app-frontend', type: 'Microsoft.Web/sites', group: 'rg-frontend', drifts: 15, severity: 'medium', lastDrift: '1 hour ago' },
  { name: 'sql-db-analytics', type: 'Microsoft.Sql/servers', group: 'rg-data', drifts: 12, severity: 'high', lastDrift: '3 hours ago' },
  { name: 'nsg-backend-rules', type: 'Microsoft.Network/networkSecurityGroups', group: 'rg-network', drifts: 11, severity: 'critical', lastDrift: '30 min ago' },
  { name: 'cosmos-orders-db', type: 'Microsoft.DocumentDB/databaseAccounts', group: 'rg-data', drifts: 9, severity: 'medium', lastDrift: '5 hours ago' },
]

const IMPACT_METRICS = [
  { label: 'Resources Affected', value: '47', icon: 'dns', trend: '+12%', trendDir: 'up' },
  { label: 'Compliance Score', value: '73%', icon: 'verified', trend: '-8%', trendDir: 'down' },
  { label: 'Mean Time to Detect', value: '4.2m', icon: 'timer', trend: '-15%', trendDir: 'up' },
  { label: 'Auto-Remediated', value: '31', icon: 'auto_fix_high', trend: '+24%', trendDir: 'up' },
]

const RISK_GROUPS = [
  { name: 'rg-production', resources: 24, drifts: 41, risk: 'critical', score: 92 },
  { name: 'rg-network', resources: 12, drifts: 22, risk: 'high', score: 78 },
  { name: 'rg-data', resources: 18, drifts: 21, risk: 'high', score: 71 },
  { name: 'rg-frontend', resources: 15, drifts: 15, risk: 'medium', score: 55 },
  { name: 'rg-staging', resources: 20, drifts: 8, risk: 'low', score: 28 },
]

const CHANGE_TYPES = [
  { type: 'Network ACL Changes', count: 28, color: '#ef4444', impact: 'High' },
  { type: 'Encryption Config', count: 19, color: '#f97316', impact: 'High' },
  { type: 'Tag Modifications', count: 45, color: '#10b981', impact: 'Low' },
  { type: 'SKU / Tier Changes', count: 14, color: '#f59e0b', impact: 'Medium' },
  { type: 'Identity / RBAC', count: 11, color: '#ef4444', impact: 'Critical' },
]

const PREDICTIONS = [
  { resource: 'prod-storage-acct', type: 'Microsoft.Storage/storageAccounts', probability: 89, predictedTime: '~2 hours', reason: 'Recurring network ACL drift pattern detected every 6h', severity: 'high' },
  { resource: 'api-keyvault-01', type: 'Microsoft.KeyVault/vaults', probability: 76, predictedTime: '~4 hours', reason: 'Access policy modifications by CI/CD pipeline', severity: 'critical' },
  { resource: 'web-app-frontend', type: 'Microsoft.Web/sites', probability: 64, predictedTime: '~8 hours', reason: 'App settings frequently changed during deployments', severity: 'medium' },
  { resource: 'nsg-backend-rules', type: 'Microsoft.Network/networkSecurityGroups', probability: 58, predictedTime: '~12 hours', reason: 'Manual security rule edits by ops team', severity: 'high' },
]

const RECOMMENDATIONS = [
  { icon: 'lock', title: 'Lock Network ACLs on prod-storage-acct', desc: 'Apply Azure Policy deny effect to prevent unauthorized ACL changes. This single action would reduce 28% of critical drift.', priority: 'High' },
  { icon: 'policy', title: 'Enforce Key Vault access via ARM templates only', desc: 'CI/CD pipeline is modifying access policies directly. Route changes through IaC to maintain baseline consistency.', priority: 'Critical' },
  { icon: 'schedule', title: 'Schedule auto-remediation for low-severity drifts', desc: 'Enable auto-revert for tag modifications and cosmetic changes to reduce alert noise by ~40%.', priority: 'Medium' },
]

const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }
const SEV_BG = { critical: 'rgba(239,68,68,0.08)', high: 'rgba(249,115,22,0.08)', medium: 'rgba(245,158,11,0.08)', low: 'rgba(16,185,129,0.08)' }

// ── Mini Sparkline chart ──────────────────────────────────────────────────────
function Sparkline({ data, color = '#1995ff', height = 40, width = 120 }) {
  const max = Math.max(...data, 1)
  const points = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - (v / max) * (height - 4)}`).join(' ')
  return (
    <svg width={width} height={height} className="an-sparkline">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={(data.length - 1) / (data.length - 1) * width} cy={height - (data[data.length - 1] / max) * (height - 4)} r="3" fill={color} />
    </svg>
  )
}

// ── Area Chart (trend) ────────────────────────────────────────────────────────
function TrendAreaChart({ data, timeRange }) {
  const h = 220, w = 700
  const totalValues = data.map(d => d.critical + d.high + d.medium + d.low)
  const max = Math.max(...totalValues, 1)
  const stepX = w / (data.length - 1 || 1)

  const makePath = (getValue) => {
    return data.map((d, i) => `${i * stepX},${h - (getValue(d) / max) * (h - 20)}`).join(' ')
  }

  const layers = [
    { key: 'low', color: '#10b981', getValue: d => d.low + d.medium + d.high + d.critical },
    { key: 'medium', color: '#f59e0b', getValue: d => d.medium + d.high + d.critical },
    { key: 'high', color: '#f97316', getValue: d => d.high + d.critical },
    { key: 'critical', color: '#ef4444', getValue: d => d.critical },
  ]

  const labelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : 5

  return (
    <div className="an-trend-chart">
      <svg viewBox={`0 0 ${w} ${h + 30}`} preserveAspectRatio="none" className="an-trend-svg">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
          <line key={i} x1="0" y1={h - pct * (h - 20)} x2={w} y2={h - pct * (h - 20)} stroke="currentColor" strokeWidth="0.5" opacity="0.1" />
        ))}
        {/* Area layers */}
        {layers.map(layer => {
          const pts = makePath(layer.getValue)
          const areaPath = `M0,${h} L${pts} L${w},${h} Z`
          return <path key={layer.key} d={areaPath} fill={layer.color} opacity="0.15" />
        })}
        {/* Line layers */}
        {layers.map(layer => (
          <polyline key={layer.key + '-line'} points={makePath(layer.getValue)} fill="none" stroke={layer.color} strokeWidth="2" strokeLinejoin="round" />
        ))}
        {/* X labels */}
        {data.map((d, i) => i % labelEvery === 0 && (
          <text key={i} x={i * stepX} y={h + 22} textAnchor="middle" className="an-chart-label">{d.label}</text>
        ))}
      </svg>
    </div>
  )
}

// ── Severity Donut ────────────────────────────────────────────────────────────
function SeverityDonut({ data }) {
  const total = data.reduce((s, d) => s + d.count, 0)
  let cumulative = 0
  return (
    <div className="an-donut-wrap">
      <svg viewBox="0 0 36 36" width="140" height="140" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.06" />
        {data.map((d, i) => {
          const dash = (d.count / total) * 100
          const offset = 100 - cumulative
          cumulative += dash
          return <circle key={i} cx="18" cy="18" r="15.9" fill="none" stroke={d.color} strokeWidth="3"
            strokeDasharray={`${dash} ${100 - dash}`} strokeDashoffset={offset} strokeLinecap="round" />
        })}
      </svg>
      <div className="an-donut-center">
        <span className="an-donut-total">{total}</span>
        <span className="an-donut-sub">Total</span>
      </div>
    </div>
  )
}

// ── Risk Score Bar ─────────────────────────────────────────────────────────────
function RiskBar({ score, risk }) {
  const color = SEV_COLOR[risk] || '#94a3b8'
  return (
    <div className="an-risk-bar-wrap">
      <div className="an-risk-bar-track">
        <div className="an-risk-bar-fill" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="an-risk-score" style={{ color }}>{score}</span>
    </div>
  )
}

// ── Forecast Mini Chart ───────────────────────────────────────────────────────
function ForecastChart() {
  const historical = [12, 18, 15, 22, 19, 28, 24]
  const forecast = [24, 27, 31, 29, 35]
  const all = [...historical, ...forecast]
  const max = Math.max(...all, 1)
  const h = 160, w = 500
  const step = w / (all.length - 1)

  const histPts = historical.map((v, i) => `${i * step},${h - (v / max) * (h - 20)}`).join(' ')
  const forePts = forecast.map((v, i) => `${(historical.length - 1 + i) * step},${h - (v / max) * (h - 20)}`).join(' ')

  return (
    <div className="an-forecast-chart">
      <svg viewBox={`0 0 ${w} ${h + 10}`} preserveAspectRatio="none" className="an-forecast-svg">
        {[0, 0.5, 1].map((pct, i) => (
          <line key={i} x1="0" y1={h - pct * (h - 20)} x2={w} y2={h - pct * (h - 20)} stroke="currentColor" strokeWidth="0.5" opacity="0.08" />
        ))}
        {/* Forecast zone */}
        <rect x={(historical.length - 1) * step} y="0" width={w - (historical.length - 1) * step} height={h} fill="currentColor" opacity="0.03" rx="8" />
        <line x1={(historical.length - 1) * step} y1="0" x2={(historical.length - 1) * step} y2={h} stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" opacity="0.15" />
        {/* Historical line */}
        <polyline points={histPts} fill="none" stroke="#1995ff" strokeWidth="2.5" strokeLinejoin="round" />
        {/* Forecast line */}
        <polyline points={forePts} fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinejoin="round" strokeDasharray="6 4" />
        {/* Dots */}
        {historical.map((v, i) => (
          <circle key={i} cx={i * step} cy={h - (v / max) * (h - 20)} r="3" fill="#1995ff" />
        ))}
        {forecast.map((v, i) => (
          <circle key={i} cx={(historical.length - 1 + i) * step} cy={h - (v / max) * (h - 20)} r="3" fill="#f59e0b" stroke="#fff" strokeWidth="1.5" />
        ))}
      </svg>
      <div className="an-forecast-legend">
        <span className="an-forecast-legend-item"><span className="an-legend-line" style={{ background: '#1995ff' }} />Historical</span>
        <span className="an-forecast-legend-item"><span className="an-legend-line an-legend-line--dashed" style={{ background: '#f59e0b' }} />Predicted</span>
        <span className="an-forecast-zone-label">Forecast Zone →</span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'trends', label: 'Drift Analysis & Trends', icon: 'trending_up' },
  { key: 'impact', label: 'Drift Impact Analysis', icon: 'assessment' },
  { key: 'forecast', label: 'Prediction & Forecasting', icon: 'psychology' },
  { key: 'attribution', label: 'Change Attribution', icon: 'group' },
  { key: 'reports', label: 'Reports', icon: 'summarize' },
]

export default function AnalyticsPage() {
  const navigate = useNavigate()
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  const [activeTab, setActiveTab] = useState('trends')
  const [trendRange, setTrendRange] = useState('7d')

  // Active subscription ID for reports — uses context subscription
  const activeSubscriptionId = subscription || ''

  const trendData = useMemo(() => {
    const days = trendRange === '7d' ? 7 : trendRange === '30d' ? 30 : 90
    return generateTrendData(days)
  }, [trendRange])

  return (
    <div className="an-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="an-main">
        {/* Header */}
        <header className="an-header">
          <div>
            <h1 className="an-headline">Drift Analytics</h1>
            <p className="an-subline">Deep insights, trend analysis, and AI-powered drift forecasting</p>
          </div>
          <div className="an-header-badges">
            <span className="an-header-badge">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>update</span>
              Last updated: just now
            </span>
          </div>
        </header>

        {/* Tab bar */}
        <div className="an-tab-bar">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`an-tab-btn ${activeTab === tab.key ? 'an-tab-btn--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ═══ TAB 1: Drift Analysis & Trends ═══════════════════════════════ */}
        {activeTab === 'trends' && (
          <div className="an-tab-content" key="trends">
            {/* Trend chart */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">show_chart</span>
                  <h2 className="an-card-title">Drift Trend Over Time</h2>
                </div>
                <div className="an-range-btns">
                  {['7d', '30d', '90d'].map(r => (
                    <button key={r} className={`an-range-btn ${trendRange === r ? 'an-range-btn--active' : ''}`}
                      onClick={() => setTrendRange(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <div className="an-card-body">
                <TrendAreaChart data={trendData} timeRange={trendRange} />
                <div className="an-trend-legend">
                  {[{ label: 'Critical', color: '#ef4444' }, { label: 'High', color: '#f97316' },
                    { label: 'Medium', color: '#f59e0b' }, { label: 'Low', color: '#10b981' }].map(l => (
                    <span key={l.label} className="an-trend-legend-item">
                      <span className="an-legend-dot" style={{ background: l.color }} />{l.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="an-grid-2">
              {/* Severity distribution */}
              <div className="an-card">
                <div className="an-card-header">
                  <div className="an-card-title-row">
                    <span className="material-symbols-outlined an-card-icon">donut_large</span>
                    <h2 className="an-card-title">Severity Distribution</h2>
                  </div>
                </div>
                <div className="an-card-body an-severity-body">
                  <SeverityDonut data={SEVERITY_DIST} />
                  <div className="an-severity-list">
                    {SEVERITY_DIST.map(s => (
                      <div key={s.label} className="an-severity-row">
                        <span className="an-severity-dot" style={{ background: s.color }} />
                        <span className="an-severity-label">{s.label}</span>
                        <span className="an-severity-count">{s.count}</span>
                        <span className="an-severity-pct">{s.pct}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Drift by change type */}
              <div className="an-card">
                <div className="an-card-header">
                  <div className="an-card-title-row">
                    <span className="material-symbols-outlined an-card-icon">category</span>
                    <h2 className="an-card-title">Drift by Change Type</h2>
                  </div>
                </div>
                <div className="an-card-body">
                  {CHANGE_TYPES.map((ct, i) => (
                    <div key={i} className="an-change-row">
                      <div className="an-change-info">
                        <span className="an-change-name">{ct.type}</span>
                        <span className="an-change-impact" style={{ background: SEV_BG[ct.impact.toLowerCase()], color: SEV_COLOR[ct.impact.toLowerCase()] }}>{ct.impact}</span>
                      </div>
                      <div className="an-change-bar-wrap">
                        <div className="an-change-bar" style={{ width: `${(ct.count / 50) * 100}%`, background: ct.color }} />
                      </div>
                      <span className="an-change-count">{ct.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Top drifted resources */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">leaderboard</span>
                  <h2 className="an-card-title">Top Drifted Resources</h2>
                  <span className="an-card-badge">Top 6</span>
                </div>
              </div>
              <div className="an-card-body an-card-body--table">
                <table className="an-table">
                  <thead>
                    <tr>
                      <th>Resource</th><th>Type</th><th>Resource Group</th>
                      <th>Drift Count</th><th>Severity</th><th>Last Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TOP_DRIFTED.map((r, i) => (
                      <tr key={i} className="an-tr">
                        <td className="an-td-resource">{r.name}</td>
                        <td className="an-td-type">{r.type.split('/').pop()}</td>
                        <td>{r.group}</td>
                        <td><span className="an-drift-count">{r.drifts}</span></td>
                        <td>
                          <span className="an-sev-badge" style={{ background: SEV_BG[r.severity], color: SEV_COLOR[r.severity] }}>
                            {r.severity}
                          </span>
                        </td>
                        <td className="an-td-time">{r.lastDrift}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ═══ TAB 2: Drift Impact Analysis ═════════════════════════════════ */}
        {activeTab === 'impact' && (
          <div className="an-tab-content" key="impact">
            {/* Impact KPIs */}
            <div className="an-kpi-grid">
              {IMPACT_METRICS.map((m, i) => (
                <div key={i} className="an-kpi-card">
                  <div className="an-kpi-header">
                    <span className="an-kpi-label">{m.label}</span>
                    <span className="material-symbols-outlined an-kpi-icon">{m.icon}</span>
                  </div>
                  <div className="an-kpi-value-row">
                    <span className="an-kpi-value">{m.value}</span>
                    <span className={`an-kpi-trend an-kpi-trend--${m.trendDir}`}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                        {m.trendDir === 'up' ? 'trending_up' : 'trending_down'}
                      </span>
                      {m.trend}
                    </span>
                  </div>
                  <Sparkline data={Array.from({ length: 7 }, () => Math.floor(Math.random() * 30) + 5)}
                    color={m.trendDir === 'up' ? '#10b981' : '#ef4444'} />
                </div>
              ))}
            </div>

            <div className="an-grid-2">
              {/* Risk by resource group */}
              <div className="an-card">
                <div className="an-card-header">
                  <div className="an-card-title-row">
                    <span className="material-symbols-outlined an-card-icon">shield</span>
                    <h2 className="an-card-title">Risk by Resource Group</h2>
                  </div>
                </div>
                <div className="an-card-body">
                  {RISK_GROUPS.map((rg, i) => (
                    <div key={i} className="an-risk-row">
                      <div className="an-risk-info">
                        <span className="an-risk-name">{rg.name}</span>
                        <span className="an-risk-meta">{rg.resources} resources · {rg.drifts} drifts</span>
                      </div>
                      <RiskBar score={rg.score} risk={rg.risk} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Change velocity */}
              <div className="an-card">
                <div className="an-card-header">
                  <div className="an-card-title-row">
                    <span className="material-symbols-outlined an-card-icon">speed</span>
                    <h2 className="an-card-title">Change Velocity</h2>
                  </div>
                </div>
                <div className="an-card-body">
                  <div className="an-velocity-grid">
                    <div className="an-velocity-item">
                      <span className="an-velocity-value">8.3</span>
                      <span className="an-velocity-label">Changes / Hour</span>
                      <span className="an-velocity-sub">Peak: 23.1 at 14:00</span>
                    </div>
                    <div className="an-velocity-item">
                      <span className="an-velocity-value">149</span>
                      <span className="an-velocity-label">Changes Today</span>
                      <span className="an-velocity-sub">vs 112 yesterday</span>
                    </div>
                    <div className="an-velocity-item">
                      <span className="an-velocity-value">2.4x</span>
                      <span className="an-velocity-label">Week-over-Week</span>
                      <span className="an-velocity-sub">Acceleration rate</span>
                    </div>
                    <div className="an-velocity-item">
                      <span className="an-velocity-value">18m</span>
                      <span className="an-velocity-label">Avg. Fix Time</span>
                      <span className="an-velocity-sub">Down from 32m</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Impact heatmap */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">grid_on</span>
                  <h2 className="an-card-title">Drift Frequency Heatmap</h2>
                  <span className="an-card-badge">Last 7 days</span>
                </div>
              </div>
              <div className="an-card-body">
                <div className="an-heatmap">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, di) => (
                    <div key={day} className="an-heatmap-row">
                      <span className="an-heatmap-day">{day}</span>
                      {Array.from({ length: 24 }, (_, hi) => {
                        const val = Math.floor(Math.random() * 10)
                        const opacity = val === 0 ? 0.03 : Math.min(val / 10, 1)
                        const bg = val > 7 ? '#ef4444' : val > 4 ? '#f59e0b' : '#1995ff'
                        return <div key={hi} className="an-heatmap-cell" style={{ background: bg, opacity }} title={`${day} ${hi}:00 — ${val} drifts`} />
                      })}
                    </div>
                  ))}
                  <div className="an-heatmap-hours">
                    <span />
                    {[0, 3, 6, 9, 12, 15, 18, 21].map(h => <span key={h} className="an-heatmap-hour">{h}:00</span>)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ TAB 3: Prediction & Forecasting ══════════════════════════════ */}
        {activeTab === 'forecast' && (
          <div className="an-tab-content" key="forecast">
            {/* AI insight banner */}
            <div className="an-ai-banner">
              <span className="material-symbols-outlined an-ai-icon">psychology</span>
              <div className="an-ai-banner-content">
                <h3 className="an-ai-banner-title">AI-Powered Drift Prediction</h3>
                <p className="an-ai-banner-desc">
                  Based on 30-day historical patterns, our model predicts a <strong>33% increase</strong> in drift events this week.
                  Key drivers: scheduled maintenance windows and CI/CD pipeline deployments.
                </p>
              </div>
            </div>

            {/* Forecast chart */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">auto_graph</span>
                  <h2 className="an-card-title">7-Day Drift Forecast</h2>
                  <span className="an-card-badge an-card-badge--ai">
                    <span className="material-symbols-outlined" style={{ fontSize: 12 }}>smart_toy</span>AI Model
                  </span>
                </div>
              </div>
              <div className="an-card-body">
                <ForecastChart />
              </div>
            </div>

            {/* Predictions table */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">warning</span>
                  <h2 className="an-card-title">High-Risk Drift Predictions</h2>
                </div>
              </div>
              <div className="an-card-body">
                <div className="an-predictions">
                  {PREDICTIONS.map((p, i) => (
                    <div key={i} className="an-prediction-card">
                      <div className="an-prediction-header">
                        <div className="an-prediction-resource">
                          <span className="an-prediction-name">{p.resource}</span>
                          <span className="an-prediction-type">{p.type.split('/').pop()}</span>
                        </div>
                        <span className="an-sev-badge" style={{ background: SEV_BG[p.severity], color: SEV_COLOR[p.severity] }}>
                          {p.severity}
                        </span>
                      </div>
                      <div className="an-prediction-body">
                        <div className="an-prediction-prob">
                          <div className="an-prob-ring">
                            <svg viewBox="0 0 36 36" width="54" height="54">
                              <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.08" />
                              <circle cx="18" cy="18" r="15.9" fill="none" stroke={SEV_COLOR[p.severity]} strokeWidth="3"
                                strokeDasharray={`${p.probability} ${100 - p.probability}`} strokeDashoffset="25"
                                strokeLinecap="round" style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }} />
                            </svg>
                            <span className="an-prob-value">{p.probability}%</span>
                          </div>
                          <span className="an-prob-label">Probability</span>
                        </div>
                        <div className="an-prediction-details">
                          <p className="an-prediction-reason">{p.reason}</p>
                          <span className="an-prediction-time">
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>schedule</span>
                            Expected in {p.predictedTime}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Recommendations */}
            <div className="an-card an-card--full">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">lightbulb</span>
                  <h2 className="an-card-title">AI Recommendations</h2>
                </div>
              </div>
              <div className="an-card-body">
                <div className="an-recommendations">
                  {RECOMMENDATIONS.map((rec, i) => (
                    <div key={i} className="an-rec-card">
                      <div className="an-rec-icon-wrap">
                        <span className="material-symbols-outlined">{rec.icon}</span>
                      </div>
                      <div className="an-rec-content">
                        <div className="an-rec-header">
                          <h4 className="an-rec-title">{rec.title}</h4>
                          <span className="an-sev-badge" style={{ background: SEV_BG[rec.priority.toLowerCase()], color: SEV_COLOR[rec.priority.toLowerCase()] }}>
                            {rec.priority}
                          </span>
                        </div>
                        <p className="an-rec-desc">{rec.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ TAB: Change Attribution (Feature 11) ══════════════════════════ */}
        {activeTab === 'attribution' && (
          <div className="an-tab-content" key="attribution">
            <ChangeAttribution subscriptionId={activeSubscriptionId} />
          </div>
        )}

        {/* ═══ TAB 4: Reports ═══════════════════════════════════════════ */}
        {activeTab === 'reports' && (
          <div className="an-tab-content" key="reports">
            <ReportsDashboard subscriptionId={activeSubscriptionId} />
          </div>
        )}
      </main>
    </div>
  )
}
