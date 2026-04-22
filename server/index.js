import express from 'express'
import { mountStatic } from './static.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

const SERVE_STATIC = process.env.SERVE_STATIC === '1'
const PORT = Number(process.env.PORT || (SERVE_STATIC ? 5000 : process.env.PORT_API || 8000))
const HOST = SERVE_STATIC ? '0.0.0.0' : 'localhost'
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
const FIREWORKS_MODEL = process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/kimi-k2p5'

if (!FIREWORKS_API_KEY) console.warn('[warn] FIREWORKS_API_KEY not set')
if (!FIRECRAWL_API_KEY) console.warn('[warn] FIRECRAWL_API_KEY not set')

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    fireworks: Boolean(FIREWORKS_API_KEY),
    firecrawl: Boolean(FIRECRAWL_API_KEY),
    model: FIREWORKS_MODEL,
  })
})

const PLAN_SYSTEM = `You are an expert end-to-end test planner.
You receive a single user scenario in plain English and must produce a JSON test plan that can be executed by a headless browser via the Firecrawl /scrape "actions" API.

Return ONLY a JSON object — no prose, no markdown — with the exact shape:
{
  "name": string,        // <= 80 chars summary of the scenario
  "url":  string,        // the starting URL (must be a fully-qualified https URL the browser can visit)
  "actions": [           // ordered actions, max 12
    { "type": "wait",       "milliseconds": number }                         |
    { "type": "click",      "selector": string }                             |
    { "type": "write",      "selector": string, "text": string }             |
    { "type": "press",      "key": string }                                  |
    { "type": "scroll",     "direction": "up" | "down" }                     |
    { "type": "scrape" }                                                     |
    { "type": "screenshot" }
  ],
  "expect": [                  // human-readable assertions to verify against the final page text/html
    { "kind": "contains_text", "value": string } |
    { "kind": "url_includes",  "value": string }
  ]
}

Rules:
- Always include at least one "screenshot" near the end so the user gets a visual verdict.
- Keep selectors realistic; prefer ids and roles. If the user did not specify a site, default to https://example.com or a public page that fits the scenario (e.g. https://duckduckgo.com for search).
- Never invent credentials. If a step requires a username/password the user did not give, use placeholders like "demo@example.com" / "password123".
- Output JSON only.`

async function callFireworks(messages, { temperature = 0.2, json = true } = {}) {
  const body = {
    model: FIREWORKS_MODEL,
    max_tokens: 2048,
    temperature,
    messages,
  }
  if (json) body.response_format = { type: 'json_object' }

  const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`Fireworks ${r.status}: ${text.slice(0, 600)}`)
  }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('Fireworks returned non-JSON') }
  return data.choices?.[0]?.message?.content || ''
}

function parsePlan(raw) {
  let s = raw.trim()
  // Strip code fences if any slipped through
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const obj = JSON.parse(s)
  if (!obj || typeof obj !== 'object') throw new Error('Plan is not an object')
  if (!obj.url || typeof obj.url !== 'string') throw new Error('Plan missing url')
  if (!Array.isArray(obj.actions)) obj.actions = []
  if (!Array.isArray(obj.expect)) obj.expect = []
  if (!obj.name) obj.name = obj.url
  // Ensure ending screenshot
  if (!obj.actions.some((a) => a.type === 'screenshot')) {
    obj.actions.push({ type: 'screenshot' })
  }
  return obj
}

app.post('/api/plan', async (req, res) => {
  try {
    if (!FIREWORKS_API_KEY) return res.status(400).json({ error: 'FIREWORKS_API_KEY missing' })
    const { prompt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' })

    const raw = await callFireworks([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: prompt },
    ])
    const plan = parsePlan(raw)
    res.json({ plan })
  } catch (err) {
    console.error('plan error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

function describeAction(a) {
  switch (a.type) {
    case 'wait':       return `wait ${a.milliseconds || 0}ms`
    case 'click':      return `click ${a.selector}`
    case 'write':      return `type "${a.text}" into ${a.selector}`
    case 'press':      return `press ${a.key}`
    case 'scroll':     return `scroll ${a.direction || 'down'}`
    case 'screenshot': return 'screenshot'
    case 'scrape':     return 'scrape page'
    default:           return JSON.stringify(a)
  }
}

function sanitizeAction(a) {
  // Map our minimal schema to firecrawl actions exactly
  if (a.type === 'wait')       return { type: 'wait', milliseconds: Math.max(50, Number(a.milliseconds) || 500) }
  if (a.type === 'click')      return { type: 'click', selector: String(a.selector || '') }
  if (a.type === 'write')      return { type: 'write', selector: String(a.selector || ''), text: String(a.text || '') }
  if (a.type === 'press')      return { type: 'press', key: String(a.key || 'Enter') }
  if (a.type === 'scroll')     return { type: 'scroll', direction: a.direction === 'up' ? 'up' : 'down' }
  if (a.type === 'screenshot') return { type: 'screenshot' }
  if (a.type === 'scrape')     return { type: 'scrape' }
  return null
}

async function runFirecrawl(plan) {
  const actions = plan.actions.map(sanitizeAction).filter(Boolean)
  const body = {
    url: plan.url,
    formats: ['markdown', 'html', 'screenshot'],
    onlyMainContent: false,
    waitFor: 800,
    timeout: 60000,
    actions,
  }
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch {
    throw new Error(`Firecrawl returned non-JSON (${r.status}): ${text.slice(0, 400)}`)
  }
  if (!r.ok || data.success === false) {
    throw new Error(`Firecrawl ${r.status}: ${data?.error || text.slice(0, 400)}`)
  }
  return data.data || data
}

function evaluateExpectations(plan, scrape) {
  const html = (scrape.html || '').toLowerCase()
  const md = (scrape.markdown || '').toLowerCase()
  const url = (scrape.metadata?.sourceURL || scrape.metadata?.url || '').toLowerCase()
  const text = html + '\n' + md
  const results = []
  for (const e of plan.expect || []) {
    if (e.kind === 'contains_text') {
      const v = String(e.value || '').toLowerCase()
      results.push({ kind: e.kind, value: e.value, pass: v.length > 0 && text.includes(v) })
    } else if (e.kind === 'url_includes') {
      const v = String(e.value || '').toLowerCase()
      results.push({ kind: e.kind, value: e.value, pass: v.length > 0 && url.includes(v) })
    } else {
      results.push({ kind: e.kind, value: e.value, pass: false })
    }
  }
  return results
}

app.post('/api/run', async (req, res) => {
  try {
    if (!FIRECRAWL_API_KEY) return res.status(400).json({ error: 'FIRECRAWL_API_KEY missing' })
    const { plan } = req.body || {}
    if (!plan || !plan.url) return res.status(400).json({ error: 'plan with url required' })

    const start = Date.now()
    const scrape = await runFirecrawl(plan)
    const duration = Date.now() - start

    const screenshots = []
    if (scrape.screenshot) screenshots.push(scrape.screenshot)
    const aShots = scrape.actions?.screenshots
    if (Array.isArray(aShots)) for (const s of aShots) screenshots.push(s)

    const expectations = evaluateExpectations(plan, scrape)
    const passed =
      expectations.length === 0 ? true : expectations.every((e) => e.pass)

    res.json({
      ok: true,
      durationMs: duration,
      finalUrl: scrape.metadata?.sourceURL || scrape.metadata?.url || plan.url,
      title: scrape.metadata?.title || '',
      screenshots,
      expectations,
      passed,
      stepDescriptions: plan.actions.map(describeAction),
    })
  } catch (err) {
    console.error('run error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

if (SERVE_STATIC) mountStatic(app)

app.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}${SERVE_STATIC ? ' (serving static dist/)' : ''}`)
})
