# QBO Portfolio Dashboard — Deployment Guide

## What you have
- `backend/server.js` — Express API handling OAuth + QBO data
- `backend/package.json` — Node dependencies
- `frontend/index.html` — Full dashboard UI
- `render.yaml` — Render.com deployment config
- This guide

---

## Step 1 — Push to GitHub

1. Go to github.com → New repository
2. Name it `qbo-dashboard` (private repo recommended)
3. Run these commands in your terminal from this folder:

```bash
git init
git add .
git commit -m "Initial dashboard"
git remote add origin https://github.com/YOUR_USERNAME/qbo-dashboard.git
git push -u origin main
```

---

## Step 2 — Deploy on Render

1. Go to render.com → New → Web Service
2. Connect your GitHub account and select the `qbo-dashboard` repo
3. Render will detect `render.yaml` automatically
4. Click **Apply** — it will create the service

---

## Step 3 — Set environment variables in Render

In your Render dashboard → your service → **Environment** tab, add these:

| Key | Value |
|-----|-------|
| `QB_CLIENT_ID` | Your Intuit app Client ID |
| `QB_CLIENT_SECRET` | Your Intuit app Client Secret (rotated) |
| `REDIRECT_URI` | `https://qbo-dashboard.onrender.com/callback` |
| `FRONTEND_URL` | `https://qbo-dashboard.onrender.com` |
| `SESSION_SECRET` | Any long random string (e.g. generate at passwordsgenerator.net) |

> Note: Replace `qbo-dashboard` with your actual Render service name if different.

---

## Step 4 — Update QuickBooks redirect URI

1. Go to developer.intuit.com → My Apps → Financial Dashboard
2. Keys & OAuth → Production
3. Add redirect URI: `https://qbo-dashboard.onrender.com/callback`
4. Save

---

## Step 5 — Connect your company files

1. Visit your dashboard at `https://qbo-dashboard.onrender.com`
2. Click **Manage Connections** (top right)
3. Click **Connect to QuickBooks** for each entity
4. Log in with the QBO account that has access to that company file
5. Authorize → window closes → entity shows as connected

Repeat for all 4 live entities (Offshore Construction stays as placeholder until close).

---

## How tokens work
- Tokens are stored in server memory (resets on redeploy)
- For persistence across restarts, upgrade to Redis session store (I can add this)
- Access tokens auto-refresh using the refresh token — no re-auth needed for 100 days

---

## Activating Offshore Construction
When you close:
1. Add the QBO company file in QuickBooks
2. Go to Connections tab → Click Connect for Offshore Construction
3. It will automatically move from "coming soon" to live data

---

## Troubleshooting
- **OAuth fails**: Double-check redirect URI matches exactly in both Render env vars and Intuit app settings
- **No data showing**: Check Render logs (Dashboard → Logs) for API errors
- **Tokens expire**: If disconnected after 100 days, just reconnect via the Connections tab
