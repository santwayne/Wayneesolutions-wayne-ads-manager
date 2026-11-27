import React, { useState } from 'react';
import { api } from '../api.js';

/** Reads a video file's size/length in the browser and grabs a cover frame (JPEG). */
function readVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.src = url;
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 1) / 3); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob((cover) => { URL.revokeObjectURL(url); resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, cover }); }, 'image/jpeg', 0.9);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ye video file padh nahi paaye (mp4 / mov chahiye)')); };
  });
}

export default function MediaPicker({ orgId, draft, onMedia }) {
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [link, setLink] = useState(''); const [studio, setStudio] = useState(null);
  const media = draft.data.media || [];
  const full = media.length >= 5;
  const run = (k, fn) => async (...a) => { setBusy(k); setErr(''); try { await fn(...a); } catch (x) { setErr(x.message); } finally { setBusy(''); } };
  const base = `/orgs/${orgId}/drafts/${draft.id}`;

  const addFiles = run('upload', async (files) => {
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        onMedia((await api('POST', `${base}/media`, f, { raw: true, contentType: f.type })).media);
      } else if (f.type.startsWith('video/')) {
        if (f.size > 200e6) throw new Error('Video 200 MB se chhoti honi chahiye');
        const meta = await readVideo(f);
        const up = await api('POST', `${base}/media/video?width=${meta.width}&height=${meta.height}&duration=${meta.duration.toFixed(1)}&name=${encodeURIComponent(f.name.slice(0, 100))}`, f, { raw: true, contentType: f.type });
        const idx = up.media.length - 1;
        onMedia((await api('POST', `${base}/media/${idx}/thumbnail`, meta.cover, { raw: true, contentType: 'image/jpeg' })).media);
      }
    }
  });
  const addLink = run('link', async (item) => { onMedia((await api('POST', `${base}/media`, { type: 'video', ...item })).media); setLink(''); });
  const openStudio = run('studio', async () => setStudio(await api('GET', `/orgs/${orgId}/video-studio/videos`)));
  const remove = run('rm', async (i) => onMedia((await api('DELETE', `${base}/media/${i}`)).media));
  const setCover = run('cover', async (i, file) => onMedia((await api('POST', `${base}/media/${i}/thumbnail`, file, { raw: true, contentType: file.type })).media));

  return (
    <>
      <h2>Photo / video (3–5)</h2>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input type="file" accept="image/*,video/mp4,video/quicktime" multiple disabled={full || !!busy} onChange={(e) => addFiles([...e.target.files])} style={{ maxWidth: 320 }} />
        <button type="button" disabled={full || !!busy} onClick={openStudio}>🎬 AI Video Studio se</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="Ya video ka https link paste karo (jaise AI Video Studio ki download link)" value={link} onChange={(e) => setLink(e.target.value)} />
        <button type="button" disabled={!link || full || !!busy} onClick={() => addLink({ fileUrl: link, aspect: '9:16', source: 'link' })}>Jodo</button>
      </div>
      {busy && <p className="muted">{busy === 'upload' ? 'Upload + quality check ho raha hai… (video mein thoda time lagta hai)' : 'Ek second…'}</p>}
      {err && <div className="err">{err}</div>}
      {studio && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row spread"><b>AI Video Studio ke videos</b><button type="button" onClick={() => setStudio(null)}>Band karo</button></div>
          {!studio.length && <p className="muted">Koi tayyar video nahi mila.</p>}
          <div className="thumbs" style={{ marginTop: 8 }}>{studio.map((v) => (
            <button type="button" key={v.id} className="choice" style={{ width: 150, padding: 8 }} onClick={() => addLink({ fileUrl: v.url, thumbnailUrl: v.thumbnailUrl || undefined, aspect: v.aspect || undefined, width: v.width || undefined, height: v.height || undefined, durationSec: v.durationSec || undefined, source: 'video_studio', title: v.title })}>
              {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" style={{ width: '100%', height: 110 }} />}
              <div style={{ fontSize: 12 }}>{v.title} · {v.aspect} · {v.durationSec}s</div>
            </button>))}</div>
        </div>
      )}
      <div className="thumbs" style={{ marginTop: 10 }}>{media.map((m, i) => (
        <div key={i} style={{ position: 'relative' }}>
          {m.type === 'video' ? (
            m.thumbnailUrl ? <img src={m.thumbnailUrl} alt={`video ${i + 1}`} /> : <div style={{ width: 110, height: 110, border: '1px dashed #c00', borderRadius: 8, display: 'grid', placeItems: 'center', fontSize: 12 }}>Cover nahi</div>
          ) : <img src={m.url} alt={`photo ${i + 1}`} />}
          <div style={{ fontSize: 11 }} className="muted">{m.type === 'video' ? `🎬 ${m.durationSec ? `${Math.round(m.durationSec)}s` : ''}` : '🖼️'} {m.width && m.height ? `${m.width}×${m.height}` : ''}</div>
          <div className="row" style={{ gap: 4 }}>
            <button type="button" style={{ padding: '2px 6px', fontSize: 12 }} onClick={() => remove(i)}>Hatao</button>
            {m.type === 'video' && <label style={{ margin: 0, fontSize: 12, cursor: 'pointer' }}>Cover<input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && setCover(i, e.target.files[0])} /></label>}
          </div>
        </div>
      ))}</div>
    </>
  );
}
