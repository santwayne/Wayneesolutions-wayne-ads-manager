import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReportView, { lastMonths, monthLabel } from '../components/ReportView.jsx';

/** Public live report (share link, no login). */
export default function PublicReport() {
  const { token } = useParams();
  const [month, setMonth] = useState(lastMonths(1)[0]);
  const [r, setR] = useState(null); const [err, setErr] = useState('');
  const base = `${import.meta.env.VITE_API_URL || ''}/api/public/reports/${encodeURIComponent(token)}`;
  useEffect(() => {
    setR(null);
    fetch(`${base}?month=${month}`).then(async (res) => { const j = await res.json(); if (!res.ok) throw new Error(j.message || 'Report nahi mili'); setR(j); }).catch((e) => setErr(e.message));
  }, [month]);
  return (
    <main style={{ margin: '0 auto' }}>
      <div className="row spread">
        <div><h1>{r?.business || 'Ads report'}</h1><p className="sub">Live report · Wayne Ads Manager</p></div>
        {!err && <div className="row">
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 170 }}>{lastMonths(12).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
          <a className="btn" href={`${base}/pdf?month=${month}`}>⬇ PDF</a>
        </div>}
      </div>
      {err ? <div className="card">{err}</div> : r ? <ReportView r={r} /> : <p className="muted">Load ho raha hai…</p>}
    </main>
  );
}
