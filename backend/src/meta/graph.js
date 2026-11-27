import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Thin Graph API client.
 *
 * Why not facebook-nodejs-business-sdk for transport: the SDK pins the Graph API
 * version per SDK release (FacebookAdsApi.VERSION is a constant), and the spec says
 * the version must come from config, never hardcoded. So transport lives here and
 * the version is META_API_VERSION. Object shapes/field names follow the SDK + docs.
 *
 * Safety nets enforced here (in addition to the services):
 *  - create calls for campaigns / adsets / ads MUST carry status=PAUSED
 *  - nothing ever touches billing / funding source / payment endpoints
 *  - META_WRITES_DISABLED=1 blocks all writes (sandbox / dry-run deployments)
 *  - x-business-use-case-usage / x-app-usage headers are read and we back off
 */

const CREATE_EDGES = /\/(campaigns|adsets|ads)$/;
const BLOCKED_PATHS = /(funding_source|payment|billing|adspaymentcycle|extended_credit)/i;
const BLOCKED_FIELDS = ['funding_source', 'payment_method', 'spend_cap_action'];

export class MetaApiError extends Error {
  constructor(err, status) {
    super(err?.error_user_msg || err?.message || 'Meta API error');
    this.status = status;
    this.code = err?.code;
    this.subcode = err?.error_subcode;
    this.type = err?.type;
    this.userTitle = err?.error_user_title;
    this.fbtraceId = err?.fbtrace_id;
  }
  get isTokenError() { return this.code === 190 || this.type === 'OAuthException' && [102, 190, 463, 467].includes(this.code); }
  get isRateLimit() { return [4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014].includes(this.code); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per business-use-case throttle state: account id -> resume timestamp
const throttleUntil = new Map();

export function parseUsageHeaders(headers) {
  const out = { maxPct: 0, waitSeconds: 0 };
  const buc = headers.get?.('x-business-use-case-usage') ?? headers['x-business-use-case-usage'];
  if (buc) {
    try {
      const data = JSON.parse(buc);
      for (const id of Object.keys(data)) {
        for (const u of data[id]) {
          out.maxPct = Math.max(out.maxPct, u.call_count || 0, u.total_cputime || 0, u.total_time || 0);
          out.waitSeconds = Math.max(out.waitSeconds, (u.estimated_time_to_regain_access || 0) * 60);
        }
      }
    } catch { /* ignore malformed header */ }
  }
  const app = headers.get?.('x-app-usage') ?? headers['x-app-usage'];
  if (app) {
    try {
      const a = JSON.parse(app);
      out.maxPct = Math.max(out.maxPct, a.call_count || 0, a.total_cputime || 0, a.total_time || 0);
    } catch { /* ignore */ }
  }
  return out;
}

function appSecretProof(token) {
  if (!config.meta.appSecret) return undefined;
  return crypto.createHmac('sha256', config.meta.appSecret).update(token).digest('hex');
}

function encodeParams(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    sp.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return sp;
}

export function assertWriteAllowed(method, path, params = {}) {
  if (method === 'GET') return;
  if (config.meta.writesDisabled) throw new Error('Meta writes disabled (META_WRITES_DISABLED=1)');
  if (BLOCKED_PATHS.test(path)) throw new Error('Billing/payment endpoints are never touched by this tool');
  for (const f of BLOCKED_FIELDS) if (f in params) throw new Error(`Field ${f} is not allowed`);
  if (method === 'POST' && CREATE_EDGES.test(path) && params.status !== 'PAUSED') {
    throw new Error('New campaigns/ad sets/ads must be created with status=PAUSED');
  }
}

export function createGraphClient({ token, fetchImpl = globalThis.fetch, throttleKey = 'default' } = {}) {
  if (!token) throw new Error('Graph client needs a token');
  const base = `${config.meta.graphBase}/${config.meta.apiVersion}`;

  async function request(method, path, params = {}, { retries = 3 } = {}) {
    assertWriteAllowed(method, path, params);
    const wait = (throttleUntil.get(throttleKey) || 0) - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 60_000));

    const all = { ...params, access_token: token, appsecret_proof: appSecretProof(token) };
    const url = new URL(`${base}/${String(path).replace(/^\//, '')}`);
    let body;
    if (method === 'GET') url.search = encodeParams(all).toString();
    else body = encodeParams(all);

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method, body, headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined });
      const usage = parseUsageHeaders(res.headers);
      if (usage.waitSeconds > 0) throttleUntil.set(throttleKey, Date.now() + usage.waitSeconds * 1000);
      else if (usage.maxPct >= 90) throttleUntil.set(throttleKey, Date.now() + 60_000);
      else if (usage.maxPct >= 75) throttleUntil.set(throttleKey, Date.now() + 5_000);

      const json = await res.json().catch(() => ({}));
      if (res.ok && !json.error) return json;

      const err = new MetaApiError(json.error, res.status);
      const transient = err.isRateLimit || res.status >= 500 || json.error?.is_transient;
      if (transient && attempt < retries) {
        const backoff = Math.max(usage.waitSeconds * 1000, 2 ** attempt * 2000);
        logger.warn({ path, code: err.code, attempt, backoff }, 'meta transient error, backing off');
        await sleep(Math.min(backoff, 120_000));
        continue;
      }
      throw err;
    }
  }

  /** Follows paging.next for list edges. */
  async function getAll(path, params = {}, max = 5000) {
    const out = [];
    let res = await request('GET', path, { limit: 200, ...params });
    for (;;) {
      out.push(...(res.data || []));
      const after = res.paging?.cursors?.after;
      if (!res.paging?.next || !after || out.length >= max) break;
      res = await request('GET', path, { limit: 200, ...params, after });
    }
    return out;
  }

  /** Graph batch API (max 50 per call). Each item: {method, relative_url, body?} */
  async function batch(items) {
    const results = [];
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      for (const it of chunk) {
        const [p] = it.relative_url.split('?');
        const bodyParams = it.body ? Object.fromEntries(new URLSearchParams(it.body)) : {};
        assertWriteAllowed(it.method, p, bodyParams);
      }
      const res = await request('POST', '', { batch: chunk, include_headers: false });
      for (const r of res) {
        let parsed = null;
        try { parsed = r?.body ? JSON.parse(r.body) : null; } catch { parsed = null; }
        results.push({ code: r?.code, body: parsed });
      }
    }
    return results;
  }

  /**
   * Async insights report job (for big date ranges, spec "Rate limits").
   * Polls until complete, then pages through results.
   */
  async function asyncInsights(objectId, params, { pollMs = 5000, timeoutMs = 15 * 60_000 } = {}) {
    const job = await request('POST', `${objectId}/insights`, params);
    const runId = job.report_run_id;
    const started = Date.now();
    for (;;) {
      const st = await request('GET', runId, { fields: 'async_status,async_percent_completion' });
      if (st.async_status === 'Job Completed') break;
      if (st.async_status === 'Job Failed' || st.async_status === 'Job Skipped') throw new Error(`Insights job ${st.async_status}`);
      if (Date.now() - started > timeoutMs) throw new Error('Insights job timeout');
      await sleep(pollMs);
    }
    return getAll(`${runId}/insights`);
  }

  /** Multipart upload (video files to /advideos). Same write guards as every other call. */
  async function upload(path, fields, file) {
    assertWriteAllowed('POST', path, fields);
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...fields, access_token: token, appsecret_proof: appSecretProof(token) })) if (v != null) form.append(k, String(v));
    form.append('source', new Blob([file.buffer], { type: file.mimeType || 'video/mp4' }), file.name || 'video.mp4');
    const res = await fetchImpl(`${base}/${String(path).replace(/^\//, '')}`, { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new MetaApiError(json.error, res.status);
    return json;
  }

  return {
    upload,
    get: (p, params, o) => request('GET', p, params, o),
    post: (p, params, o) => request('POST', p, params, o),
    del: (p, params, o) => request('DELETE', p, params, o),
    getAll, batch, asyncInsights,
  };
}
