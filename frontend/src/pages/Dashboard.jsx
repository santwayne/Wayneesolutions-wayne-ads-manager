import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, inr, moneyLine } from '../api.js';
import AlertCard from '../components/AlertCard.jsx';

function Bars({ daily }) {
  if (!daily?.length) return <p className="muted">Abhi data nahi aaya (sync har 4 ghante).</p>;
  const max = Math.max(...daily.map((d) => d.spend), 1);
  return (
    <svg viewBox={`0 0 ${daily.length * 30} 120`} style={{ width: '100%', height: 140 }} role="img" aria-label="Roz ka kharcha">
      {daily.map((d, i) => {
        const h = (d.spend / max) * 90;
        return (
          <g key={d.date}>
            <rect x={i * 30 + 6} y={100 - h} width="18" height={h} rx="3" fill="#1d4ed8"><title>{`${String(d.date).slice(0, 10)}: ${inr(d.spend)}, ${d.leads} leads`}</title></rect>
            <text x={i * 30 + 15} y="115" fontSize="8" textAnchor="middle" fill="#667085">{String(d.date).slice(8, 10)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const { orgId } = useParams();
  const [d, setD] = useState(null); const [days, setDays] = useState(7); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => api('GET', `/orgs/${orgId}/dashboard?days=${days}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [orgId, days]);

  const toggle = async (level, o) => {
    setErr(''); setMsg('');
    try { await api('POST', `/orgs/${orgId}/objects/${level}/${o.objectId}/status`, { status: o.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }); load(); } catch (x) { setErr(x.message); }
  };
  const launch = async (o) => { setErr(''); try { await api('POST', `/orgs/${orgId}/campaigns/${o.objectId}/launch`); setMsg('🚀 Launch ho gaya'); load(); } catch (x) { setErr(x.message); } };
  const undo = async () => { setErr(''); try { await api('POST', `/orgs/${orgId}/undo`); setMsg('↩️ Last change wapas kar diya'); load(); } catch (x) { setErr(x.message); } };

  if (!d) return <p className="muted">{err || 'Load ho raha hai…'}</p>;
  const t = d.totals;
  return (
    <>
      <div className="row spread">
        <div><h1>Dashboard</h1></div>
        <div className="row">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 140 }}>
            <option value={7}>Pichle 7 din</option><option value={30}>Pichle 30 din</option>
          </select>
          <button onClick={undo}>↩️ Last change undo</button>
          <Link className="btn primary" style={{ background: '#1d4ed8', color: '#fff' }} to={`/orgs/${orgId}/new`}>+ Naya campaign</Link>
        </div>
      </div>
      <div className="money">{days === 7 ? 'Is hafte' : `Pichle ${days} din`} {moneyLine(t) || '₹0 lage'}.</div>
      {err && <div className="err">{err}</div>}{msg && <div className="muted">{msg}</div>}
      <div className="grid g4">
        <div className="card stat"><div className="k">Kharcha</div><div className="v">{inr(t.spend)}</div></div>
        <div className="card stat"><div className="k">Leads</div><div className="v">{t.leads}</div></div>
        <div className="card stat"><div className="k">Ek lead</div><div className="v">{inr(t.cpl)}</div></div>
        <div className="card stat"><div className="k">Ek customer (CRM)</div><div className="v">{inr(t.costPerCustomer)}</div></div>
      </div>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card"><div className="k muted">Roz ka kharcha</div><Bars daily={d.daily} /></div>
        <div className="card">
          <div className="muted">Lead quality</div>
          <div className="stat"><div className="v">{t.outOfAreaPct}%</div><div className="k">leads area ke bahar se {t.outOfAreaPct > 15 && <span className="pill red">15% se zyada</span>}</div></div>
          {d.recommendations && (
            <>
              <div className="muted" style={{ marginTop: 12 }}>Is hafte ke 3 kaam (AI)</div>
              <ol>{d.recommendations.payload.actions.map((a, i) => <li key={i}><b>{a.title}</b> — <span className="muted">{a.why}</span></li>)}</ol>
              {d.recommendations.payload.copies?.length > 0 && (
                <details><summary className="muted" style={{ cursor: 'pointer' }}>AI ke {d.recommendations.payload.copies.length} naye ad text</summary>
                  {d.recommendations.payload.copies.map((c, i) => (
                    <div key={i} className="check"><div style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{c}</div><button onClick={() => navigator.clipboard?.writeText(c)}>Copy</button></div>))}
                </details>)}
            </>
          )}
        </div>
      </div>

      {d.alerts.length > 0 && <><h2>Alerts</h2>{d.alerts.map((a) => <AlertCard key={a.id} orgId={orgId} alert={a} onDone={load} />)}</>}

      <h2>Campaigns</h2>
      <table>
        <thead><tr><th>Naam</th><th>Status</th><th>Kharcha</th><th>Leads</th><th>Ek lead</th><th></th></tr></thead>
        <tbody>{d.campaigns.map((c) => (
          <tr key={c.objectId}><td>{c.name}</td><td><span className={`pill ${c.status === 'ACTIVE' ? 'green' : 'grey'}`}>{c.status === 'ACTIVE' ? 'Chal raha' : 'Ruka hua'}</span></td>
            <td>{inr(c.spend)}</td><td>{c.leads}</td><td>{inr(c.cpl)}</td>
            <td className="row">
              {c.status !== 'ACTIVE' && !c.launched && <button className="primary" onClick={() => launch(c)}>Launch</button>}
              <button onClick={() => toggle('campaign', c)}>{c.status === 'ACTIVE' ? 'Pause' : 'Resume'}</button>
            </td></tr>
        ))}</tbody>
      </table>

      <h2>Ads</h2>
      <table>
        <thead><tr><th>Ad</th><th>Status</th><th>Kharcha</th><th>Leads</th><th>Ek lead</th><th>Frequency</th><th></th></tr></thead>
        <tbody>{d.ads.map((a) => (
          <tr key={a.objectId}><td>{a.name}</td><td><span className={`pill ${a.effectiveStatus === 'DISAPPROVED' ? 'red' : a.status === 'ACTIVE' ? 'green' : 'grey'}`}>{a.effectiveStatus === 'DISAPPROVED' ? 'Reject' : a.status === 'ACTIVE' ? 'Chal raha' : 'Ruka hua'}</span></td>
            <td>{inr(a.spend)}</td><td>{a.leads}</td><td>{inr(a.cpl)}</td><td>{a.frequency ? Number(a.frequency).toFixed(1) : '—'}</td>
            <td><button onClick={() => toggle('ad', a)}>{a.status === 'ACTIVE' ? 'Pause' : 'Resume'}</button></td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
