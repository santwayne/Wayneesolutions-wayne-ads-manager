import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';

/** Loopdesk hub tile -> /sso?ticket=... -> our session. */
export default function Sso() {
  const nav = useNavigate();
  const [msg, setMsg] = useState('Login ho raha hai…');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ticket = q.get('token') || q.get('ticket');
    if (!ticket) { setMsg('This sign-in link is incomplete. Loopdesk se dobara kholiye.'); return; }
    api('POST', '/hub/sso/exchange', { token: ticket })
      .then((r) => { setToken(r.token); nav(r.next || `/orgs/${r.orgId}`, { replace: true }); })
      .catch((e) => setMsg(e.message));
  }, []);
  return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><div className="card">{msg}</div></div>;
}
