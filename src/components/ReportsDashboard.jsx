// ============================================================
// FILE: src/components/ReportsDashboard.jsx
// ROLE: Drift Analysis & Trend Reports tab on AnalyticsPage
//
// Allows users to:
//   - Generate a new drift report for a configurable period
//   - View a list of previously generated reports
//   - Open any report inline in an iframe
//   - Optionally email the report via ACS
//
// Props:
//   subscriptionId — Azure subscription ID
// ============================================================
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { generateDriftReport, fetchSavedReports, getReportViewUrl, deleteReport } from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

export default function ReportsDashboard({ subscriptionId: propSubscriptionId }) {
  // Allow overriding subscription from the input field if context has none
  const [subInput,           setSubInput]           = useState(propSubscriptionId || ENV_SUB_ID)

  // Effective subscription ID — prop takes priority, then local input
  const effectiveSubId = propSubscriptionId || subInput

  // List of previously generated reports from blob storage
  const [savedReports,       setSavedReports]       = useState([])
  const [isLoadingReports,   setIsLoadingReports]   = useState(false)

  // Report generation state
  const [isGenerating,       setIsGenerating]       = useState(false)
  const [selectedPeriodDays, setSelectedPeriodDays] = useState(7)
  const [sendEmailOnGenerate, setSendEmailOnGenerate] = useState(false)
  const [generationResult,   setGenerationResult]   = useState(null)
  const [generationError,    setGenerationError]    = useState(null)

  // Currently viewed report (shown in iframe)
  const [viewingReportKey,   setViewingReportKey]   = useState(null)
  const iframeRef = useRef(null)

  // Sync prop changes into input
  useEffect(() => { if (propSubscriptionId) setSubInput(propSubscriptionId) }, [propSubscriptionId])

  const loadSavedReports = useCallback(async () => {
    if (!effectiveSubId) return
    setIsLoadingReports(true)
    try {
      const reports = await fetchSavedReports(effectiveSubId)
      setSavedReports(reports || [])
    } catch { /* non-fatal — list may be empty on first use */ }
    finally { setIsLoadingReports(false) }
  }, [effectiveSubId])

  useEffect(() => { loadSavedReports() }, [loadSavedReports])

  const handleGenerateReport = async () => {
    if (!effectiveSubId) return
    setIsGenerating(true)
    setGenerationResult(null)
    setGenerationError(null)
    // Read recipient email from logged-in user's session
    const userEmail = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}').email || '' } catch { return '' } })()
    try {
      const result = await generateDriftReport(effectiveSubId, selectedPeriodDays, sendEmailOnGenerate, userEmail)
      setGenerationResult(result)
      // Refresh the saved reports list
      await loadSavedReports()
      // Auto-open the newly generated report
      setViewingReportKey(result.blobKey)
    } catch (generateError) {
      setGenerationError(generateError.message)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDeleteReport = async (blobKey) => {
    if (!window.confirm('Delete this report? This cannot be undone.')) return
    try {
      await deleteReport(blobKey)
      if (viewingReportKey === blobKey) setViewingReportKey(null)
      await loadSavedReports()
    } catch (deleteError) {
      console.log('[ReportsDashboard] delete failed:', deleteError.message)
    }
  }

  const handlePrintReport = async () => {
    const key = viewingReportKey
    if (!key) return
    // Fetch the HTML, open in new tab, trigger print (Save as PDF)
    try {
      const url = getReportViewUrl(key)
      const resp = await fetch(url)
      const html = await resp.text()
      const blob = new Blob([html], { type: 'text/html' })
      const blobUrl = URL.createObjectURL(blob)
      const win = window.open(blobUrl, '_blank')
      if (win) {
        win.onload = () => { win.print(); URL.revokeObjectURL(blobUrl) }
      }
    } catch { /* fallback: open URL directly */ 
      window.open(getReportViewUrl(key), '_blank')
    }
  }

  return (
    <div className="an-reports-dashboard">

      {/* Generate Report Panel */}
      <div className="an-card an-card--full">
        <div className="an-card-header">
          <div className="an-card-title-row">
            <span className="material-symbols-outlined an-card-icon">summarize</span>
            <h2 className="an-card-title">Generate Drift Report</h2>
          </div>
        </div>
        <div className="an-card-body">
          {/* Subscription input — shown only when not provided via context */}
          {!propSubscriptionId && (
            <div className="an-report-control-group" style={{ marginBottom: 16 }}>
              <label className="an-report-label">Subscription ID</label>
              <input
                className="an-report-sub-input"
                type="text"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={subInput}
                onChange={e => setSubInput(e.target.value.trim())}
              />
            </div>
          )}
          <div className="an-report-controls">
            {/* Period selector */}
            <div className="an-report-control-group">
              <label className="an-report-label">Report Period</label>
              <div className="an-range-btns">
                {[7, 14, 30].map(days => (
                  <button key={days}
                    className={`an-range-btn ${selectedPeriodDays === days ? 'an-range-btn--active' : ''}`}
                    onClick={() => setSelectedPeriodDays(days)}>
                    {days}d
                  </button>
                ))}
              </div>
            </div>

            {/* Email toggle */}
            <div className="an-report-control-group">
              <label className="an-report-label">
                <input type="checkbox"
                  checked={sendEmailOnGenerate}
                  onChange={e => setSendEmailOnGenerate(e.target.checked)}
                  style={{ marginRight: 8 }} />
                Send via email (ACS)
              </label>
            </div>

            {/* Generate button */}
            <button className="an-generate-btn" onClick={handleGenerateReport}
              disabled={isGenerating || !effectiveSubId}>
              {isGenerating ? (
                <><div className="gp-spinner" style={{ width: 14, height: 14 }} />Generating...</>
              ) : (
                <><span className="material-symbols-outlined" style={{ fontSize: 16 }}>play_arrow</span>Generate Report</>
              )}
            </button>
          </div>

          {/* Generation result */}
          {generationResult && (
            <div className="an-report-result">
              <span className="material-symbols-outlined" style={{ color: '#10b981', fontSize: 18 }}>check_circle</span>
              <span>Report generated — {generationResult.summary?.totalDriftEvents} drift events, {generationResult.summary?.totalChanges} total changes</span>
            </div>
          )}
          {generationError && (
            <div className="an-report-result an-report-result--error">
              <span className="material-symbols-outlined" style={{ color: '#ef4444', fontSize: 18 }}>error</span>
              <span>{generationError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Saved Reports List */}
      <div className="an-card an-card--full">
        <div className="an-card-header">
          <div className="an-card-title-row">
            <span className="material-symbols-outlined an-card-icon">folder_open</span>
            <h2 className="an-card-title">Saved Reports</h2>
            {savedReports.length > 0 && <span className="an-card-badge">{savedReports.length}</span>}
          </div>
        </div>
        <div className="an-card-body">
          {isLoadingReports && <div style={{ color: '#6b7280', fontSize: 13 }}>Loading reports...</div>}
          {!isLoadingReports && savedReports.length === 0 && (
            <div style={{ color: '#64748b', fontSize: 13, padding: '12px 0' }}>
              No reports generated yet. Click "Generate Report" above to create your first report.
            </div>
          )}
          {savedReports.map((report, index) => (
            <div key={report.blobKey || index} className="an-report-row">
              <div className="an-report-info">
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#1995ff' }}>description</span>
                <div>
                  <div className="an-report-name">{report.reportName}</div>
                  <div className="an-report-meta">
                    {report.createdAt ? new Date(report.createdAt).toLocaleString() : '—'}
                    {report.sizeBytes && ` · ${Math.round(report.sizeBytes / 1024)}KB`}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="an-report-view-btn"
                  onClick={() => setViewingReportKey(viewingReportKey === report.blobKey ? null : report.blobKey)}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    {viewingReportKey === report.blobKey ? 'expand_less' : 'open_in_new'}
                  </span>
                  {viewingReportKey === report.blobKey ? 'Close' : 'View'}
                </button>
                <button className="an-report-view-btn" title="Download as PDF"
                  onClick={async () => {
                    try {
                      const url = getReportViewUrl(report.blobKey)
                      const resp = await fetch(url)
                      const html = await resp.text()
                      const blob = new Blob([html], { type: 'text/html' })
                      const blobUrl = URL.createObjectURL(blob)
                      const win = window.open(blobUrl, '_blank')
                      if (win) win.onload = () => { win.print(); URL.revokeObjectURL(blobUrl) }
                    } catch { window.open(getReportViewUrl(report.blobKey), '_blank') }
                  }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>picture_as_pdf</span>
                  PDF
                </button>
                <button className="an-report-view-btn an-report-delete-btn" title="Delete report"
                  onClick={() => handleDeleteReport(report.blobKey)}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Inline Report Viewer */}
      {viewingReportKey && (
        <div className="an-card an-card--full">
          <div className="an-card-header">
            <div className="an-card-title-row">
              <span className="material-symbols-outlined an-card-icon">preview</span>
              <h2 className="an-card-title">Report Preview</h2>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="an-report-view-btn" onClick={handlePrintReport}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>picture_as_pdf</span>
                Download PDF
              </button>
              <button className="an-range-btn" onClick={() => setViewingReportKey(null)}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
              </button>
            </div>
          </div>
          <div className="an-card-body" style={{ padding: 0 }}>
            <iframe
              ref={iframeRef}
              src={getReportViewUrl(viewingReportKey)}
              title="Drift Report"
              className="an-report-iframe"
              sandbox="allow-same-origin allow-modals"
            />
          </div>
        </div>
      )}
    </div>
  )
}
