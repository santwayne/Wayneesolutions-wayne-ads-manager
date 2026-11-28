import React from 'react';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import Agency from './Agency.jsx';

/**
 * "/" decides which panel a user gets:
 *  - Wayne team (member of the agency org) = super admin: list of all clients + "Naya client".
 *  - A client's own users: straight into their business panel. They never see other clients.
 */
export default function Home() {
  const { me } = useOutletContext();
  if (!me) return <p className="muted">Load ho raha hai…</p>;
  if (me.isAgency) return <Agency />;

  const mine = me.orgs.filter((o) => o.type === 'business');
  if (mine.length === 1) return <Navigate to={`/orgs/${mine[0].id}`} replace />;
  if (!mine.length) return <div className="card">Aapke account se abhi koi business juda nahi hai. Wayne team se sampark karein.</div>;
  // Rare: one person owns more than one business. Show only their own, no client list or numbers.
  return (
    <>
      <h1>Apna business chuniye</h1>
      <div className="card">
        {mine.map((o) => <div key={o.id} style={{ padding: '8px 0' }}><Link to={`/orgs/${o.id}`}>{o.name}</Link></div>)}
      </div>
    </>
  );
}
