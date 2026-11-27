import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';

/** Phase 2 settings: self-serve Meta connect + Google Ads. */
export default function Connections({ orgId, owner, templates, onChange }) {
  const [meta, setMeta] = useState([]); const [assets, setAssets] = useState(null); const [pick, setPick] = useState({ sector: 'other' });
  const [gCust, setGCust] = useState(null); const [gCamps, setGCamps] = useState([]); const [err, setErr] = useState('');
  const load = () => { api('GET', `/orgs/${orgId}/meta/connection`).then(setMeta).catch(() => {}); api('GET', `/orgs/${orgId}/google/campaigns`).then(setGCamps).catch(() => {}); };
  useEffect(() => { load(); }, [orgId]);
  const run = (fn) => async (...a) => { setErr(''); try { await fn(...a); } catch (x) { setErr(x.message); } };
  const metaLogin = run(async () => { window.location.href = (await api('GET', `/orgs/${orgId}/meta/login-url`)).url; });
  const loadAssets = run(async () => setAssets(await api('GET', `/orgs/${orgId}/meta/my-assets`)));
  const attach = run(async () => {
    const page = assets.pages.find((p) => p.id === pick.page);
    await api('POST', `/orgs/${orgId}/meta/attach`, { metaAccountId: pick.account, pageId: pick.page, instagramId: page?.instagramId, sectorTemplate: pick.sector });
    setAssets(null); onChange?.();
  });
  const googleLogin = run(async () => { window.location.href = (await api('GET', `/orgs/${orgId}/google/login-url`)).url; });
  const loadCust = run(async () => setGCust(await api('GET', `/orgs/${orgId}/google/customers`)));
  const addCust = run(async (customerId) => { await api('POST', `/orgs/${orgId}/google/accounts`, { customerId }); setGCust(null); load(); });
  const gToggle = run(async (c) => { await api('POST', `/orgs/${orgId}/google/campaigns/${c.campaign_id}/status`, { status: c.status === 'ENABLED' ? 'PAUSED' : 'ENABLED' }); load(); });
  const active = meta.find((m) => m.status === 'active' && m.kind === 'user');
  const expired = meta.find((m) => m.status === 'expired');

  return (
    <div className="grid g2" style={{ marginTop: 14 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Meta (Facebook / Instagram)</h2>
        {active ? <p><span className="pill green">Connected</span> <span className="muted">{active.expires_at ? `expiry ${new Date(active.expires_at).toLocaleDateString('en-IN')}` : ''}</span></p>
          : expired ? <p><span className="pill red">Expire ho gaya</span> dobara connect karein</p> : <p className="muted">Agency mode mein Wayne ka Business Manager use hota hai. Khud chalana hai toh connect karein.</p>}
        {owner && <div className="row"><button className="primary" onClick={metaLogin}>{active ? 'Reconnect' : 'Meta connect karo'}</button>{active && <button onClick={loadAssets}>Ad account chuno</button>}</div>}
        {assets && (
          <div style={{ marginTop: 12 }}>
            <label>Ad account</label><select onChange={(e) => setPick({ ...pick, account: e.target.value })}><option value="">—</option>{assets.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}</select>
            <label>Facebook Page</label><select onChange={(e) => setPick({ ...pick, page: e.target.value })}><option value="">—</option>{assets.pages.map((p) => <option key={p.id} value={p.id} disabled={!p.canAdvertise}>{p.name}{p.canAdvertise ? '' : ' (ADVERTISE access nahi)'}</option>)}</select>
            <label>Business type</label><select value={pick.sector} onChange={(e) => setPick({ ...pick, sector: e.target.value })}>{templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
            <button className="primary" style={{ marginTop: 10 }} disabled={!pick.account || !pick.page} onClick={attach}>Jodo</button>
          </div>
        )}
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Google Ads</h2>
        {owner && <div className="row"><button onClick={googleLogin}>Google Ads connect karo</button><button onClick={loadCust}>Account chuno</button></div>}
        {gCust && <div style={{ marginTop: 10 }}>{gCust.map((c) => <div key={c} className="row spread check"><span>{c}</span><button onClick={() => addCust(c)}>Jodo</button></div>)}</div>}
        {gCamps.length > 0 && (
          <table style={{ marginTop: 12 }}><thead><tr><th>Campaign</th><th>7 din</th><th>Conv.</th><th></th></tr></thead>
            <tbody>{gCamps.map((c) => <tr key={c.campaign_id}><td>{c.name}<div className="muted">{c.channel}</div></td><td>{inr(c.spend)}</td><td>{c.leads}</td><td><button onClick={() => gToggle(c)}>{c.status === 'ENABLED' ? 'Pause' : 'Enable'}</button></td></tr>)}</tbody></table>
        )}
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
