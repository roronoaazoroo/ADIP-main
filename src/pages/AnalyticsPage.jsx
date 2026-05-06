// FILE: src/pages/AnalyticsPage.jsx
// ROLE: Drift Analytics & Insights — trend reports, impact analysis, prediction & forecasting

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

        <div className="an-tab-bar" role="tablist" aria-label="Analytics views">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`an-tab-btn ${activeTab === tab.key ? 'an-tab-btn--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ═══ Drift Analysis & Trends ═══ */}
        {activeTab === 'impact' && (
          <div className="an-tab-content" key="impact">
            <DriftImpactDashboard subscriptionId={activeSubscriptionId} />
            <div style={{ marginTop: 24 }}>
              <TopChangers subscriptionId={activeSubscriptionId} />
            </div>
          </div>
        )}

        {/* ═══ Prediction & Forecasting ═══ */}
        {activeTab === 'prediction' && (
          <div className="an-tab-content" key="prediction">
            {!resourceGroup ? (
              <div className="pf-empty">
                <span className="material-symbols-outlined pf-empty-icon">radar</span>
                <p>Select a subscription and resource group on the <strong>Drift Scanner</strong>, then run a scan to see predictions here.</p>
              </div>
            ) : (
              <>
                {/* Main prediction dashboard */}
                <RgDriftPrediction
                  subscriptionId={activeSubscriptionId}
                  resourceGroup={resourceGroup}
                />

                {/* Drift timeline for selected resource */}
                {resource && (
                  <div className="an-card an-card--full" style={{ marginTop: 8 }}>
                    <div className="an-card-header">
                      <div className="an-card-title-row">
                        <span className="material-symbols-outlined an-card-icon">bar_chart</span>
                        <span className="an-card-title">Drift Timeline</span>
                      </div>
                      <span className="pf-scope-tag">
                        {resource.split('/').pop()}
                      </span>
                    </div>
                    <div className="an-card-body">
                      <DriftForecastChart
                        subscriptionId={activeSubscriptionId}
                        resourceId={resource}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══ Cost Impact ═══ */}
        {activeTab === 'cost' && (
          <div className="an-tab-content" key="cost">
            <CostImpactDashboard subscriptionId={activeSubscriptionId} />
          </div>
        )}

        {/* ═══ Reports ═══ */}
        {activeTab === 'reports' && (
          <div className="an-tab-content" key="reports">
            <ReportsDashboard subscriptionId={activeSubscriptionId} />
          </div>
        )}
      </main>
    </div>
  )
}
