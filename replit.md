# E2E Tester (scaffold)

A minimal React + Vite UI scaffold for an end-to-end test runner. The GitHub repo
was empty on import, so this is a fresh scaffold.

## Stack
- React 18 + Vite 5 (JSX, no TypeScript)
- No backend; tests are simulated client-side

## Layout
- `index.html`, `vite.config.js`, `package.json`
- `src/main.jsx` — React entry
- `src/App.jsx` — main UI (sidebar test list, runner, details panel)
- `src/styles.css` — dark theme styles

## Dev
- Workflow `Start application` runs `npm run dev` on port 5000 (host `0.0.0.0`).
- Vite is configured with `allowedHosts: true` for the Replit proxy.

## Deploy
- Static deployment: build `npm run build`, serve from `dist/`.
