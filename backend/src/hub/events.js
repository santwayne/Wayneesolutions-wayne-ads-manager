import { config } from '../config.js';
import { query } from '../lib/db.js';

/** Events back to the hub (Growth Manager): lead created, campaign launched, weekly totals. */
export async function queueHubEvent(orgId, type, payload) {
  const { rows: [o] } = await query('SELECT hub_business_id FROM orgs WHERE id = $1', [orgId]);
  if (!o?.hub_business_id) return;
  await query('INSERT INTO hub_events_outbox (org_id, type, payload) VALUES ($1,$2,$3)', [orgId, type, JSON.stringify({ ...payload, hub_business_id: o.hub_business_id })]);
}

export async function flushHubEvents(fetchImpl = fetch) {
  if (!config.hub.eventsUrl || !config.hub.eventsKey) return { sent: 0 };
  const { rows } = await query('SELECT * FROM hub_events_outbox WHERE sent_at IS NULL AND attempts < 10 ORDER BY id LIMIT 100');
  let sent = 0;
  for (const e of rows) {
    try {
      const r = await fetchImpl(config.hub.eventsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.hub.eventsKey}` },
        body: JSON.stringify({ source: 'wayne-ads', type: e.type, occurred_at: e.created_at, business_id: e.payload.hub_business_id, data: e.payload }),
      });
      if (!r.ok) throw new Error(`hub ${r.status}`);
      await query('UPDATE hub_events_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [e.id]);
      sent++;
    } catch {
      await query('UPDATE hub_events_outbox SET attempts = attempts + 1 WHERE id = $1', [e.id]);
    }
  }
  return { sent };
}
