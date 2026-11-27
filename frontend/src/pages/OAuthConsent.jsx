import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken } from '../api.js';

const SCOPE_TEXT = { 'ads.read': 'Aapke ads ka performance, alerts aur suggestions dekhna', 'ads.write': 'Aapke confirm karne pe ads pause/resume, budget badalna (max 20%) aur paused campaign launch karna' };

/** MCP connector consent (Claude asks to connect to Wayne Ads). */
export default function OAuthConsent() {
  const nav = useNavigate();
  const req = new URLSearchParams(window.location.search).get('req');
  const [info, setInfo] = useState(null); const [err, setErr] = useState('');
  useEffect(() => {
    if (!getToken()) { sessionStorage.setItem('after_login', window.location.pathname + window.location.search); nav('/login'); return; }
    api('GET', `/oauth/request?req=${encodeURIComponent(req)}`).then(setInfo).catch((e) => setErr(e.message));
  }, []);
  const decide = async (approve) => {
    try { const r = await api('POST', '/oauth/approve', { req, approve }); window.location.href = r.redirect; } catch (e) { setErr(e.message); }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ maxWidth: 440 }}>
        <h1>{info?.clientName || 'Claude'} ko access dein?</h1>
        <p className="sub">Wayne Ads Manager connector</p>
        <ul>{(info?.scopes || []).map((s) => <li key={s}>{SCOPE_TEXT[s] || s}</li>)}</ul>
        <p className="muted">Har change aapke confirm karne pe hi hoga aur "Kya badla" log mein dikhega. Billing kabhi touch nahi hoti.</p>
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="primary" disabled={!info} onClick={() => decide(true)}>Allow</button><button onClick={() => decide(false)}>Deny</button></div>
      </div>
    </div>
  );
}
