# E2E Tester (scaffold)

A minimal React + Vite UI scaffold for an end-to-end test runner. The GitHub repo
was empty on import, so this is a fresh scaffold.

## Stack
- React 18 + Vite 5 (JSX, no TypeScript)
- Express 5 backend on port 8000 (proxied via `/api` from Vite)
- AI planner: Fireworks AI — Kimi K2.5 (`accounts/fireworks/models/kimi-k2p5`)
  - Override with `FIREWORKS_MODEL` env var
- Browser execution: Firecrawl `/v1/scrape` with `actions`

## Layout
- `index.html`, `vite.config.js`, `package.json`
- `src/main.jsx` — React entry
- `src/App.jsx` — main UI (sidebar test list, runner, details panel)
- `src/styles.css` — dark theme styles

## Dev
- Workflow `Start application` runs `npm run dev` on port 5000 (host `0.0.0.0`).
- Vite is configured with `allowedHosts: true` for the Replit proxy.

## Layout (additions)
- `server/index.js` — Express API: `POST /api/plan`, `POST /api/run`, `GET /api/health`
- `server/static.js` — serves `dist/` in production

## Secrets required
- `FIREWORKS_API_KEY`
- `FIRECRAWL_API_KEY`

## Deploy
- Autoscale: build `npm run build`, run `npm run start`. The Express server
  serves the built SPA from `dist/` and the `/api` routes on port 5000.
