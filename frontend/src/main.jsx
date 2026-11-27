import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { getToken } from './api.js';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';
import Agency from './pages/Agency.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Wizard from './wizard/Wizard.jsx';
import Alerts from './pages/Alerts.jsx';
import Leads from './pages/Leads.jsx';
import ActionsLog from './pages/ActionsLog.jsx';
import Wallet from './pages/Wallet.jsx';
import Settings from './pages/Settings.jsx';
import Sso from './pages/Sso.jsx';
import OAuthConsent from './pages/OAuthConsent.jsx';
import Signup from './pages/Signup.jsx';

const Private = ({ children }) => (getToken() ? children : <Navigate to="/login" replace />);

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/sso" element={<Sso />} />
      <Route path="/oauth/consent" element={<OAuthConsent />} />
      <Route element={<Private><Layout /></Private>}>
        <Route path="/" element={<Agency />} />
        <Route path="/orgs/:orgId" element={<Dashboard />} />
        <Route path="/orgs/:orgId/new" element={<Wizard />} />
        <Route path="/orgs/:orgId/alerts" element={<Alerts />} />
        <Route path="/orgs/:orgId/leads" element={<Leads />} />
        <Route path="/orgs/:orgId/log" element={<ActionsLog />} />
        <Route path="/orgs/:orgId/wallet" element={<Wallet />} />
        <Route path="/orgs/:orgId/settings" element={<Settings />} />
      </Route>
    </Routes>
  </BrowserRouter>,
);
