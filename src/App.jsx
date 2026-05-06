import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { DashboardProvider } from './context/DashboardContext'
import { ViewModeProvider } from './context/ViewModeContext'
import LoginPage      from './pages/LoginPage'
import DashboardHome  from './pages/DashboardHome'
import DriftScanner  from './pages/DriftScanner'
import ComparisonPage from './pages/ComparisonPage'
import GenomePage     from './pages/GenomePage'
import SettingsPage   from './pages/SettingsPage'
import AnalyticsPage  from './pages/AnalyticsPage'
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
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/dashboard" element={<ProtectedRoute><DashboardHome /></ProtectedRoute>} />
          <Route path="/scanner" element={<ProtectedRoute><DriftScanner /></ProtectedRoute>} />
          <Route path="/comparison" element={<ProtectedRoute><ComparisonPage /></ProtectedRoute>} />
          <Route path="/genome" element={<ProtectedRoute><GenomePage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
        </Routes>
        {showChat && <AzureChatbot />}
      </DashboardProvider>
      </ViewModeProvider>
  )
}

export default App
