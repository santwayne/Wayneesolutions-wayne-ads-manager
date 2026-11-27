import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, getToken } from '../api.js';
import ReportView, { lastMonths, monthLabel } from '../components/ReportView.jsx';

export default function Reports() {
  const { orgId } = useParams();
  const [month, setMonth] = useState(lastMonths(1)[0]);
  const [r, setR] = useState(null); const [links, setLinks] = useState([]); const [share, setShare] = useState(''); const [err, setErr] = useState('');
  const loadLinks = () => api('GET', `/orgs/${orgId}/report-links`).then(setLinks).catch(() => {});
  useEffect(() => { setR(null); api('GET', `/orgs/${orgId}/reports/monthly?month=${month}`).then(setR).catch((e) => setErr(e.message)); }, [orgId, month]);
  useEffect(() => { loadLinks(); }, [orgId]);
  const pdf = async () => {
    setErr('');
    const res = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/orgs/${orgId}/reports/monthly.pdf?month=${month}`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return setErr('PDF nahi bana');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${r?.business || 'report'}_${month}.pdf`; a.click(); URL.revokeObjectURL(url);
  };
  const makeLink = async () => { setErr(''); try { const l = await api('POST', `/orgs/${orgId}/report-links`, { days: 90 }); setShare(l.url); loadLinks(); } catch (x) { setErr(x.message); } };
  const revoke = async (id) => { await api('DELETE', `/orgs/${orgId}/report-links/${id}`); loadLinks(); };
  return (
    <>
      <div className="row spread">
        <div><h1>Monthly report</h1><p className="sub">Har mahine ki 1 tareekh ko owner ko WhatsApp + email (PDF) pe khud jaati hai.</p></div>
        <div className="row">
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 170 }}>{lastMonths(12).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
          <button onClick={pdf}>⬇ PDF</button>
          <button className="primary" onClick={makeLink}>🔗 Share link</button>
        </div>
      </div>
      {share && <div className="card" style={{ marginBottom: 14 }}>Live report link (90 din, bina login): <a href={share} target="_blank" rel="noreferrer">{share}</a> <button onClick={() => navigator.clipboard?.writeText(share)}>Copy</button></div>}
      {err && <div className="err">{err}</div>}
      {r ? <ReportView r={r} /> : <p className="muted">Load ho raha hai…</p>}
      {links.length > 0 && (
        <><h2>Share links</h2><table><thead><tr><th>Bana</th><th>Expiry</th><th>Status</th><th /></tr></thead>
          <tbody>{links.map((l) => <tr key={l.id}><td>{new Date(l.created_at).toLocaleDateString('en-IN')}</td><td>{l.expires_at ? new Date(l.expires_at).toLocaleDateString('en-IN') : '—'}</td>
            <td>{l.revoked ? <span className="pill grey">band</span> : <span className="pill green">chalu</span>}</td><td>{!l.revoked && <button className="danger" onClick={() => revoke(l.id)}>Band karo</button>}</td></tr>)}</tbody></table></>
      )}
    </>
  );
}
