import express from 'express'
import { mountStatic } from './static.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

const SERVE_STATIC = process.env.SERVE_STATIC === '1'
const PORT = Number(process.env.PORT || (SERVE_STATIC ? 5000 : process.env.PORT_API || 8000))
const HOST = SERVE_STATIC ? '0.0.0.0' : '127.0.0.1'
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
/** Model for JSON test planning + post-run summary ("act" path). */
const FIREWORKS_ACT_MODEL = process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/kimi-k2p6'
/** GLM 5.1 (Z.ai) for plan mode — Fireworks serverless ID; override with FIREWORKS_PLAN_MODEL. */
const FIREWORKS_PLAN_MODEL =
  process.env.FIREWORKS_PLAN_MODEL || 'accounts/fireworks/models/glm-5p1'
/** Reasoning tier for plan-mode calls: low | medium | high (default high). */
const FIREWORKS_PLAN_REASONING = process.env.FIREWORKS_PLAN_REASONING || 'high'

if (!FIREWORKS_API_KEY) console.warn('[warn] FIREWORKS_API_KEY not set')
if (!FIRECRAWL_API_KEY) console.warn('[warn] FIRECRAWL_API_KEY not set')

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    fireworks: Boolean(FIREWORKS_API_KEY),
    firecrawl: Boolean(FIRECRAWL_API_KEY),
    actModel: FIREWORKS_ACT_MODEL,
    planModel: FIREWORKS_PLAN_MODEL,
    planReasoning: FIREWORKS_PLAN_REASONING,
  })
})

const PLAN_SYSTEM = `You are an expert end-to-end test planner.
You receive a single user scenario in plain English and must produce a JSON test plan that can be executed by a headless browser via the Firecrawl /scrape "actions" API.

Return ONLY a JSON object — no prose, no markdown — with the exact shape:
{
  "name": string,        // <= 80 chars summary of the scenario
  "url":  string,        // starting URL (fully-qualified https URL)
  "actions": [           // ordered, max 12
    { "type": "wait",       "milliseconds": number }                         |
    { "type": "wait",       "selector": string }                             |
    { "type": "click",      "selector": string }                             |
    { "type": "write",      "text": string }                                 |
    { "type": "press",      "key": string }                                  |
    { "type": "scroll",     "direction": "up" | "down" }                     |
    { "type": "scrape" }                                                     |
    { "type": "screenshot" }
  ],
  "expect": [                  // assertions checked against final page text/html/url
    { "kind": "contains_text", "value": string } |
    { "kind": "url_includes",  "value": string }
  ]
}

CRITICAL RULES (Firecrawl semantics):
- "write" has NO selector. To type into a field, ALWAYS emit a "click" with the input's selector first, then a "write" with just the text. Example:
    { "type": "click", "selector": "#email" },
    { "type": "write", "text": "demo@example.com" }
- After typing into a form, use { "type": "press", "key": "Enter" } or click the submit button.
- Insert a small { "type": "wait", "milliseconds": 800 } after navigation/clicks that load content.
- Always end with a { "type": "screenshot" } so the user gets a visual verdict.
- Prefer stable selectors (id, name, aria-label, role, button text via attribute). Avoid brittle nth-child chains.
- If the user did not specify a site, choose a sensible public site (https://example.com, https://duckduckgo.com for search, https://news.ycombinator.com for HN).
- Never invent real credentials. Use placeholders like "demo@example.com" / "password123".
- Output JSON only.`

function stripJsonFence(s) {
  let t = String(s || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  return t.trim()
}

async function callFireworks(messages, { temperature = 0.2, json = true, model, max_tokens = 2048 } = {}) {
  const body = {
    model: model || FIREWORKS_ACT_MODEL,
    max_tokens,
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
  const s = stripJsonFence(raw)
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

const PLAN_STRATEGIST_SYSTEM = `You are the plan-mode strategist for an E2E browser testing product (tests run via Firecrawl: clicks, typing, scrolling, URL/text assertions).

You have NO tools except one: create_plan. Calling create_plan sends ONE detailed natural-language brief to the separate "act" agent, which then builds and runs the executable test. You cannot browse, scrape, or run code.

Rules:
- If anything important is still ambiguous (target URL, login/credentials policy, exact assertions, scope, locale, which UI path), ask clarifying questions in your normal assistant message (plain text). Do NOT call create_plan until the act agent would not need to guess.
- When the brief is complete and unambiguous, you MUST call create_plan exactly once. Its argument detailed_prompt must be a single self-contained scenario: explicit https start URL, ordered steps, what to assert on the page or URL. Use placeholders (e.g. demo@example.com) for any secrets—never ask users for real passwords.
- Do not claim you ran a test or saw a page; you only scope and hand off.`

const CREATE_PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_plan',
      description:
        'Send the finalized detailed prompt to the act agent so it can build and run the browser test. This is your ONLY tool. Call it once when the brief is ready.',
      parameters: {
        type: 'object',
        properties: {
          detailed_prompt: {
            type: 'string',
            description:
              'Full brief for the act agent: start URL, user-visible steps in order, assertions; placeholders only for credentials.',
          },
        },
        required: ['detailed_prompt'],
      },
    },
  },
]

function extractCreatePlanPrompt(message) {
  const calls = message?.tool_calls
  if (!Array.isArray(calls)) return null
  for (const tc of calls) {
    if (tc?.function?.name !== 'create_plan') continue
    let args
    try {
      args = JSON.parse(tc.function.arguments || '{}')
    } catch {
      continue
    }
    const p = String(args?.detailed_prompt ?? args?.detailedPrompt ?? '').trim()
    if (p) return p
  }
  return null
}

function assistantSnapshotFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  const snap = { role: 'assistant', content: msg.content ?? '' }
  if (msg.reasoning_content) snap.reasoning_content = msg.reasoning_content
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) snap.tool_calls = msg.tool_calls
  return snap
}

function sanitizeAssistantSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.role !== 'assistant') return null
  const out = { role: 'assistant', content: String(raw.content ?? '') }
  if (typeof raw.reasoning_content === 'string' && raw.reasoning_content.length) {
    out.reasoning_content = raw.reasoning_content
  }
  if (Array.isArray(raw.tool_calls) && raw.tool_calls.length) out.tool_calls = raw.tool_calls
  return out
}

async function callFireworksPlanStrategist(messages, { tool_choice = 'auto', max_tokens = 8192 } = {}) {
  const body = {
    model: FIREWORKS_PLAN_MODEL,
    max_tokens,
    temperature: 0.35,
    messages,
    tools: CREATE_PLAN_TOOLS,
    reasoning_effort: FIREWORKS_PLAN_REASONING,
  }
  if (tool_choice !== 'auto') body.tool_choice = tool_choice
  const hasPriorAssistant = messages.some((m) => m.role === 'assistant')
  if (hasPriorAssistant) body.reasoning_history = 'preserved'

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
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Fireworks returned non-JSON')
  }
  return data.choices?.[0]?.message || null
}

app.post('/api/plan-intake', async (req, res) => {
  try {
    if (!FIREWORKS_API_KEY) return res.status(400).json({ error: 'FIREWORKS_API_KEY missing' })
    const { goal, answers, assistantSnapshot: assistantSnapRaw } = req.body || {}
    if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal required' })

    const messages = [{ role: 'system', content: PLAN_STRATEGIST_SYSTEM }, { role: 'user', content: goal.trim() }]

    const answersTrim = typeof answers === 'string' ? answers.trim() : ''
    const forceTool = Boolean(answersTrim)

    if (forceTool) {
      const snap = sanitizeAssistantSnapshot(assistantSnapRaw)
      if (snap) messages.push(snap)
      messages.push({
        role: 'user',
        content:
          `The user replied with clarifications and wants you to hand off to the act agent.\n\n` +
          `Their message:\n${answersTrim}\n\n` +
          `You MUST call create_plan now with a complete detailed_prompt (no further questions).`,
      })
    }

    const msg = await callFireworksPlanStrategist(messages, {
      tool_choice: forceTool ? { type: 'function', function: { name: 'create_plan' } } : 'auto',
    })
    if (!msg) return res.status(502).json({ error: 'Empty strategist response' })

    const actPrompt = extractCreatePlanPrompt(msg)
    if (actPrompt) {
      return res.json({ phase: 'done', actPrompt })
    }

    if (forceTool) {
      return res.status(422).json({
        error: 'Strategist did not call create_plan; try adding more concrete answers (URL, steps, assertions).',
      })
    }

    const strategistMessage = String(msg.content || '').trim()
    const assistantSnapshot = assistantSnapshotFromMessage(msg)
    if (!strategistMessage && !assistantSnapshot?.reasoning_content) {
      return res.status(422).json({
        error: 'Strategist returned no text and no create_plan call; try rephrasing your goal.',
      })
    }

    return res.json({
      phase: 'converse',
      strategistMessage: strategistMessage || '(No text reply; use the box below to add detail, then continue.)',
      assistantSnapshot,
    })
  } catch (err) {
    console.error('plan-intake error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

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

// Map plan actions → exact Firecrawl /v1/scrape action schema.
// Returns an array (not a single object) so that we can expand bad shapes
// such as { write, selector, text } into [{click, selector}, {write, text}].
function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return []
  switch (a.type) {
    case 'wait': {
      if (a.selector) return [{ type: 'wait', selector: String(a.selector) }]
      return [{ type: 'wait', milliseconds: Math.max(50, Number(a.milliseconds) || 500) }]
    }
    case 'click': {
      const sel = String(a.selector || '').trim()
      return sel ? [{ type: 'click', selector: sel }] : []
    }
    case 'write': {
      const text = String(a.text ?? '')
      // If the model gave us { write, selector, text }, expand it.
      if (a.selector) {
        const sel = String(a.selector).trim()
        const out = []
        if (sel) out.push({ type: 'click', selector: sel })
        out.push({ type: 'write', text })
        return out
      }
      return [{ type: 'write', text }]
    }
    case 'press':
      return [{ type: 'press', key: String(a.key || 'Enter') }]
    case 'scroll': {
      const dir = a.direction === 'up' ? 'up' : 'down'
      const out = { type: 'scroll', direction: dir }
      if (a.selector) out.selector = String(a.selector)
      return [out]
    }
    case 'screenshot':
      return [{ type: 'screenshot', fullPage: Boolean(a.fullPage) }]
    case 'scrape':
      return [{ type: 'scrape' }]
    default:
      return []
  }
}

async function runFirecrawl(plan) {
  const actions = plan.actions.flatMap(sanitizeAction)
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

// ----- Streaming run with progressive frames + animated cursor -----

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Heuristic cursor position (normalized 0..1) for a given action.
// We don't get real coords from Firecrawl, so we pick plausible zones
// based on the selector / action type so the cursor moves believably.
function estimateCursor(action, prev) {
  const sel = String(action?.selector || '').toLowerCase()
  const txt = String(action?.text || '').toLowerCase()
  const rand = (a, b) => a + Math.random() * (b - a)

  if (action.type === 'write' || action.type === 'press') {
    // Stay roughly where we last clicked (the input we focused).
    return prev || { x: 0.5, y: 0.32 }
  }
  if (action.type === 'scroll') {
    return { x: 0.92, y: action.direction === 'up' ? 0.15 : 0.85 }
  }
  if (action.type === 'screenshot' || action.type === 'scrape' || action.type === 'wait') {
    return prev || { x: 0.5, y: 0.5 }
  }
  // click / generic: pick a zone based on selector hints.
  if (/(search|q\b|input\[type=.?search|name=.?q)/.test(sel)) return { x: rand(0.35, 0.65), y: rand(0.22, 0.34) }
  if (/(submit|button|btn|sign[-_ ]?in|login|cta|continue|next)/.test(sel) || /(submit|continue|next|search)/.test(txt)) {
    return { x: rand(0.4, 0.6), y: rand(0.42, 0.58) }
  }
  if (/(nav|menu|header|top|logo)/.test(sel)) return { x: rand(0.15, 0.85), y: rand(0.05, 0.12) }
  if (/(footer|bottom)/.test(sel)) return { x: rand(0.2, 0.8), y: rand(0.88, 0.95) }
  if (/(link|a\b|article|item|result)/.test(sel)) return { x: rand(0.2, 0.7), y: rand(0.35, 0.7) }
  return { x: rand(0.3, 0.7), y: rand(0.3, 0.7) }
}

// Build Firecrawl actions with a `screenshot` after every interactive action,
// and a `screenshot` first so we have a frame for the initial page load.
function buildStreamingActions(planActions) {
  const out = [{ type: 'screenshot' }]
  const frameMap = [{ kind: 'initial', actionIndex: -1 }]

  for (let i = 0; i < planActions.length; i++) {
    const a = planActions[i]
    const sanitized = sanitizeAction(a)
    for (const sa of sanitized) {
      out.push(sa)
      if (sa.type !== 'screenshot') {
        out.push({ type: 'screenshot' })
        frameMap.push({ kind: 'after', actionIndex: i })
      } else {
        frameMap.push({ kind: 'shot', actionIndex: i })
      }
    }
  }
  return { actions: out, frameMap }
}

async function streamFireworks(messages, onDelta, { temperature = 0.3, model, max_tokens = 600 } = {}) {
  const body = {
    model: model || FIREWORKS_ACT_MODEL,
    max_tokens,
    temperature,
    messages,
    stream: true,
  }
  const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '')
    throw new Error(`Fireworks stream ${r.status}: ${t.slice(0, 300)}`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return full
      try {
        const j = JSON.parse(data)
        const delta = j.choices?.[0]?.delta?.content || ''
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch { /* skip non-JSON keepalives */ }
    }
  }
  return full
}

async function streamSummaryRun({ plan, finalUrl, title, expectations, passed, durationMs }, onDelta) {
  if (!FIREWORKS_API_KEY) {
    const verdict = passed ? 'passed' : 'failed'
    const msg = `Test ${verdict} in ${durationMs}ms. Final page: ${title || finalUrl}.`
    onDelta(msg)
    return msg
  }
  const sys = `You write a concise 2-4 sentence post-run summary of an automated end-to-end browser test. Plain prose, no markdown, no preamble. Mention what was tested, the outcome (pass/fail), and any notable assertion. Do not invent details.`
  const usr =
    `Scenario: ${plan.name}\n` +
    `Start URL: ${plan.url}\n` +
    `Final URL: ${finalUrl}\n` +
    `Page title: ${title || '(none)'}\n` +
    `Duration: ${durationMs}ms\n` +
    `Outcome: ${passed ? 'PASSED' : 'FAILED'}\n` +
    `Assertions: ${JSON.stringify(expectations)}\n`
  try {
    return await streamFireworks(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      onDelta,
      { temperature: 0.3 }
    )
  } catch {
    const verdict = passed ? 'passed' : 'failed'
    const msg = `Test ${verdict} in ${durationMs}ms. Final page: ${title || finalUrl}.`
    onDelta(msg)
    return msg
  }
}

async function summarizeRun({ plan, finalUrl, title, expectations, passed, durationMs }) {
  if (!FIREWORKS_API_KEY) {
    const verdict = passed ? 'passed' : 'failed'
    return `Test ${verdict} in ${durationMs}ms. Final page: ${title || finalUrl}.`
  }
  try {
    const sys = `You write a concise 2-4 sentence post-run summary of an automated end-to-end browser test. Plain prose, no markdown, no preamble. Mention what was tested, the outcome (pass/fail), and any notable assertion. Do not invent details.`
    const usr =
      `Scenario: ${plan.name}\n` +
      `Start URL: ${plan.url}\n` +
      `Final URL: ${finalUrl}\n` +
      `Page title: ${title || '(none)'}\n` +
      `Duration: ${durationMs}ms\n` +
      `Outcome: ${passed ? 'PASSED' : 'FAILED'}\n` +
      `Assertions: ${JSON.stringify(expectations)}\n`
    const out = await callFireworks(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { temperature: 0.3, json: false }
    )
    return out.trim()
  } catch (err) {
    const verdict = passed ? 'passed' : 'failed'
    return `Test ${verdict} in ${durationMs}ms. Final page: ${title || finalUrl}.`
  }
}

app.post('/api/run-stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  let sessionId = null
  try {
    if (!FIRECRAWL_API_KEY) { send('error', { error: 'FIRECRAWL_API_KEY missing' }); return res.end() }
    const { plan } = req.body || {}
    if (!plan || !plan.url) { send('error', { error: 'plan with url required' }); return res.end() }

    send('start', { url: plan.url, totalActions: plan.actions.length })
    const start = Date.now()

    // ---- 1. Create a Browser Sandbox session for true live streaming ----
    const createR = await fetch('https://api.firecrawl.dev/v2/browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ ttl: 600, activityTtl: 180 }),
    })
    const createTxt = await createR.text()
    let session
    try { session = JSON.parse(createTxt) } catch {
      send('error', { error: `Browser create returned non-JSON (${createR.status}): ${createTxt.slice(0, 200)}` }); return res.end()
    }
    if (!createR.ok || session.success === false || !session.id) {
      send('error', { error: `Browser create ${createR.status}: ${session?.error || createTxt.slice(0, 200)}` }); return res.end()
    }
    sessionId = session.id
    const liveUrl = session.interactiveLiveViewUrl || session.liveViewUrl
    send('liveview', { url: liveUrl })

    // ---- 2. Helper to execute Playwright code in the session ----
    async function exec(code) {
      const er = await fetch(`https://api.firecrawl.dev/v2/browser/${sessionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify({ code, language: 'node' }),
      })
      const et = await er.text()
      let ed
      try { ed = JSON.parse(et) } catch { throw new Error(`exec non-JSON (${er.status}): ${et.slice(0, 200)}`) }
      if (!er.ok || ed.success === false) throw new Error(`exec ${er.status}: ${ed?.error || et.slice(0, 200)}`)
      return ed.result ?? ed.data ?? ed
    }

    // ---- 3. Navigate to start URL ----
    send('cursor', { actionIndex: -1, x: 0.5, y: 0.1, label: `navigating to ${plan.url}` })
    await exec(`await page.goto(${JSON.stringify(plan.url)}, { waitUntil: 'domcontentloaded', timeout: 45000 }); return { url: page.url() };`)

    // ---- 4. Run actions one at a time, streaming a cursor event per step ----
    let prev = { x: 0.5, y: 0.5 }
    for (let i = 0; i < plan.actions.length; i++) {
      const a = plan.actions[i]
      const sanitized = sanitizeAction(a)
      for (const sa of sanitized) {
        let label = sa.type
        if (sa.type === 'click') label = `click ${sa.selector || ''}`
        else if (sa.type === 'write') label = `type "${sa.text || ''}"`
        else if (sa.type === 'press') label = `press ${sa.key || 'Enter'}`
        else if (sa.type === 'scroll') label = `scroll ${sa.direction || 'down'}`
        else if (sa.type === 'wait') label = sa.selector ? `wait for ${sa.selector}` : `wait ${sa.milliseconds || 0}ms`

        // Try to find real coordinates for click targets so the cursor overlay aligns with the live view.
        let cursor = estimateCursor(a, prev)
        if (sa.type === 'click' && sa.selector) {
          try {
            const r = await exec(
              `try {
                 const loc = page.locator(${JSON.stringify(sa.selector)}).first();
                 await loc.waitFor({ timeout: 5000, state: 'visible' });
                 const b = await loc.boundingBox();
                 const vp = page.viewportSize();
                 return { bbox: b, vp };
               } catch (e) { return { error: String(e.message||e) }; }`
            )
            const vp = r?.vp || { width: 1280, height: 720 }
            const bb = r?.bbox
            if (bb) cursor = {
              x: Math.max(0, Math.min(1, (bb.x + bb.width / 2) / vp.width)),
              y: Math.max(0, Math.min(1, (bb.y + bb.height / 2) / vp.height)),
            }
          } catch { /* keep estimate */ }
        }
        prev = cursor
        send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label })
        await sleep(180)

        try {
          if (sa.type === 'click') {
            await exec(`await page.locator(${JSON.stringify(sa.selector)}).first().click({ timeout: 10000 }); return {};`)
          } else if (sa.type === 'write') {
            await exec(`await page.keyboard.type(${JSON.stringify(sa.text || '')}, { delay: 25 }); return {};`)
          } else if (sa.type === 'press') {
            await exec(`await page.keyboard.press(${JSON.stringify(sa.key || 'Enter')}); return {};`)
          } else if (sa.type === 'wait') {
            if (sa.selector) {
              await exec(`await page.waitForSelector(${JSON.stringify(sa.selector)}, { timeout: 15000 }); return {};`)
            } else {
              await exec(`await page.waitForTimeout(${Math.max(50, Number(sa.milliseconds) || 500)}); return {};`)
            }
          } else if (sa.type === 'scroll') {
            const dy = sa.direction === 'up' ? -600 : 600
            await exec(`await page.evaluate(() => window.scrollBy(0, ${dy})); return {};`)
          } else if (sa.type === 'screenshot' || sa.type === 'scrape') {
            // No-op: live view shows everything in real time.
          }
        } catch (err) {
          send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label: `! ${label} failed` })
        }
      }
    }

    // ---- 5. Capture final state for assertions ----
    send('cursor', { actionIndex: -1, x: 0.5, y: 0.5, label: 'evaluating assertions' })
    let finalState = { url: plan.url, title: '', html: '', text: '' }
    try {
      finalState = await exec(
        `await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(()=>{});
         const html = await page.content();
         const text = await page.evaluate(() => document.body ? document.body.innerText : '');
         return { url: page.url(), title: await page.title(), html, text };`
      )
    } catch {}

    const fakeScrape = {
      html: finalState.html || '',
      markdown: finalState.text || '',
      metadata: { sourceURL: finalState.url, title: finalState.title },
    }
    const expectations = evaluateExpectations(plan, fakeScrape)
    const passed = expectations.length === 0 ? true : expectations.every((e) => e.pass)
    const durationMs = Date.now() - start
    const finalUrl = finalState.url || plan.url
    const title = finalState.title || ''

    send('summary_start', { passed, expectations, finalUrl, title, durationMs })
    const summary = await streamSummaryRun(
      { plan, finalUrl, title, expectations, passed, durationMs },
      (delta) => send('summary_delta', { delta })
    )
    send('done', { summary, expectations, passed, finalUrl, title, durationMs, screenshots: [] })
    res.end()
  } catch (err) {
    console.error('run-stream error:', err)
    try { send('error', { error: String(err.message || err) }) } catch {}
    res.end()
  } finally {
    if (sessionId) {
      fetch(`https://api.firecrawl.dev/v2/browser/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      }).catch(() => {})
    }
  }
})

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

process.on('unhandledRejection', (e) => console.error('[api] unhandledRejection:', e))
process.on('uncaughtException',  (e) => console.error('[api] uncaughtException:', e))

app.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}${SERVE_STATIC ? ' (serving static dist/)' : ''}`)
})
