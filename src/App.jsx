import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { DashboardProvider } from './context/DashboardContext'
import { ViewModeProvider } from './context/ViewModeContext'
import { lazy, Suspense } from 'react'
import ErrorBoundary from './components/ErrorBoundary'

// Code-split pages — loaded on demand
const LoginPage      = lazy(() => import('./pages/LoginPage'))
const DashboardHome  = lazy(() => import('./pages/DashboardHome'))
const DriftScanner   = lazy(() => import('./pages/DriftScanner'))
const ComparisonPage = lazy(() => import('./pages/ComparisonPage'))
const GenomePage     = lazy(() => import('./pages/GenomePage'))
const SettingsPage   = lazy(() => import('./pages/SettingsPage'))
const AnalyticsPage  = lazy(() => import('./pages/AnalyticsPage'))

const PageLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'rgba(255,255,255,0.5)' }}>
    <span className="material-symbols-outlined" style={{ fontSize: 32, animation: 'spin 1s linear infinite' }}></span>
  </div>
)
import AzureChatbot   from './components/AzureChatbot'

function ProtectedRoute({ children }) {
  const token = sessionStorage.getItem('adip.token') || sessionStorage.getItem('user')
  return token ? children : <Navigate to="/" replace />
}

function App() {
  const location = useLocation()
  const showChat = location.pathname !== '/'

  return (
      <ViewModeProvider>
      <DashboardProvider>
        <ErrorBoundary><Suspense fallback={<PageLoader />}><Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/dashboard" element={<ProtectedRoute><DashboardHome /></ProtectedRoute>} />
          <Route path="/scanner" element={<ProtectedRoute><DriftScanner /></ProtectedRoute>} />
          <Route path="/comparison" element={<ProtectedRoute><ComparisonPage /></ProtectedRoute>} />
          <Route path="/genome" element={<ProtectedRoute><GenomePage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
        </Routes></Suspense></ErrorBoundary>
        {showChat && <AzureChatbot />}
      </DashboardProvider>
      </ViewModeProvider>
  )
}

export default App
