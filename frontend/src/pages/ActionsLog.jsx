import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

const WHAT = { pause: 'Pause', resume: 'Resume', budget: 'Budget', launch: 'Launch', create: 'Campaign bana (paused)', undo: 'Undo', ai_decision: 'AI faisla', ai_recommendations: 'AI suggestions', settings: 'Settings', wallet_topup: 'Wallet top-up', reject_suggestion: 'Suggestion mana' };
const show = (x) => (x ? Object.entries(x).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : v}`).join(', ') : '');
export default function ActionsLog() {
  const { orgId } = useParams();
  const [rows, setRows] = useState([]);
  useEffect(() => { api('GET', `/orgs/${orgId}/actions-log`).then(setRows); }, [orgId]);
  return (
    <>
      <h1>Kya badla</h1><p className="sub">Har change: kaun, kya, pehle/baad. Owner Dashboard se last change undo kar sakta hai.</p>
      <table><thead><tr><th>Kab</th><th>Kaun</th><th>Kya</th><th>Object</th><th>Pehle</th><th>Baad</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} style={r.undone_by ? { opacity: 0.5 } : undefined}><td>{new Date(r.created_at).toLocaleString('en-IN')}</td><td>{r.who} <span className="pill grey">{r.source}</span></td>
            <td>{WHAT[r.what] || r.what}{r.undone_by && ' (undo hua)'}</td><td>{r.level} {r.object_id}</td><td className="muted">{show(r.before)}</td><td>{show(r.after)}</td></tr>))}</tbody></table>
    </>
  );
}
