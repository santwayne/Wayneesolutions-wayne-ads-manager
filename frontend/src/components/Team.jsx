import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROLE = { owner: 'Owner — sab kuch, settings aur team', manager: 'Manager — campaign banana, launch, budget', viewer: 'Viewer — sirf dekhna' };

export default function Team({ orgId, owner }) {
  const [rows, setRows] = useState([]); const [f, setF] = useState(null); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = () => api('GET', `/orgs/${orgId}/members`).then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [orgId]);
  const run = (fn) => async (...a) => { setErr(''); setMsg(''); try { await fn(...a); load(); } catch (x) { setErr(x.message); } };
  const invite = run(async (e) => {
    e.preventDefault();
    const r = await api('POST', `/orgs/${orgId}/members`, { email: f.email, name: f.name, role: f.role, phone: f.phone || undefined });
    setMsg(r.delivered ? `Invite ${r.delivered === 'email' ? 'email' : 'WhatsApp'} pe chala gaya.` : `Invite bhejne ka tareeka set nahi hai — ye link khud bhejiye: ${r.inviteLink}`);
    setF(null);
  });
  const setRole = run((id, role) => api('PATCH', `/orgs/${orgId}/members/${id}`, { role }));
  const remove = run((m) => { if (window.confirm(`${m.name} ko team se hatana hai?`)) return api('DELETE', `/orgs/${orgId}/members/${m.id}`); });
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row spread"><h2 style={{ margin: 0 }}>Team</h2>{owner && !f && <button onClick={() => setF({ role: 'manager' })}>+ Invite</button>}</div>
      {f && (
        <form onSubmit={invite} className="grid g2" style={{ marginTop: 10 }}>
          <div><label>Naam</label><input required value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label>Email</label><input type="email" required value={f.email || ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label>WhatsApp (optional, 91XXXXXXXXXX)</label><input value={f.phone || ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div className="row"><button className="primary">Invite bhejo</button><button type="button" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      )}
      {msg && <p className="muted" style={{ wordBreak: 'break-all' }}>{msg}</p>}{err && <p className="err">{err}</p>}
      <table style={{ marginTop: 10 }}><thead><tr><th>Naam</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.id}><td>{m.name} {!m.passwordSet && <span className="pill yellow">invite pending</span>}</td><td>{m.email}</td>
            <td>{owner ? <select value={m.role} onChange={(e) => setRole(m.id, e.target.value)} style={{ width: 130 }}>{Object.keys(ROLE).map((k) => <option key={k}>{k}</option>)}</select> : m.role}</td>
            <td>{owner && <button className="danger" onClick={() => remove(m)}>Hatao</button>}</td></tr>))}</tbody></table>
    </div>
  );
}
