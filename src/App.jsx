import { Routes, Route, useLocation } from 'react-router-dom'
import { DashboardProvider } from './context/DashboardContext'
import LoginPage      from './pages/LoginPage'
import DashboardHome  from './pages/DashboardHome'
import DriftScanner  from './pages/DriftScanner'
import ComparisonPage from './pages/ComparisonPage'
import GenomePage     from './pages/GenomePage'
import AzureChatbot   from './components/AzureChatbot'

function App() {
  const location = useLocation()
  const showChat = location.pathname !== '/'

  return (
      <DashboardProvider>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/dashboard" element={<DashboardHome />} />
          <Route path="/scanner" element={<DriftScanner />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/genome" element={<GenomePage />} />
        </Routes>
        {showChat && <AzureChatbot />}
      </DashboardProvider>
  )
}

export default App