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

## AI cursor positioning
- Click / wait-for-selector steps include an `executeJavascript` probe that
  returns `getBoundingClientRect()` of the target plus the page viewport
  (`selectorRectScript` in `server/index.js`). The server reads the rect from
  `actions.javascriptReturns`, normalizes to 0..1 via `rectToCursor`, and
  emits a `cursor` event so the on-screen cursor lands on the actual element.
- Falls back to the heuristic `estimateCursor` zones for non-selector actions
  (write/press/scroll) and when the probe returns nothing.

## Background runs
- `POST /api/run-stream` and `POST /api/run-agent` no longer hold the SSE
  socket open. Both require `taskId` in the body, register the worker in an
  in-memory `runRegistry` keyed by `taskId`, and respond immediately with
  `{ started: true, taskId, kind }`. The worker keeps going even if the
  client disconnects (closes the tab, switches tasks, navigates away).
- Clients subscribe to a run via `GET /api/runs/:taskId/events` (SSE). The
  endpoint first replays every buffered event so a late attach catches up,
  then streams live events. Heartbeat every 10s, `event: end` when the run
  is over (or immediately if it already finished).
- `POST /api/runs/:taskId/abort` aborts the worker; `GET /api/runs/:taskId/status`
  is a quick JSON probe used on app load to decide whether to re-attach.
- Each terminal event (`done`, `error`) is also persisted into the `tasks`
  row so the result survives a server restart. Registry entries are kept
  ~10 minutes after completion so a returning user can still replay.
- Frontend keeps a `streamsRef` map keyed by `taskId` so multiple runs can
  be observed in parallel and switching between them doesn't kill any
  subscription. On load, `loadTasks` queries `/api/runs/:id/status` for any
  task the DB still marks `running`/`planning` and re-attaches if the
  server confirms it's alive.

## Deploy
- Autoscale: build `npm run build`, run `npm run start`. The Express server
  serves the built SPA from `dist/` and the `/api` routes on port 5000.
