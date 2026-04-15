import React, { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import ctLogo from '../assets/ct-logo.png'
import { useDashboard } from '../context/DashboardContext'
import './Sidebar.css'

const NAV_ITEMS = [
  {
    id: 'dashboard',
    label: 'Drift Scanner',
    path: '/dashboard',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    id: 'comparison',
    label: 'Comparison',
    path: '/comparison',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5" />
      </svg>
    ),
  },
  {
    id: 'genome',
    label: 'Config Genome',
    path: '/genome',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
]


export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { subscription, resourceGroup, resource, configData, resourceGroups, resources } = useDashboard()

  const handleNavClick = (path) => {
    if (path === '/comparison') {
      navigate('/comparison', {
        state: {
          subscriptionId: subscription,
          resourceGroupId: resourceGroup,
          resourceId: resource || null,
          resourceName: resource
            ? resources.find(r => r.id === resource)?.name
            : resourceGroups.find(rg => rg.id === resourceGroup)?.name,
          liveState: configData,
        },
      })
    } else if (path === '/genome') {
      navigate('/genome', {
        state: {
          subscriptionId: subscription,
          resourceGroupId: resourceGroup,
          resourceId: resource || resourceGroup,
          resourceName: resource
            ? resources.find(r => r.id === resource)?.name
            : resourceGroups.find(rg => rg.id === resourceGroup)?.name,
        },
      })
    } else {
      navigate(path)
    }
  }

  return (
    <aside className={`sidebar-nav ${collapsed ? 'collapsed' : ''}`}>
      {/* Top: toggle + logo */}
      <div className="sidebar-nav-top">
        <button
          className="sidebar-hamburger"
          onClick={() => setCollapsed(!collapsed)}
          aria-label="Toggle navigation"
          id="sidebar-toggle"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {collapsed ? (
              <>
                <polyline points="9 18 15 12 9 6" />
              </>
            ) : (
              <>
                <polyline points="15 18 9 12 15 6" />
              </>
            )}
          </svg>
        </button>
        {!collapsed && (
          <div className="sidebar-nav-brand">
            <img src={ctLogo} alt="CloudThat" style={{ height: 28, objectFit: "contain", filter: "brightness(1.1)" }} />
          </div>
        )}
      </div>

      {/* Section label */}
      <div className="sidebar-section-label">
        {!collapsed ? 'Navigation' : ''}
      </div>

      {/* Nav items */}
      <nav className="sidebar-nav-list">
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path
          return (
            <button
              key={item.id}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => handleNavClick(item.path)}
              title={collapsed ? item.label : ''}
              id={`nav-${item.id}`}
            >
              <span className="sidebar-nav-icon">{item.icon}</span>
              {!collapsed && (
                <span className="sidebar-nav-label">{item.label}</span>
              )}
              {collapsed && <span className="sidebar-tooltip">{item.label}</span>}
            </button>
          )
        })}
      </nav>

      {/* Bottom: sign out */}
      <div className="sidebar-nav-bottom">
        <button
          className="sidebar-nav-item sidebar-user-btn"
          onClick={() => navigate('/')}
          title="Sign Out"
          id="nav-signout"
        >
          <span className="sidebar-nav-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </span>
          {!collapsed && <span className="sidebar-nav-label">Sign Out</span>}
          {collapsed && <span className="sidebar-tooltip">Sign Out</span>}
        </button>
      </div>
    </aside>
  )
}
