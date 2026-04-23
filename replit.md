# E2E Tester (scaffold)

A minimal React + Vite UI scaffold for an end-to-end test runner. The GitHub repo
was empty on import, so this is a fresh scaffold.

## Stack
- React 18 + Vite 5 (JSX, no TypeScript)
- Express 5 backend on port 8000 (proxied via `/api` from Vite)
- AI planner: Fireworks AI — Kimi K2.6 (`accounts/fireworks/models/kimi-k2p6`)
  - Override with `FIREWORKS_ACT_MODEL` (or legacy `FIREWORKS_MODEL`) env var
- Plan-mode strategist model: `FIREWORKS_PLAN_MODEL` (default `accounts/fireworks/models/glm-5p1`)
- Agent-loop model: `FIREWORKS_AGENT_MODEL` (default `accounts/fireworks/models/kimi-k2p6`)
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
- `server/index.js` — Express API: `POST /api/plan`, `POST /api/run`, `GET /api/health`,
  plus task persistence: `GET /api/tasks`, `GET/PUT/DELETE /api/tasks/:id`
- `server/db.js` — Postgres pool + `tasks` table CRUD (id, name, prompt, status, JSONB data)
- `server/static.js` — serves `dist/` in production

## Persistence
- Replit's built-in PostgreSQL stores all tasks in the `tasks` table.
- Frontend loads history from `/api/tasks` on mount and PUTs the full task
  (minus the ephemeral live `stage` frame) on each meaningful state change.
- Deletes propagate to the server.

## Secrets required
- `FIREWORKS_API_KEY`
- `FIRECRAWL_API_KEY`

## Deploy
- Autoscale: build `npm run build`, run `npm run start`. The Express server
  serves the built SPA from `dist/` and the `/api` routes on port 5000.
