// FILE: src/components/NavBar.jsx
// ROLE: Top navigation bar shown on every page

// Props:
//   user        — logged-in user object from sessionStorage { name, username }
//   subscription — selected subscription ID (from DashboardContext)
//   resourceGroup — selected resource group ID
//   resource    — selected resource ID
//   configData  — current live ARM config (passed to Comparison/Genome nav links
//                 so those pages open with the current resource pre-loaded)

// Navigation links:
//   Dashboard   → /dashboard
//   Drift Scanner → /scanner
//   Comparison  → /comparison (passes current resource + liveState as Router state)
//   Config Genome → /genome (passes current resource identifiers as Router state)

import React, { useState, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useDashboard } from '../context/DashboardContext';
import "./NavBar.css";
import ViewModeToggle from './ViewModeToggle';
import NotificationPanel from './NotificationPanel';
import { fetchNotifications } from '../services/authService';
import { getSocket } from '../services/socketSingleton';

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/scanner', label: 'Drift Scanner', icon: 'radar' },
  { path: '/comparison', label: 'Comparison', icon: 'compare' },
  { path: '/genome', label: 'Config Genome', icon: 'account_tree' },
  { path: '/analytics', label: 'Analytics', icon: 'analytics' },
];

const NavBar = ({ user, subscription, resourceGroup, resource, configData, scopes: scopesProp }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { scopes: ctxScopes } = useDashboard() || {};
  const scopes = scopesProp || ctxScopes || null;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [liveRole, setLiveRole] = useState(user?.role || null);
  const mobileMenuRef = useRef(null);

  // Listen for role changes targeting this user
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handleRoleChange = (data) => {
      const currentUser = JSON.parse(sessionStorage.getItem('adip.user') || '{}');
      const userObj = JSON.parse(sessionStorage.getItem('user') || '{}');
      if (data.userId === currentUser.userId || data.name === userObj.name || data.name === currentUser.name) {
        setLiveRole(data.role);
        // Update sessionStorage
        const u = JSON.parse(sessionStorage.getItem('user') || '{}');
        sessionStorage.setItem('user', JSON.stringify({ ...u, role: data.role }));
      }
    };
    socket.on('roleChange', handleRoleChange);
    return () => socket.off('roleChange', handleRoleChange);
  }, []);

  // Poll unread notification count
  useEffect(() => {
    const loadCount = () => fetchNotifications().then(n => setUnreadCount((n || []).filter(x => !x.read).length)).catch(() => {});
    loadCount();
    const interval = setInterval(loadCount, 15000);
    return () => clearInterval(interval);
  }, []);

  // Close mobile menu on route change
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleClick = (e) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target)) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [mobileMenuOpen]);

  // Returns the correct CSS class for a nav link — adds --active when on that page
  const isActive = (routePath) => location.pathname === routePath;

  // Handle navigation with proper state for Comparison and Genome pages
  const handleNavClick = (path) => {
    if (path === '/comparison') {
      navigate(path, {
        state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null, liveState: configData, scopes: scopes || null }
      });
    } else if (path === '/genome') {
      navigate(path, {
        state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || resourceGroup, scopes: scopes || null }
      });
    } else {
      navigate(path);
    }
  };

  // Keyboard handler for nav items
  const handleNavKeyDown = (e, path) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleNavClick(path);
    }
  };

  return (
    <>
    <nav className="dh-nav" role="navigation" aria-label="Main navigation">
      {/* Skip to content link for keyboard users */}

      <div className="dh-nav-left">
        <img src="../src/assets/ct-logo.png" alt="CloudThat Logo" className="ct-logo"/>
        <span className="dh-brand" aria-hidden="true">
          Azure Drift Intelligence Platform
        </span>

        {/* Desktop nav links */}
        <div className="dh-nav-links" role="menubar" aria-label="Page navigation">
          {NAV_ITEMS.map(item => (
            <button
              key={item.path}
              className={`dh-nav-link ${isActive(item.path) ? 'dh-nav-link--active' : ''}`}
              onClick={() => handleNavClick(item.path)}
              onKeyDown={(e) => handleNavKeyDown(e, item.path)}
              role="menuitem"
              aria-current={isActive(item.path) ? 'page' : undefined}
              tabIndex={0}
            >
              {item.label}
              {isActive(item.path) && <span className="dh-nav-indicator" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>

      <div className="dh-nav-right">
        <ViewModeToggle />
        {/* Notification button */}
        <button
          className="dh-icon-btn"
          aria-label="Notifications"
          data-tooltip="Notifications"
          onClick={() => { setNotificationPanelOpen(true); setUnreadCount(0); }}
          style={{ position: 'relative' }}
        >
          <span className="material-symbols-outlined">notifications</span>
          {unreadCount > 0 && (
            <span style={{ position: 'absolute', top: 2, right: 2, background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
          )}
        </button>

        {/* Settings button */}
        <button
          className="dh-icon-btn"
          onClick={() => navigate("/settings")}
          aria-label="Settings"
          data-tooltip="Settings"
        >
          <span className="material-symbols-outlined">settings</span>
        </button>

        {/* Logout button */}
        <button
          className="dh-icon-btn dh-icon-btn--logout"
          onClick={() => {
            sessionStorage.removeItem('user');
            sessionStorage.removeItem('adip.token');
            sessionStorage.removeItem('adip.user');
            navigate("/");
          }}
          aria-label="Sign out"
          data-tooltip="Sign out"
        >
          <span className="material-symbols-outlined">logout</span>
        </button>

        {/* User chip — avatar + name + role */}
        {(() => {
          const role = liveRole || user?.role
          const roleBg    = role === 'admin'    ? 'rgba(25,149,255,0.12)'   : role === 'approver' ? 'rgba(16,185,129,0.12)'  : 'rgba(245,158,11,0.12)'
          const roleColor = role === 'admin'    ? '#1995ff'                 : role === 'approver' ? '#10b981'                : '#d97706'
          return (
            <div className="dh-user-chip" aria-label={`Signed in as ${user?.name || 'User'}, role: ${role || 'unknown'}`}>
              <div className="dh-avatar" aria-hidden="true">
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <div className="dh-user-info">
                <span className="dh-user-name">{user?.name || user?.username || 'User'}</span>
                {role && (
                  <span className="dh-user-role" style={{ background: roleBg, color: roleColor }}>
                    {role}
                  </span>
                )}
              </div>
            </div>
          )
        })()}

        {/* Mobile menu toggle */}
        <button
          className="dh-mobile-toggle"
          onClick={() => setMobileMenuOpen(prev => !prev)}
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileMenuOpen}
        >
          <span className="material-symbols-outlined">
            {mobileMenuOpen ? 'close' : 'menu'}
          </span>
        </button>
      </div>

      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div className="dh-mobile-menu" ref={mobileMenuRef} role="menu" aria-label="Mobile navigation">
          <div className="dh-mobile-menu-inner">
            {NAV_ITEMS.map(item => (
              <button
                key={item.path}
                className={`dh-mobile-nav-item ${isActive(item.path) ? 'dh-mobile-nav-item--active' : ''}`}
                onClick={() => handleNavClick(item.path)}
                role="menuitem"
                aria-current={isActive(item.path) ? 'page' : undefined}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
      <NotificationPanel isOpen={notificationPanelOpen} onClose={() => setNotificationPanelOpen(false)} />
    </>
  );
};

export default NavBar;
