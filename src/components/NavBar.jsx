import React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import "./NavBar.css";

const NavBar = ({ user, subscription, resourceGroup, resource, configData }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const active = (path) => location.pathname === path ? "dh-nav-link dh-nav-link--active" : "dh-nav-link";

  return (
    <nav className="dh-nav">
      <div className="dh-nav-left">
        <img src="../src/assets/ct-logo.png" alt="ct-logo" className="ct-logo"/>
        <span className="dh-brand">
          Azure Drift Intelligence Platform
          </span>
        <div className="dh-nav-links">
          <span className={active("/dashboard")} onClick={() => navigate("/dashboard")}>Dashboard</span>
          <span className={active("/scanner")} onClick={() => navigate("/scanner")}>Drift Scanner</span>
          <span className={active("/comparison")} onClick={() =>
            navigate("/comparison", {
              state: { subscriptionId: subscription, resourceGroupId: resourceGroup, resourceId: resource || null, liveState: configData }
            })
          }>Comparison</span>
          <span className={active("/genome")} onClick={() =>
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
