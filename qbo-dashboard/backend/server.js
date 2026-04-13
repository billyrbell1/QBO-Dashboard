const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme-use-env-var',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const QB_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const ENTITIES = [
  { id: 'p1capital',     name: 'P1 Capital LLC',           type: 'Holding / operating',       realmId: null },
  { id: 'bellrei',       name: 'Bell REI, LLC',             type: 'Real estate investment',    realmId: null },
  { id: 'collegeave',   name: 'College Ave',               type: 'Short-term rental',         realmId: null },
  { id: 'gainesville',  name: 'Gainesville 19th DR, LLC',  type: '15-unit industrial rental', realmId: null },
];

const PLACEHOLDER = {
  id: 'offshore', name: 'Offshore Construction, LLC', type: 'Window & door installation', status: 'placeholder'
};

let tokenStore = {};

function getAuthHeader() {
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  return `Basic ${creds}`;
}

async function refreshTokenIfNeeded(entityId) {
  const t = tokenStore[entityId];
  if (!t) return null;
  if (Date.now() < t.expiresAt - 60000) return t.accessToken;
  try {
    const res = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken }),
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokenStore[entityId] = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresAt: Date.now() + res.data.expires_in * 1000,
      realmId: t.realmId
    };
    return tokenStore[entityId].accessToken;
  } catch (err) {
    console.error(`Token refresh failed for ${entityId}:`, err.message);
    return null;
  }
}

async function qboGet(entityId, endpoint) {
  const token = await refreshTokenIfNeeded(entityId);
  if (!token) throw new Error(`Not authenticated: ${entityId}`);
  const realmId = tokenStore[entityId].realmId;
  const res = await axios.get(`${QB_BASE}/${realmId}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  return res.data;
}

async function fetchPL(entityId, startDate, endDate) {
  const data = await qboGet(entityId, `reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=65`);
  return parsePL(data);
}

async function fetchBS(entityId, asOfDate) {
  const data = await qboGet(entityId, `reports/BalanceSheet?date_macro=Today&minorversion=65`);
  return parseBS(data);
}

function findRow(rows, name) {
  if (!rows) return 0;
  for (const row of rows) {
    if (row.type === 'Section' && row.group === name && row.summary) {
      const col = row.summary.ColData;
      return col && col[1] ? parseFloat(col[1].value) || 0 : 0;
    }
    if (row.Rows) {
      const found = findRow(row.Rows.Row, name);
      if (found !== 0) return found;
    }
  }
  return 0;
}

function parsePL(raw) {
  try {
    const rows = raw.Rows?.Row || [];
    const revenue = findRow(rows, 'Income') || findRow(rows, 'Revenue') || 0;
    const cogs = findRow(rows, 'CostOfGoodsSold') || findRow(rows, 'COGS') || 0;
    const gross = revenue - cogs;
    const opex = findRow(rows, 'Expenses') || findRow(rows, 'OperatingExpenses') || 0;
    const net = findRow(rows, 'NetIncome') || (gross - opex);
    return { revenue, cogs, gross, opex, net };
  } catch (e) {
    return { revenue: 0, cogs: 0, gross: 0, opex: 0, net: 0 };
  }
}

function parseBS(raw) {
  try {
    const rows = raw.Rows?.Row || [];
    const cash = findRow(rows, 'BankAccounts') || findRow(rows, 'CurrentAssets') || 0;
    const ar = findRow(rows, 'AccountsReceivable') || 0;
    const totalAssets = findRow(rows, 'TotalAssets') || findRow(rows, 'Assets') || 0;
    const totalLiab = findRow(rows, 'TotalLiabilities') || findRow(rows, 'Liabilities') || 0;
    const equity = findRow(rows, 'TotalEquity') || findRow(rows, 'Equity') || 0;
    return { cash, ar, totalAssets, totalLiab, equity };
  } catch (e) {
    return { cash: 0, ar: 0, totalAssets: 0, totalLiab: 0, equity: 0 };
  }
}

function getDateRange(period) {
  const now = new Date();
  const y = now.getFullYear();
  const ranges = {
    ytd:  { start: `${y}-01-01`,       end: now.toISOString().slice(0,10) },
    q1:   { start: `${y}-01-01`,       end: `${y}-03-31` },
    q2:   { start: `${y}-04-01`,       end: `${y}-06-30` },
    q3:   { start: `${y}-07-01`,       end: `${y}-09-30` },
    q4:   { start: `${y}-10-01`,       end: `${y}-12-31` },
    fy24: { start: `${y-1}-01-01`,     end: `${y-1}-12-31` },
  };
  return ranges[period] || ranges.ytd;
}

app.get('/api/entities', (req, res) => {
  const result = ENTITIES.map(e => ({
    ...e,
    connected: !!tokenStore[e.id]
  }));
  result.push({ ...PLACEHOLDER, connected: false });
  res.json(result);
});

app.get('/auth/connect/:entityId', (req, res) => {
  const { entityId } = req.params;
  const entity = ENTITIES.find(e => e.id === entityId);
  if (!entity) return res.status(404).json({ error: 'Unknown entity' });
  req.session.connectingEntityId = entityId;
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: REDIRECT_URI,
    state: entityId,
  });
  res.redirect(`${AUTH_BASE}?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  if (error) return res.send(`<h2>Auth error: ${error}</h2>`);
  const entityId = state;
  const entity = ENTITIES.find(e => e.id === entityId);
  if (!entity) return res.status(400).send('Unknown entity');
  try {
    const tokenRes = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokenStore[entityId] = {
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
      expiresAt: Date.now() + tokenRes.data.expires_in * 1000,
      realmId
    };
    entity.realmId = realmId;
    res.send(`<html><body><h2 style="font-family:sans-serif;padding:2rem">Connected: ${entity.name}</h2><p style="font-family:sans-serif;padding:0 2rem">You can close this tab and return to the dashboard.</p><script>window.close()</script></body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send('Token exchange failed');
  }
});

app.get('/api/financials', async (req, res) => {
  const period = req.query.period || 'ytd';
  const { start, end } = getDateRange(period);
  const results = {};
  await Promise.allSettled(
    ENTITIES.map(async (entity) => {
      if (!tokenStore[entity.id]) {
        results[entity.id] = { connected: false };
        return;
      }
      try {
        const [pl, bs] = await Promise.all([
          fetchPL(entity.id, start, end),
          fetchBS(entity.id, end)
        ]);
        results[entity.id] = { connected: true, pl, bs };
      } catch (err) {
        results[entity.id] = { connected: false, error: err.message };
      }
    })
  );
  results.offshore = { connected: false, placeholder: true };
  res.json({ period, dateRange: { start, end }, entities: results });
});

app.get('/api/disconnect/:entityId', (req, res) => {
  const { entityId } = req.params;
  delete tokenStore[entityId];
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QBO Dashboard running on port ${PORT}`));
