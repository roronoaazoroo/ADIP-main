// FILE: src/pages/AnalyticsPage.jsx
// ROLE: Drift Analytics & Insights — trend reports, impact analysis, prediction & forecasting

// Three tabs:
//   1. Drift Analysis & Trend Reports  — trend charts, severity breakdown, top drifted resources
//   2. Drift Impact Analysis            — impact scores, risk matrix, most impacted groups
//   3. Drift Prediction & Forecasting   — AI predictions, forecast chart, risk projections

import React, { useState } from 'react'
import RgDriftPrediction from '../components/RgDriftPrediction'
import DriftForecastChart from '../components/DriftForecastChart'
import NavBar from '../components/NavBar'
import { useDashboard } from '../context/DashboardContext'
import ReportsDashboard from '../components/ReportsDashboard'
import DriftImpactDashboard from '../components/DriftImpactDashboard'
import TopChangers from '../components/TopChangers'
import CostImpactDashboard from '../components/CostImpactDashboard'
import './AnalyticsPage.css'

// MAIN PAGE COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'impact',     label: 'Drift Analysis & Trends',    icon: 'trending_up' },
  { key: 'prediction', label: 'Prediction & Forecasting',   icon: 'auto_graph' },
  { key: 'cost',       label: 'Cost Impact',                icon: 'savings' },
  { key: 'reports',    label: 'Reports',                    icon: 'summarize' },
]

export default function AnalyticsPage() {
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const activeSubscriptionId = subscription || (import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || '')
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  const [activeTab, setActiveTab] = useState('impact')

  return (
    <div className="an-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="an-main" id="main-content" role="main">
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
        <div className="an-tab-bar" role="tablist" aria-label="Analytics views">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`an-tab-btn ${activeTab === tab.key ? 'an-tab-btn--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`tab-panel-${tab.key}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ═══ TAB 2: Drift Impact Analysis ═════════════════════════════════ */}
        {activeTab === 'impact' && (
          <div className="an-tab-content" key="impact">
            <DriftImpactDashboard subscriptionId={activeSubscriptionId} />
            <div style={{ marginTop: 24 }}>
              <TopChangers subscriptionId={activeSubscriptionId} />
            </div>
          </div>
        )}

        {/* ═══ TAB 3: Prediction & Forecasting ══════════════════════════════ */}
        {activeTab === 'prediction' && (
          <div className="an-tab-content" key="prediction">

            {/* RG-level bubble matrix + heatmap + AI prediction cards */}
            {resourceGroup && (
              <div className="an-card an-card--full">
                <div className="an-card-header">
                  <div className="an-card-title-row">
                    <span className="material-symbols-outlined an-card-icon">hub</span>
                    <span className="an-card-title">Resource Group Drift Analysis</span>
                    <span className="an-card-badge an-card-badge--ai">
                      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>auto_awesome</span>
                      AI Powered
                    </span>
                  </div>
                </div>
                <div className="an-card-body">
                  <RgDriftPrediction subscriptionId={activeSubscriptionId} resourceGroup={resourceGroup} />
                </div>
              </div>
            )}

          </div>
        )}


        {/* ═══ TAB 4: Reports ═══════════════════════════════════════════ */}
        {activeTab === 'cost' && (
          <div className="an-tab-content" key="cost">
            <CostImpactDashboard subscriptionId={activeSubscriptionId} />
          </div>
        )}

        {activeTab === 'reports' && (
          <div className="an-tab-content" key="reports">
            <ReportsDashboard subscriptionId={activeSubscriptionId} />
          </div>
        )}
      </main>
    </div>
  )
}
