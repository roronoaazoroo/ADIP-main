import { Routes, Route, useLocation } from 'react-router-dom'
import { DashboardProvider } from './context/DashboardContext'
import { ThemeProvider } from './context/ThemeContext'
import LoginPage      from './pages/LoginPage'
import DashboardPage  from './pages/DashboardPage'
import ComparisonPage from './pages/ComparisonPage'
import GenomePage     from './pages/GenomePage'
import AzureChatbot   from './components/AzureChatbot'

function App() {
  const location = useLocation()
  const showChat = location.pathname !== '/'

  return (
    <ThemeProvider>
      <DashboardProvider>
        <Routes>
          <Route path="/"           element={<LoginPage />} />
          <Route path="/dashboard"  element={<DashboardPage />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/genome"     element={<GenomePage />} />
        </Routes>
        {showChat && <AzureChatbot />}
      </DashboardProvider>
    </ThemeProvider>
  )
}

export default App

