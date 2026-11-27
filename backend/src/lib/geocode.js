import { logger } from './logger.js';

/** Area text -> lat/lng. Google Geocoding if GOOGLE_MAPS_API_KEY is set; otherwise null
 *  (WhatsApp mode then asks the client to share a location pin). */
export async function geocode(text) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !text) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?region=in&address=${encodeURIComponent(text)}&key=${key}`;
    const r = await (await fetch(url)).json();
    const g = r.results?.[0];
    return g ? { lat: g.geometry.location.lat, lng: g.geometry.location.lng, label: g.formatted_address } : null;
  } catch (e) { logger.warn({ err: e.message }, 'geocode failed'); return null; }
}
