import React, { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, inr } from '../api.js';

const HEALTH = { red: ['red', 'Aaj dhyaan do'], yellow: ['yellow', 'Nazar rakho'], green: ['green', 'Theek hai'] };

export default function Agency() {
  const { me } = useOutletContext();
  const [clients, setClients] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const agency = me?.orgs.find((o) => o.type === 'agency');
  const load = () => api('GET', '/agency/overview').then((r) => setClients(r.clients));
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault(); setErr('');
    try {
      await api('POST', `/orgs/${agency.id}/clients`, { name: form.name, whatsappNumber: form.whatsapp || undefined, paymentModel: form.model, serviceFeeMonthly: Number(form.fee || 0), privacyPolicyUrl: form.privacy || undefined });
      setForm(null); load();
    } catch (x) { setErr(x.message); }
  };

  return (
    <>
      <div className="row spread">
        <div><h1>Saare clients</h1><p className="sub">Health score: kis client pe aaj dhyaan dena hai.</p></div>
        {agency && <button className="primary" onClick={() => setForm({ model: 'A' })}>+ Naya client</button>}
      </div>
      {form && (
        <form className="card" onSubmit={create} style={{ marginBottom: 16 }}>
          <div className="grid g2">
            <div><label>Business ka naam</label><input required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Owner ka WhatsApp (91XXXXXXXXXX)</label><input value={form.whatsapp || ''} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} /></div>
            <div><label>Payment model</label>
              <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                <option value="A">Model A — client ka card (sirf service fee)</option>
                <option value="B">Model B — Wayne pay karta hai (prepaid wallet)</option>
              </select></div>
            <div><label>Monthly service fee (₹)</label><input type="number" value={form.fee || ''} onChange={(e) => setForm({ ...form, fee: e.target.value })} /></div>
            <div><label>Client ki privacy policy URL (lead form ke liye)</label><input value={form.privacy || ''} onChange={(e) => setForm({ ...form, privacy: e.target.value })} /></div>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ marginTop: 14 }}><button className="primary">Banao</button><button type="button" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      )}
      {!clients ? <p className="muted">Load ho raha hai…</p> : (
        <table>
          <thead><tr><th>Client</th><th>Health</th><th>Is hafte</th><th>Leads</th><th>Ek lead</th><th>Customers</th><th>Alerts</th><th>Wallet</th></tr></thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/orgs/${c.id}`}>{c.name}</Link> <span className="muted">({c.payment_model})</span></td>
                <td><span className={`pill ${HEALTH[c.health][0]}`}>{HEALTH[c.health][1]}</span></td>
                <td>{inr(c.last7.spend)}</td><td>{c.last7.leads}</td><td>{inr(c.last7.cpl)}</td><td>{c.last7.won}</td>
                <td>{c.critical ? <span className="pill red">{c.critical} critical</span> : null} {c.warnings ? <span className="pill yellow">{c.warnings}</span> : null}</td>
                <td>{c.wallet_balance == null ? '—' : inr(c.wallet_balance)}</td>
              </tr>
            ))}
            {!clients.length && <tr><td colSpan="8" className="muted">Abhi koi client nahi.</td></tr>}
          </tbody>
        </table>
      )}
    </>
  );
}
