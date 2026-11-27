import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

/**
 * Loopdesk AI Ads (AI Video Studio) -> wizard import.
 * Both tools are provisioned by the Loopdesk hub with the same hubBusinessId, so we ask
 * Video Studio for that business's finished videos with a short-lived tool-to-tool token:
 *   GET {VIDEO_STUDIO_API_URL}/api/v1/hub/videos   Authorization: Bearer <JWT>
 *   JWT HS256 (VIDEO_STUDIO_LINK_SECRET): iss "wayne-ads", aud "videoStudio", purpose "list_videos",
 *   sub <hubBusinessId>, jti, exp 2 min
 * The Video Studio side of this endpoint is in docs/video-studio-patch/ (not merged there yet).
 * Until then the wizard imports a finished video by its link.
 */
let vfetch = (u, i) => fetch(u, i);
export function setVideoStudioFetch(fn) { vfetch = fn; }

export const videoStudioConfigured = () => Boolean(process.env.VIDEO_STUDIO_API_URL && process.env.VIDEO_STUDIO_LINK_SECRET);

export function videoStudioToken(hubBusinessId) {
  return jwt.sign({ purpose: 'list_videos', jti: crypto.randomUUID() }, process.env.VIDEO_STUDIO_LINK_SECRET,
    { algorithm: 'HS256', issuer: 'wayne-ads', audience: 'videoStudio', subject: String(hubBusinessId), expiresIn: '2m' });
}

export async function listStudioVideos(orgId) {
  if (!videoStudioConfigured()) throw new AppError(501, 'video_studio_not_linked', 'AI Video Studio abhi juda nahi hai. Video ka link paste karke import karein.');
  const { rows: [org] } = await query('SELECT hub_business_id FROM orgs WHERE id = $1', [orgId]);
  if (!org?.hub_business_id) throw new AppError(409, 'not_hub_client', 'Ye business Loopdesk bundle mein nahi hai, isliye Video Studio list nahi aa sakti. Video ka link paste karein.');
  const base = process.env.VIDEO_STUDIO_API_URL.replace(/\/$/, '');
  const r = await vfetch(`${base}/api/v1/hub/videos`, { headers: { authorization: `Bearer ${videoStudioToken(org.hub_business_id)}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AppError(502, 'video_studio_error', j.detail || `Video Studio ${r.status}`);
  return (j.items || []).map((v) => ({
    id: v.id, title: v.title || v.brief || 'Video', url: v.url, thumbnailUrl: v.thumbnail_url || null,
    durationSec: v.seconds ?? null, aspect: v.aspect || null, width: v.width ?? null, height: v.height ?? null, createdAt: v.created_at || null,
  }));
}
