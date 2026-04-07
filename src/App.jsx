import { Routes, Route } from 'react-router-dom'
import { DashboardProvider } from './context/DashboardContext'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import ComparisonPage from './pages/ComparisonPage'
import GenomePage from './pages/GenomePage'

function App() {
  return (
    <DashboardProvider>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/comparison" element={<ComparisonPage />} />
        <Route path="/genome" element={<GenomePage />} />
      </Routes>
    </DashboardProvider>
  )
}

export default App
