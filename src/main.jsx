import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import './dark-theme.css'

// Apply persisted theme before first paint to avoid flash of wrong theme
try {
  const savedTheme = sessionStorage.getItem('adip.theme')
  if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
} catch {}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
