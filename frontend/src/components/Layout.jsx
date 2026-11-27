import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useParams, useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

export default function Layout() {
  const { orgId } = useParams();
  const [me, setMe] = useState(null);
  const nav = useNavigate();
  useEffect(() => { api('GET', '/auth/me').then(setMe).catch(() => {}); }, []);
  const org = me?.orgs.find((o) => String(o.id) === String(orgId));
  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">Wayne Ads</div>
        <NavLink to="/" end>Saare clients</NavLink>
        {org && (
          <>
            <div className="org">{org.name}</div>
            <NavLink to={`/orgs/${orgId}`} end>Dashboard</NavLink>
            <NavLink to={`/orgs/${orgId}/new`}>+ Naya campaign</NavLink>
            <NavLink to={`/orgs/${orgId}/alerts`}>Alerts</NavLink>
            <NavLink to={`/orgs/${orgId}/leads`}>Leads</NavLink>
            <NavLink to={`/orgs/${orgId}/log`}>Kya badla (log)</NavLink>
            {org.payment_model === 'B' && <NavLink to={`/orgs/${orgId}/wallet`}>Wallet</NavLink>}
            <NavLink to={`/orgs/${orgId}/settings`}>Settings</NavLink>
          </>
        )}
        <div style={{ flex: 1 }} />
        <a href="#" onClick={(e) => { e.preventDefault(); setToken(null); nav('/login'); }}>Logout {me?.user?.name ? `(${me.user.name})` : ''}</a>
      </aside>
      <main><Outlet context={{ me, org }} /></main>
    </div>
  );
}
