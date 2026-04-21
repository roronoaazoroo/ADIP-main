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

import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import "./NavBar.css";

const NavBar = ({ user, subscription, resourceGroup, resource, configData }) => {
  const navigate = useNavigate();
  const location = useLocation();
  // Returns the correct CSS class for a nav link — adds --active when on that page
  const getNavLinkClass = (routePath) => location.pathname === routePath ? "dh-nav-link dh-nav-link--active" : "dh-nav-link";

  return (
    <nav className="dh-nav">
      <div className="dh-nav-left">
        <img src="../src/assets/ct-logo.png" alt="ct-logo" className="ct-logo"/>
        <span className="dh-brand">
          Azure Drift Intelligence Platform
          </span>
        <div className="dh-nav-links">
          <span className={getNavLinkClass("/dashboard")} onClick={() => navigate("/dashboard")}>Dashboard</span>
          <span className={getNavLinkClass("/scanner")} onClick={() => navigate("/scanner")}>Drift Scanner</span>
          <span className={getNavLinkClass("/comparison")} onClick={() =>
            navigate("/comparison", {
              state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null, liveState: configData }
            })
          }>Comparison</span>
          <span className={getNavLinkClass("/genome")} onClick={() =>
            navigate("/genome", {
              state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || resourceGroup }
            })
          }>Config Genome</span>
        </div>
      </div>
      <div className="dh-nav-right">
        <button className="dh-icon-btn"><span className="material-symbols-outlined">notifications</span></button>
        <button className="dh-icon-btn" onClick={() => navigate("/")}><span className="material-symbols-outlined">logout</span></button>
        <div className="dh-avatar">{user?.name?.charAt(0) || "U"}</div>
      </div>
    </nav>
  );
};

export default NavBar;
