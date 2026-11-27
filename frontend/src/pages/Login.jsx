import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

export default function Login() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  const nav = useNavigate();
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { const r = await api('POST', '/auth/login', { email, password }); setToken(r.token); nav('/'); } catch (x) { setErr(x.message); }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <form className="card" style={{ width: 360 }} onSubmit={submit}>
        <h1>Wayne Ads Manager</h1>
        <p className="sub">10 minute mein sahi campaign.</p>
        <label>Email</label><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <label>Password</label><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        {err && <div className="err">{err}</div>}
        <button className="primary" style={{ width: '100%', marginTop: 16 }}>Login</button>
      </form>
    </div>
  );
}
