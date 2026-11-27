import React from 'react';
import { inr } from '../api.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const lastMonths = (n = 12) => {
  const out = []; const d = new Date();
  for (let i = 0; i < n; i++) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); d.setMonth(d.getMonth() - 1); }
  return out;
};

function Delta({ now, prev, lowerIsBetter }) {
  if (now == null || prev == null || !prev) return null;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (!pct) return <span className="muted"> (same)</span>;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return <span style={{ color: good ? '#12805c' : '#c53030', fontSize: 13 }}> {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

/** Shared by the in-app Reports page and the public share page (/r/:token). */
export default function ReportView({ r }) {
  const t = r.totals; const p = r.previous;
  const max = Math.max(...r.daily.map((d) => d.spend), 1);
  const Table = ({ title, rows }) => rows.length ? (
    <><h2>{title}</h2><table><thead><tr><th>Naam</th><th>Kharcha</th><th>Leads</th><th>Ek lead</th></tr></thead>
      <tbody>{rows.map((a) => <tr key={a.id}><td>{a.name}</td><td>{inr(a.spend)}</td><td>{a.leads}</td><td>{inr(a.cpl)}</td></tr>)}</tbody></table></>) : null;
  return (
    <>
      <div className="money">{monthLabel(r.month)}: {inr(t.spend)} lage, {t.leads} leads{t.cpl ? `, ek lead ${inr(t.cpl)} ki` : ''}{t.won ? `, ${t.won} customer bane (ek customer ${inr(t.costPerCustomer)} ka)` : ''}.</div>
      <div className="grid g4">
        <div className="card stat"><div className="k">Kharcha</div><div className="v">{inr(t.spend)}</div><Delta now={t.spend} prev={p.spend} /></div>
        <div className="card stat"><div className="k">Leads</div><div className="v">{t.leads}</div><Delta now={t.leads} prev={p.leads} /></div>
        <div className="card stat"><div className="k">Ek lead</div><div className="v">{inr(t.cpl)}</div><Delta now={t.cpl} prev={p.cpl} lowerIsBetter /></div>
        <div className="card stat"><div className="k">Customers (CRM)</div><div className="v">{t.won}</div>{t.costPerCustomer && <div className="muted">ek customer {inr(t.costPerCustomer)} ka</div>}</div>
      </div>
      <div className="grid g3" style={{ marginTop: 14 }}>
        <div className="card stat"><div className="k">Click rate</div><div className="v">{t.ctr != null ? `${t.ctr}%` : '—'}</div></div>
        <div className="card stat"><div className="k">Booked / qualified</div><div className="v">{t.booked}</div></div>
        <div className="card stat"><div className="k">Area ke bahar ki leads</div><div className="v">{t.outOfAreaPct}%</div></div>
      </div>
      {t.googleSpend > 0 && <p className="muted">Isme Google Ads ka kharcha {inr(t.googleSpend)} shamil hai.</p>}
      <h2>Roz ka kharcha</h2>
      <div className="card">{r.daily.length ? (
        <svg viewBox={`0 0 ${r.daily.length * 24} 120`} style={{ width: '100%', height: 150 }} role="img" aria-label="Roz ka kharcha">
          {r.daily.map((d, i) => { const h = (d.spend / max) * 92; return (
            <g key={d.date}><rect x={i * 24 + 4} y={100 - h} width="16" height={h} rx="3" fill="#1d4ed8"><title>{`${d.date}: ${inr(d.spend)}, ${d.leads} leads`}</title></rect>
              <text x={i * 24 + 12} y="114" fontSize="8" textAnchor="middle" fill="#667085">{String(d.date).slice(8, 10)}</text></g>); })}
        </svg>) : <p className="muted">Is mahine abhi data nahi.</p>}</div>
      <Table title="Campaigns" rows={r.campaigns} />
      <Table title="Sabse achhe ads (sasti lead)" rows={r.bestAds} />
      <Table title="Theek karne wale ads" rows={r.worstAds} />
      <h2>Tool ne is mahine kya kiya</h2>
      <p>{r.actions.launched} campaign launch, {r.actions.paused} ads pause, {r.actions.budgetChanges} budget change ({r.actions.byRules} autopilot rules se).</p>
      {r.nextSteps.length > 0 && <><h2>Aage kya karein</h2><ol>{r.nextSteps.slice(0, 3).map((a, i) => <li key={i}><b>{a.title}</b> {a.why && <span className="muted">— {a.why}</span>}</li>)}</ol></>}
    </>
  );
}
