import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import AlertCard from '../components/AlertCard.jsx';

export default function Alerts() {
  const { orgId } = useParams();
  const [status, setStatus] = useState('open'); const [rows, setRows] = useState([]);
  const load = () => api('GET', `/orgs/${orgId}/alerts${status ? `?status=${status}` : ''}`).then(setRows);
  useEffect(() => { load(); }, [orgId, status]);
  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">Tool har ghante check karta hai. Learning phase (pehle 3–7 din) mein bade change suggest nahi hote.</p>
      <div className="row" style={{ marginBottom: 14 }}>{[['open', 'Faisla baaki'], ['dry_run', 'Dry run'], ['approved', 'Haan kiya'], ['rejected', 'Na kiya'], ['auto_applied', 'Auto-mode'], ['', 'Sab']].map(([k, l]) => <button key={k} className={status === k ? 'primary' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      {rows.map((a) => <AlertCard key={a.id} orgId={orgId} alert={a} onDone={load} />)}
      {!rows.length && <p className="muted">Koi alert nahi. 👍</p>}
    </>
  );
}
