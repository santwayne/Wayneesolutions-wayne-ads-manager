import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useParams, useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

// Loopdesk AI top bar (same as every Loopdesk tool): crimson bar, logo tile + "Loopdesk AI / Ads Manager",
// pages as pills, business name and Log out on the right. Same links and rules as before.
export default function Layout() {
  const { orgId } = useParams();
  const [me, setMe] = useState(null);
  const nav = useNavigate();
  useEffect(() => { api('GET', '/auth/me').then(setMe).catch(() => {}); }, []);
  const org = me?.orgs.find((o) => String(o.id) === String(orgId));
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-in">
          <div className="brandmark">
            <span className="logo-tile"><img src="/brand/loopdesk-icon.png" alt="" width="30" height="30" /></span>
            <span className="wordmark">Loopdesk AI</span>
            <span className="slash" aria-hidden>/</span>
            <span className="toolname">Ads Manager</span>
          </div>
          <nav className="pills" aria-label="Pages">
            {/* Client list only for Wayne team; a client's panel shows just their own business. */}
            {me?.isAgency && <NavLink to="/" end>Saare clients</NavLink>}
            {me && !me.isAgency && me.orgs.filter((o) => o.type === 'business').length > 1 && <NavLink to="/" end>Business badlo</NavLink>}
            {org && (
              <>
                <NavLink to={`/orgs/${orgId}`} end>Dashboard</NavLink>
                <NavLink to={`/orgs/${orgId}/new`}>+ Naya campaign</NavLink>
                <NavLink to={`/orgs/${orgId}/alerts`}>Alerts</NavLink>
                <NavLink to={`/orgs/${orgId}/leads`}>Leads</NavLink>
                <NavLink to={`/orgs/${orgId}/reports`}>Monthly report</NavLink>
                <NavLink to={`/orgs/${orgId}/log`}>Kya badla (log)</NavLink>
                {org.payment_model === 'B' && <NavLink to={`/orgs/${orgId}/wallet`}>Wallet</NavLink>}
                <NavLink to={`/orgs/${orgId}/settings`}>Settings</NavLink>
              </>
            )}
          </nav>
          <div className="topbar-right">
            {org && <span className="org" title={org.name}>{org.name}</span>}
            <a href="#" className="logout" title={me?.user?.name || ''} onClick={(e) => { e.preventDefault(); setToken(null); nav('/login'); }}>Log out</a>
          </div>
        </div>
      </header>
      <main><Outlet context={{ me, org }} /></main>
    </div>
  );
}
