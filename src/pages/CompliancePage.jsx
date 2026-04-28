import React from 'react'
import { useNavigate } from 'react-router-dom'
import NavBar from '../components/NavBar'
import { useDashboard } from '../context/DashboardContext'
import './AnalyticsPage.css' // Reuse analytics styles for similarity

const COMPLIANCE_DATA = [
  { framework: 'CIS Azure 1.4.0', control: '5.1.3', status: 'Violated', resources: 12, risk: 'High' },
  { framework: 'CIS Azure 1.4.0', control: '5.1.4', status: 'Violated', resources: 3, risk: 'Medium' },
  { framework: 'NIST SP 800-53', control: 'SC-7 Boundary Protection', status: 'Violated', resources: 8, risk: 'Critical' },
  { framework: 'ISO 27001:2013', control: 'A.13.1.1 Network Controls', status: 'Violated', resources: 15, risk: 'High' },
  { framework: 'Azure Security Benchmark', control: 'NS-1', status: 'Passed', resources: 0, risk: 'Low' },
]

export default function CompliancePage() {
  const navigate = useNavigate()
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  return (
    <div className="an-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="an-main">
        <header className="an-header">
          <div>
            <h1 className="an-headline">Compliance Report</h1>
            <p className="an-subline">Aggregated view of how drift events impact regulatory compliance controls.</p>
          </div>
          <div className="an-header-badges">
            <span className="an-header-badge" style={{ color: '#ef4444', borderColor: '#ef4444' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>gavel</span>
              4 Active Violations
            </span>
          </div>
        </header>

        {/* AI Executive Summary */}
        <div className="an-ai-banner">
          <span className="material-symbols-outlined an-ai-icon">psychology</span>
          <div className="an-ai-banner-content">
            <h3 className="an-ai-banner-title">AI Executive Summary</h3>
            <p className="an-ai-banner-desc">
              Recent infrastructure drift has introduced <strong>4 new compliance violations</strong> primarily impacting Network Boundary Protection (NIST SC-7). 
              The risk profile is elevated due to uncontrolled Network Security Group (NSG) and route table modifications. Reverting to baseline for the top 5 drifted resources will resolve 80% of these violations.
            </p>
          </div>
        </div>

        {/* Violations Table */}
        <div className="an-card an-card--full" style={{ marginTop: 24 }}>
          <div className="an-card-header">
            <div className="an-card-title-row">
              <span className="material-symbols-outlined an-card-icon">policy</span>
              <h2 className="an-card-title">Mapped Compliance Controls</h2>
            </div>
          </div>
          <div className="an-card-body an-card-body--table">
            <table className="an-table">
              <thead>
                <tr>
                  <th>Framework</th>
                  <th>Control ID / Description</th>
                  <th>Status</th>
                  <th>Affected Resources</th>
                  <th>Risk Level</th>
                </tr>
              </thead>
              <tbody>
                {COMPLIANCE_DATA.map((row, i) => (
                  <tr key={i} className="an-tr">
                    <td className="an-td-resource">{row.framework}</td>
                    <td style={{ fontWeight: 500 }}>{row.control}</td>
                    <td>
                      <span className="an-sev-badge" style={{ 
                        background: row.status === 'Violated' ? '#ef444415' : '#10b98115', 
                        color: row.status === 'Violated' ? '#ef4444' : '#10b981' 
                      }}>
                        {row.status}
                      </span>
                    </td>
                    <td><span className="an-drift-count">{row.resources}</span></td>
                    <td>
                      <span className="an-sev-badge" style={{
                        background: row.risk === 'Critical' ? '#ef444415' : row.risk === 'High' ? '#f9731615' : row.risk === 'Medium' ? '#f59e0b15' : 'transparent',
                        color: row.risk === 'Critical' ? '#ef4444' : row.risk === 'High' ? '#f97316' : row.risk === 'Medium' ? '#f59e0b' : 'var(--text-secondary)',
                      }}>
                        {row.risk !== 'Low' && row.risk}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </div>
  )
}
