import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

const LABEL = { new: 'Nayi', contacted: 'Baat hui', qualified: 'Qualified', consultation_booked: 'Booked', won: 'Customer', lost: 'Lost', junk: 'Junk' };
export default function Leads() {
  const { orgId } = useParams();
  const [rows, setRows] = useState([]);
  useEffect(() => { api('GET', `/orgs/${orgId}/leads`).then(setRows); }, [orgId]);
  return (
    <>
      <h1>Leads</h1><p className="sub">Meta lead form → CRM → WayneRing. Status CRM se update hota hai.</p>
      <table><thead><tr><th>Kab</th><th>Naam</th><th>Phone</th><th>City / pincode</th><th>Status</th><th>CRM</th></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}><td>{new Date(l.created_at).toLocaleString('en-IN')}</td><td>{l.name}</td><td>{l.phone}</td>
            <td>{l.city} {l.pincode} {l.out_of_area && <span className="pill red">out of area</span>}</td>
            <td><span className={`pill ${l.status === 'won' ? 'green' : l.status === 'junk' || l.status === 'lost' ? 'red' : 'grey'}`}>{LABEL[l.status]}</span></td>
            <td>{l.crm_lead_id ? '✓' : <span className="muted">retry…</span>}</td></tr>))}
        {!rows.length && <tr><td colSpan="6" className="muted">Abhi koi lead nahi.</td></tr>}</tbody></table>
    </>
  );
}
