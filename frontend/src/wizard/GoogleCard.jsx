import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

/** Review step: optional Google Search campaign from the same draft (created PAUSED). */
export default function GoogleCard({ orgId, draft }) {
  const [accounts, setAccounts] = useState([]);
  const [acc, setAcc] = useState(''); const [budget, setBudget] = useState(500); const [url, setUrl] = useState(draft.data.websiteUrl || '');
  const [copy, setCopy] = useState(draft.data.google || null); const [v, setV] = useState(null);
  const [created, setCreated] = useState(draft.google_campaign_id ? { campaignId: draft.google_campaign_id } : null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { api('GET', `/orgs/${orgId}/google/accounts`).then((a) => { setAccounts(a); if (a[0]) setAcc(a[0].id); }).catch(() => {}); }, [orgId]);
  const check = async () => setV(await api('GET', `/orgs/${orgId}/drafts/${draft.id}/google/validate?dailyBudget=${budget}&websiteUrl=${encodeURIComponent(url)}`));
  useEffect(() => { if (copy) check(); }, [copy, budget, url]);
  const run = (k, fn) => async () => { setBusy(k); setErr(''); try { await fn(); } catch (x) { setErr(x.details?.map?.((d) => d.message).join(' · ') || x.message); } finally { setBusy(''); } };
  const gen = run('copy', async () => { if (url) await api('PATCH', `/orgs/${orgId}/drafts/${draft.id}`, { websiteUrl: url }); setCopy(await api('POST', `/orgs/${orgId}/drafts/${draft.id}/google/copy`)); });
  const create = run('create', async () => setCreated(await api('POST', `/orgs/${orgId}/drafts/${draft.id}/google/create`, { googleAccountId: Number(acc), dailyBudget: Number(budget), websiteUrl: url || undefined })));
  const enable = run('enable', async () => { await api('POST', `/orgs/${orgId}/google/campaigns/${created.campaignId}/status`, { status: 'ENABLED' }); setCreated({ ...created, live: true }); });

  if (!accounts.length) return <div className="card" style={{ marginTop: 14 }}><b>Google pe bhi chalana hai?</b><div className="muted">Settings mein Google Ads connect karo.</div></div>;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Google Search pe bhi (optional)</h2>
      <p className="muted">Jo log Google pe dhoondh rahe hain unhe ad. Sirf area ke andar wale log. Pehle PAUSED banega.</p>
      <div className="grid g2">
        <div><label>Google account</label><select value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name || a.customer_id}</option>)}</select></div>
        <div><label>Daily budget: {inr(budget)} (~{inr(budget * 30.4)}/mahina)</label><input type="range" min="100" max="5000" step="50" value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></div>
      </div>
      <label>Landing page / website (https://)</label><input value={url} onChange={(e) => setUrl(e.target.value)} />
      <button style={{ marginTop: 10 }} disabled={busy === 'copy'} onClick={gen}>{busy === 'copy' ? 'AI likh raha hai…' : '✨ Google ads text + keywords banao'}</button>
      {copy && (
        <div className="grid g3" style={{ marginTop: 10 }}>
          <div><b>Headlines</b><ul>{copy.headlines.map((h) => <li key={h}>{h}</li>)}</ul></div>
          <div><b>Descriptions</b><ul>{copy.descriptions.map((h) => <li key={h}>{h}</li>)}</ul></div>
          <div><b>Keywords</b><ul>{copy.keywords.map((h) => <li key={h}>"{h}"</li>)}</ul></div>
        </div>
      )}
      {v?.checks?.map((c, i) => <div className="check" key={i}><span className={`dot ${c.level}`} />{c.message}</div>)}
      {err && <div className="err">{err}</div>}
      {!created ? <button className="primary" disabled={!copy || v?.blocking || busy === 'create'} onClick={create}>Google campaign banao (paused)</button>
        : <div className="row">✅ Google campaign {created.campaignId} {created.live ? 'live hai' : 'PAUSED bana'} {!created.live && <button className="primary" disabled={busy === 'enable'} onClick={enable}>🚀 Google pe launch</button>}</div>}
    </div>
  );
}
