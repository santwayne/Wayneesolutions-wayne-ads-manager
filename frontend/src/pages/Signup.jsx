import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

export default function Signup() {
  const [f, setF] = useState({}); const [err, setErr] = useState('');
  const nav = useNavigate();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { const r = await api('POST', '/auth/signup', { ...f, privacyPolicyUrl: f.privacyPolicyUrl || undefined }); setToken(r.token); nav(`/orgs/${r.orgId}/settings`); } catch (x) { setErr(x.message); }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <form className="card" style={{ width: 420 }} onSubmit={submit}>
        <h1>Apna business jodo</h1><p className="sub">10 minute mein pehla campaign. Ads ki bhasha aani zaroori nahi.</p>
        <label>Business ka naam</label><input required onChange={set('businessName')} />
        <label>Aapka naam</label><input required onChange={set('name')} />
        <label>Email</label><input type="email" required onChange={set('email')} />
        <label>Password (8+)</label><input type="password" minLength={8} required onChange={set('password')} />
        <label>WhatsApp (91XXXXXXXXXX) — alerts aur reports yahan aayenge</label><input required pattern="\d{10,15}" onChange={set('whatsappNumber')} />
        <label>Privacy policy URL (lead form ke liye)</label><input onChange={set('privacyPolicyUrl')} />
        {err && <div className="err">{err}</div>}
        <button className="primary" style={{ width: '100%', marginTop: 16 }}>Account banao</button>
        <p className="muted">Pehle se account hai? <Link to="/login">Login</Link></p>
      </form>
    </div>
  );
}
