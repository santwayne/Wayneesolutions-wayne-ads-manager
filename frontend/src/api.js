const BASE = import.meta.env.VITE_API_URL || '';

export function getToken() { return localStorage.getItem('wam_token'); }
export function setToken(t) { if (t) localStorage.setItem('wam_token', t); else localStorage.removeItem('wam_token'); }

export async function api(method, path, body, { raw, contentType } = {}) {
  const headers = {};
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = contentType;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401) { setToken(null); window.location.href = '/login'; throw new Error('Login karein'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || 'Error'); e.details = json.details; e.status = res.status; throw e; }
  return json;
}

export const inr = (n) => (n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
export const moneyLine = (t) => t ? `${inr(t.spend)} lage, ${t.leads} leads${t.cpl ? `, ek lead ${inr(t.cpl)} ki` : ''}${t.won ? `, ${t.won} customer bane (ek customer ${inr(t.costPerCustomer)} ka)` : ''}` : '';
