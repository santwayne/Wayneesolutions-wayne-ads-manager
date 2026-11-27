import React, { useState } from 'react';
import { api } from '../api.js';

export default function AlertCard({ orgId, alert, onDone }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const act = alert.suggested_action && ['pause', 'budget'].includes(alert.suggested_action.type);
  const decide = async (approve) => {
    setBusy(true); setErr('');
    try { await api('POST', `/orgs/${orgId}/alerts/${alert.id}/decision`, { approve }); onDone?.(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className={`card alert ${alert.severity}`} style={{ marginBottom: 10 }}>
      <div className="row spread">
        <div>{alert.message}</div>
        {alert.dry_run && <span className="pill grey">dry run</span>}
      </div>
      {alert.suggested_action?.newText && <p className="muted">Naya policy-safe text: “{alert.suggested_action.newText}”</p>}
      {alert.suggested_action?.drafts && <ul className="muted">{alert.suggested_action.drafts.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      {act && alert.status === 'open' && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={busy} onClick={() => decide(true)}>Haan</button>
          <button disabled={busy} onClick={() => decide(false)}>Na</button>
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
