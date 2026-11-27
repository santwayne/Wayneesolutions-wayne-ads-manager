import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

/** Used for both "forgot password" links and team invites (set your password). */
export default function ResetPassword() {
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [info, setInfo] = useState(null); const [err, setErr] = useState('');
  const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  useEffect(() => {
    api('GET', `/auth/reset-password/check?token=${encodeURIComponent(token)}`).then((r) => { setInfo(r); setName(r.name || ''); }).catch((e) => setErr(e.message));
  }, []);
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('Dono password ek jaise nahi hain');
    try {
      const r = await api('POST', '/auth/reset-password', { token, password: pw, ...(info.purpose === 'invite' ? { name } : {}) });
      setToken(r.token); nav(r.orgId ? `/orgs/${r.orgId}` : '/');
    } catch (x) { setErr(x.message); }
  };
  const invite = info?.purpose === 'invite';
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <form className="card" style={{ width: 400 }} onSubmit={submit}>
        <h1>{invite ? `${info.orgName} team mein swagat hai` : 'Naya password'}</h1>
        {info && <p className="sub">{info.email}</p>}
        {!info && err && <><div className="err">{err}</div><p><Link to="/forgot-password">Naya link mangwaiye</Link></p></>}
        {info && (
          <>
            {invite && <><label>Aapka naam</label><input required value={name} onChange={(e) => setName(e.target.value)} /></>}
            <label>Password (8+ characters)</label><input type="password" minLength={8} required value={pw} onChange={(e) => setPw(e.target.value)} />
            <label>Password dobara</label><input type="password" minLength={8} required value={pw2} onChange={(e) => setPw2(e.target.value)} />
            {err && <div className="err">{err}</div>}
            <button className="primary" style={{ width: '100%', marginTop: 16 }}>{invite ? 'Password set karke shuru karo' : 'Password badlo'}</button>
          </>
        )}
      </form>
    </div>
  );
}
