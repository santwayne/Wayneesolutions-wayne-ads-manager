import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState(''); const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { setMsg((await api('POST', '/auth/forgot-password', { email })).message); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <form className="card" style={{ width: 380 }} onSubmit={submit}>
        <h1>Password bhool gaye?</h1>
        <p className="sub">Apna email daaliye. Reset link email ya WhatsApp pe aayega (1 ghante tak valid).</p>
        {msg ? <p>{msg}</p> : (
          <>
            <label>Email</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <div className="err">{err}</div>}
            <button className="primary" style={{ width: '100%', marginTop: 16 }} disabled={busy}>Reset link bhejo</button>
          </>
        )}
        <p className="muted"><Link to="/login">Login pe wapas</Link></p>
      </form>
    </div>
  );
}
