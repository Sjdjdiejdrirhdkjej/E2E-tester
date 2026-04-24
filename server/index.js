import express from 'express'
import { mountStatic } from './static.js'
import { listTasks, getTask, upsertTask, deleteTask, dbReady } from './db.js'

const app = express()
app.use(express.json({ limit: '2mb' }))

const SERVE_STATIC = process.env.SERVE_STATIC === '1'
const PORT = Number(process.env.PORT || (SERVE_STATIC ? 5000 : process.env.PORT_API || 8000))
const HOST = SERVE_STATIC ? '0.0.0.0' : '127.0.0.1'
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
/** Model for JSON test planning + post-run summary ("act" path). */
const FIREWORKS_ACT_MODEL =
  process.env.FIREWORKS_ACT_MODEL ||
  process.env.FIREWORKS_MODEL ||
  'accounts/fireworks/models/kimi-k2p6'
/** Vision-capable model used for the agentic loop so it can actually look at the screenshot.
 *  Override with FIREWORKS_AGENT_MODEL. Default: Kimi K2.6 (latest non-Llama multimodal + tool use). */
const FIREWORKS_AGENT_MODEL =
  process.env.FIREWORKS_AGENT_MODEL || 'accounts/fireworks/models/kimi-k2p6'
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
    db: dbReady,
    actModel: FIREWORKS_ACT_MODEL,
    agentModel: FIREWORKS_AGENT_MODEL,
    planModel: FIREWORKS_PLAN_MODEL,
    planReasoning: FIREWORKS_PLAN_REASONING,
  })
})

app.get('/api/tasks', async (_req, res) => {
  try {
    const tasks = await listTasks()
    res.json({ tasks })
  } catch (err) {
    console.error('list tasks error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id)
    if (!task) return res.status(404).json({ error: 'not found' })
    res.json({ task })
  } catch (err) {
    console.error('get task error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const body = req.body || {}
    const task = { ...body, id: req.params.id }
    const saved = await upsertTask(task)
    res.json({ task: saved })
  } catch (err) {
    console.error('upsert task error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const ok = await deleteTask(req.params.id)
    res.json({ ok })
  } catch (err) {
    console.error('delete task error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
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
- SELECTOR STRATEGY (very important — you cannot see the page, so prefer resilient selectors):
  * For buttons / links / labels: use Playwright text-engine selectors: "text=Sign in", "text=/^Search/i", or "text='Buy now'" for exact match. These match by visible text and are far more reliable than CSS.
  * For inputs: prefer attribute selectors like "input[name='q']", "input[type='email']", "[aria-label='Search']", "[placeholder*='Search']".
  * Use stable ids ("#search") only when the user names them. Avoid nth-child / long descendant chains.
  * NEVER invent class names. If unsure of a selector, use a text= selector based on the visible label.
- If the user did not specify a site, choose a sensible public site (https://example.com, https://duckduckgo.com for search, https://news.ycombinator.com for HN).
- Never invent real credentials. Use placeholders like "demo@example.com" / "password123".
- Output JSON only.`

function stripJsonFence(s) {
  let t = String(s || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  return t.trim()
}

async function callFireworks(messages, { temperature = 0.2, json = true, model, max_tokens = 2048, reasoning_effort = null } = {}) {
  const body = {
    model: model || FIREWORKS_ACT_MODEL,
    max_tokens,
    temperature,
    messages,
  }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort
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

app.post('/api/plan-stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
  })
  try { req.socket?.setNoDelay?.(true) } catch {}
  res.flushHeaders?.()
  res.write(`: ${' '.repeat(2048)}\n\n`)
  const send = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const heartbeat = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`) } catch {} }, 10000)
  const end = () => { clearInterval(heartbeat); try { res.end() } catch {} }
  try {
    if (!FIREWORKS_API_KEY) { send('error', { error: 'FIREWORKS_API_KEY missing' }); return end() }
    const { prompt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') { send('error', { error: 'prompt required' }); return end() }
    send('start', { stage: 'plan' })

    // Stream reasoning + content from Fireworks act planner.
    const body = {
      model: FIREWORKS_ACT_MODEL,
      max_tokens: 2048,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PLAN_SYSTEM },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      stream: true,
      reasoning_effort: FIREWORKS_PLAN_REASONING,
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
      send('error', { error: `Fireworks ${r.status}: ${t.slice(0, 200)}` })
      return end()
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
        if (data === '[DONE]') break
        try {
          const j = JSON.parse(data)
          const d = j.choices?.[0]?.delta || {}
          if (d.reasoning_content) send('reasoning_delta', { delta: d.reasoning_content })
          if (d.content) {
            full += d.content
            send('content_delta', { delta: d.content })
          }
        } catch {}
      }
    }
    let plan
    try { plan = parsePlan(full) } catch (err) {
      send('error', { error: `Plan parse failed: ${err.message || err}` })
      return end()
    }
    send('plan', { plan })
    send('done', {})
    end()
  } catch (err) {
    console.error('plan-stream error:', err)
    try { send('error', { error: String(err.message || err) }) } catch {}
    end()
  }
})

app.post('/api/plan', async (req, res) => {
  try {
    if (!FIREWORKS_API_KEY) return res.status(400).json({ error: 'FIREWORKS_API_KEY missing' })
    const { prompt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' })

    const raw = await callFireworks(
      [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: prompt }],
      { reasoning_effort: FIREWORKS_PLAN_REASONING }
    )
    const plan = parsePlan(raw)
    res.json({ plan })
  } catch (err) {
    console.error('plan error:', err)
    res.status(500).json({ error: String(err.message || err) })
  }
})

// Re-plan the *remaining* actions from the current page state. Used when a run
// failed mid-way: the client posts the original goal/plan + the URL the run
// stopped on; we scrape that page, then ask the planner to author a fresh plan
// that starts at that URL and finishes the user's original intent.
app.post('/api/replan', async (req, res) => {
  try {
    if (!FIREWORKS_API_KEY) return res.status(400).json({ error: 'FIREWORKS_API_KEY missing' })
    if (!FIRECRAWL_API_KEY) return res.status(400).json({ error: 'FIRECRAWL_API_KEY missing' })
    const { prompt, plan: priorPlan, currentUrl, failedAt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' })
    const startUrl = currentUrl || priorPlan?.url
    if (!startUrl) return res.status(400).json({ error: 'currentUrl or plan.url required' })

    // Grab a quick HTML snapshot of where we stopped so the planner can pick real selectors.
    let html = ''
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify({ url: startUrl, formats: ['html'], onlyMainContent: false, waitFor: 600, timeout: 45000 }),
      })
      const d = await r.json().catch(() => ({}))
      html = String(d?.data?.html || d?.html || '').slice(0, 18000)
    } catch {}

    const completedSteps = (priorPlan?.actions || [])
      .slice(0, Math.max(0, Number(failedAt) || 0))
      .map((a, i) => `${i + 1}. ${describeAction(a)}`)
      .join('\n') || '(none)'
    const remaining = (priorPlan?.actions || [])
      .slice(Math.max(0, Number(failedAt) || 0))
      .map((a, i) => `${i + 1}. ${describeAction(a)}`)
      .join('\n') || '(none)'

    const usr = `Original user goal:
${prompt}

The previous run started at ${priorPlan?.url || startUrl} and stopped at ${startUrl}.

Steps that completed successfully:
${completedSteps}

Steps that did NOT run / failed:
${remaining}

Current page HTML at ${startUrl} (truncated):
${html}

Build a fresh plan that:
- Uses url: "${startUrl}" as the starting point (do not re-do completed steps).
- Picks selectors that actually exist in the HTML above (text= selectors and attribute selectors preferred).
- Finishes the original user goal end-to-end.
- Keeps actions <= 12.`

    const raw = await callFireworks(
      [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: usr }],
      { temperature: 0.2, json: true, max_tokens: 2048, reasoning_effort: FIREWORKS_PLAN_REASONING }
    )
    const plan = parsePlan(raw)
    plan.url = startUrl // hard-pin start URL
    res.json({ plan })
  } catch (err) {
    console.error('replan error:', err)
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
      let sel = String(a.selector || '').trim()
      if (!sel && a.text) sel = `text=${String(a.text).trim()}`
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
    actions: toFirecrawlActions(actions),
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

// ====== Background run registry ======
//
// Each E2E run is tied to a task id. While a run is in progress the worker
// pushes events into the registry, and any number of HTTP clients can attach
// to /api/runs/:taskId/events to replay buffered events and subscribe to new
// ones. Because the worker is decoupled from the SSE socket, closing the tab
// or switching tasks no longer kills the test — the run keeps going and the
// client can re-attach later (or another tab can attach in parallel).
//
// On terminal events (done / error / aborted) we persist the final task
// snapshot to PG so a fresh page load reflects the result even if no client
// was attached when the run finished.
const runRegistry = new Map()

function createOrResetRun(taskId, kind) {
  const existing = runRegistry.get(taskId)
  if (existing) {
    if (existing.ac && existing.status === 'running') { try { existing.ac.abort() } catch {} }
    for (const res of existing.subs) {
      try { res.write(`event: end\ndata: ${JSON.stringify({ status: 'replaced' })}\n\n`); res.end() } catch {}
    }
    existing.subs.clear()
    if (existing.heartbeats) for (const h of existing.heartbeats.values()) clearInterval(h)
  }
  const r = {
    taskId,
    kind,                 // 'planned' | 'agent'
    status: 'running',    // 'running' | 'done' | 'error' | 'aborted'
    events: [],           // [{ event, data, t }]
    subs: new Set(),      // res objects
    heartbeats: new Map(),
    ac: new AbortController(),
    startedAt: Date.now(),
    finishedAt: null,
    taskPatch: {},        // accumulated final state to persist on completion
  }
  runRegistry.set(taskId, r)
  return r
}

function runEvent(taskId, event, data) {
  const r = runRegistry.get(taskId)
  if (!r) return
  const entry = { event, data, t: Date.now() }
  r.events.push(entry)
  // Cap the replay buffer so long runs don't grow unbounded. Keep the very
  // first event (usually `start`) so late attachers still see what kicked off.
  if (r.events.length > 4000) r.events.splice(1, r.events.length - 3500)
  for (const res of r.subs) {
    try {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch {}
  }
}

function patchRunTask(taskId, patch) {
  const r = runRegistry.get(taskId)
  if (!r) return
  r.taskPatch = { ...r.taskPatch, ...patch }
}

async function persistFinalTask(r) {
  if (!r || !r.taskId || !r.taskPatch || Object.keys(r.taskPatch).length === 0) return
  if (!dbReady) return
  try {
    const existing = await getTask(r.taskId)
    if (!existing) return
    // Drop ephemeral live-stage keys that we don't want stored as the final
    // record (matches the frontend's `stripForPersist`).
    const { stage: _s, summaryStreaming: _ss, ...patch } = r.taskPatch
    await upsertTask({ ...existing, ...patch, id: r.taskId })
  } catch (err) {
    console.warn('persist final task failed', err)
  }
}

async function endRun(taskId, status) {
  const r = runRegistry.get(taskId)
  if (!r) return
  if (r.status !== 'running') return // already ended
  r.status = status
  r.finishedAt = Date.now()
  await persistFinalTask(r)
  for (const res of r.subs) {
    try { res.write(`event: end\ndata: ${JSON.stringify({ status })}\n\n`); res.end() } catch {}
  }
  for (const h of r.heartbeats.values()) clearInterval(h)
  r.subs.clear()
  r.heartbeats.clear()
  // Keep the registry entry around for ~10 minutes so a late attach can
  // replay the full event log and see the verdict.
  setTimeout(() => { runRegistry.delete(taskId) }, 10 * 60 * 1000).unref?.()
}

// Shared JS helpers injected into every page-side script: element resolution
// (CSS + Playwright text=/text=/re/i/text='x' engine) and a visibility test.
// Defined once so `selectorRectScript` and `browserUseClickScript` stay in
// sync instead of drifting apart.
const FIND_ELEMENT_JS = `
function __isVisible(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var s = window.getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) return false;
  return true;
}
function __findText(s) {
  var needle = s.slice(5).trim();
  var regex = null;
  var m = needle.match(/^\\/(.*)\\/([a-z]*)$/);
  if (m) { try { regex = new RegExp(m[1], (m[2]||'').indexOf('i') >= 0 ? 'i' : ''); } catch (e) {} }
  else {
    if ((needle.charAt(0) === '"' && needle.charAt(needle.length-1) === '"') ||
        (needle.charAt(0) === "'" && needle.charAt(needle.length-1) === "'")) {
      needle = needle.slice(1, -1);
    }
  }
  var tags = 'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],span,div,h1,h2,h3,h4,h5,li,label,option,p,input,textarea,summary,th,td';
  var all = Array.from(document.querySelectorAll(tags));
  function match(t) { return regex ? regex.test(t) : (t === needle || t.toLowerCase() === needle.toLowerCase()); }
  for (var i = 0; i < all.length; i++) { var t = (all[i].innerText || all[i].textContent || '').trim(); if (match(t) && __isVisible(all[i])) return all[i]; }
  if (!regex) {
    var n = needle.toLowerCase();
    for (var k = 0; k < all.length; k++) { var t2 = (all[k].innerText || all[k].textContent || '').trim().toLowerCase(); if (t2.indexOf(n) >= 0 && __isVisible(all[k])) return all[k]; }
  }
  return null;
}
function __findElement(sel) {
  if (/^text=/i.test(sel)) return __findText(sel);
  try { return document.querySelector(sel); } catch (e) { return null; }
}
`

// ===== browser-use style: numbered interactive-element index =====
//
// Before each agent turn we inject this script into the page via Firecrawl's
// `executeJavascript` action. It walks the visible DOM and assigns a 1-based
// index to every interactive element, mirroring the way browser-use annotates
// its DOM snapshot so the AI can say `click({ index: 3 })` instead of having
// to invent a CSS selector.
//
// Return shape: { elements: [{ index, tag, role, text, type, placeholder,
//   ariaLabel, href, selector, cx, cy }] }
//
// `selector` is the best stable selector we can build for each element so the
// server can pass it to `browserUseClickScript` when executing the click.
function buildElementIndexScript() {
  return `(function(){
try {
  function __vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity||'1') < 0.05) return false;
    if (r.bottom < 0 || r.top > window.innerHeight + 400) return false;
    return true;
  }
  function __text(el) {
    var t = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim();
    return t.slice(0, 80);
  }
  function __label(el) {
    var al = el.getAttribute('aria-label');
    if (al) return al.trim().slice(0,80);
    var lid = el.getAttribute('aria-labelledby');
    if (lid) { var le = document.getElementById(lid); if (le) return (le.innerText||le.textContent||'').trim().slice(0,80); }
    var lbl = document.querySelector('label[for="'+el.id+'"]');
    if (lbl) return (lbl.innerText||lbl.textContent||'').trim().slice(0,80);
    return '';
  }
  // Build the most stable selector we can for an element.
  function __sel(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id) { try { document.querySelector('#'+CSS.escape(el.id)); return '#'+CSS.escape(el.id); } catch(e) {} }
    var name = el.getAttribute('name');
    if (name) { var ns = tag+'[name='+JSON.stringify(name)+']'; try { if(document.querySelector(ns)) return ns; } catch(e){} }
    var al = el.getAttribute('aria-label');
    if (al) return '[aria-label='+JSON.stringify(al)+']';
    var ph = el.getAttribute('placeholder');
    if (ph) return '[placeholder='+JSON.stringify(ph)+']';
    var txt = __text(el);
    if (txt && txt.length >= 2 && txt.length <= 60) return 'text='+txt;
    var type = el.getAttribute('type');
    if (type) return tag+'[type='+JSON.stringify(type)+']';
    return tag;
  }
  var INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,details,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="combobox"],[role="option"],[role="switch"],[tabindex]';
  var all = Array.from(document.querySelectorAll(INTERACTIVE));
  var seen = new Set();
  var elements = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!__vis(el)) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;
    var text = __text(el) || __label(el) || el.getAttribute('placeholder') || el.getAttribute('value') || '';
    var rect = el.getBoundingClientRect();
    elements.push({
      index: elements.length + 1,
      tag: tag,
      role: role,
      type: el.getAttribute('type') || '',
      text: text,
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      href: (tag === 'a' && el.href) ? String(el.href).slice(0, 120) : '',
      selector: __sel(el),
      cx: Math.round(rect.left + rect.width / 2),
      cy: Math.round(rect.top + rect.height / 2),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    });
    if (elements.length >= 80) break; // cap to keep payload small
  }
  return { elements: elements };
} catch(e) { return { elements: [], error: String(e&&e.message||e) }; }
})()`
}

// Format an element list for the AI's observation message, mirroring
// browser-use's text-state format: each line is "[index] role|tag "text" extra".
function formatElementsForAI(elements) {
  if (!Array.isArray(elements) || !elements.length) return '(no interactive elements detected)'
  const lines = elements.map((el) => {
    const kind = el.role !== el.tag ? el.role : (el.type ? `${el.tag}[${el.type}]` : el.tag)
    const label = el.text || el.ariaLabel || el.placeholder || ''
    const extra = el.href ? ` → ${el.href.slice(0, 60)}` : el.placeholder ? ` placeholder="${el.placeholder}"` : ''
    const dis = el.disabled ? ' [disabled]' : ''
    return `[${el.index}] ${kind} "${label.slice(0,60)}"${extra}${dis}`
  })
  return lines.join('\n')
}

// Parse the element-index payload from a Firecrawl scrape response.
// Returns an array of element descriptors (or [] if not found).
function parseElementsFromScrape(scrape) {
  const list = scrape?.actions?.javascriptReturns || scrape?.actions?.javascript_returns || []
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k]
    const v = e?.return ?? e?.value ?? e?.result ?? (typeof e === 'object' ? e : null)
    if (v && typeof v === 'object' && Array.isArray(v.elements)) {
      return v.elements
    }
  }
  return []
}

// Build a JS snippet for Firecrawl's `executeJavascript` action that returns
// the bounding rect of a selector + the viewport size. Handles plain CSS
// selectors and Playwright text-engine selectors (text=Foo, text=/foo/i).
// The result is read from `data.actions.javascriptReturns`.
function selectorRectScript(selectorRaw) {
  const sel = String(selectorRaw || '')
  const j = JSON.stringify(sel)
  return `(function(){
try {
  ${FIND_ELEMENT_JS}
  var sel = ${j};
  var el = __findElement(sel);
  var vp = { w: window.innerWidth || document.documentElement.clientWidth, h: window.innerHeight || document.documentElement.clientHeight };
  if (!el) { return { found: false, viewport: vp, selector: sel }; }
  var r = el.getBoundingClientRect();
  return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, viewport: vp, selector: sel };
} catch (e) { return { found: false, error: String(e && e.message || e) }; }
})()`
}

// Browser-use style click, ported to run inside Firecrawl's page context via
// the `executeJavascript` action. Mirrors browser-use's `_click_element_node`
// (github.com/browser-use/browser-use) but adapted for a JS-only runtime where
// we can't issue real CDP mouse events:
//
//   1. Resolve element (CSS selector OR Playwright text= / text=/re/i / text='x')
//   2. scrollIntoViewIfNeeded (center fallback)
//   3. Visibility + zero-size checks (bail with reason)
//   4. Focus inputs/selects/contenteditable
//   5. Dispatch the full pointer/mouse sequence at element center
//      (pointerover/enter → mouseover/enter → pointerdown/mousedown → pointerup/mouseup)
//      — many SPAs only bind to pointer* events, so native el.click() alone misses them.
//   6. Call el.click() so default actions (form submit, <a> nav, checkbox toggle) fire.
//      — This is browser-use's JS-click fallback; here we always run it because
//        we can't do a "real" CDP click. Skipping the manual 'click' dispatch
//        before el.click() avoids double-firing.
//
// Return value has no `viewport` field, so `parseRectFromScrape` still finds
// the rect-probe return in the same call.
//
// Runtime assumption: Firecrawl's `executeJavascript` action awaits a Promise
// returned by the script (true for Playwright's page.evaluate underneath).
// We rely on this for the wait-for-element retry loop; if the assumption
// ever breaks, the click still fires on the first pass inside the async
// IIFE's microtask, just without the retry budget.
function browserUseClickScript(selectorRaw) {
  const sel = String(selectorRaw || '')
  const j = JSON.stringify(sel)
  return `(async function(){
try {
  ${FIND_ELEMENT_JS}
  var sel = ${j};

  // --- 1. Wait-for-element (mirrors Playwright/browser-use's implicit wait). ---
  // Async-rendered elements appear after the initial DOM is ready, so poll for
  // up to ~1.5s before giving up. Uses setTimeout (not a busy-loop) so the
  // page keeps loading. Firecrawl's executeJavascript awaits returned Promises.
  var el = null;
  var deadline = Date.now() + 1500;
  while (true) {
    el = __findElement(sel);
    if (el) break;
    if (Date.now() >= deadline) break;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  if (!el) return { ok: false, reason: 'not_found', selector: sel };

  // --- 2. scroll into view ---
  try {
    if (typeof el.scrollIntoViewIfNeeded === 'function') el.scrollIntoViewIfNeeded();
    else el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (e) {}
  // Give layout a tick to settle after a scroll.
  await new Promise(function (r) { setTimeout(r, 60); });

  // --- 3. disabled / visibility / size checks ---
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
    return { ok: false, reason: 'disabled', selector: sel };
  }
  var style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity || '1') < 0.05) {
    return { ok: false, reason: 'hidden', selector: sel };
  }
  var rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return { ok: false, reason: 'zero_size', selector: sel };
  }

  // --- 4. focus inputs ---
  var tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }

  // --- 5. synthetic pointer/mouse sequence at element center ---
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  var methods = [];
  function fire(type) {
    var opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: 0, buttons: type.indexOf('down') >= 0 ? 1 : 0
    };
    var Ev = null;
    if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
      try { Ev = new PointerEvent(type, Object.assign({ pointerType: 'mouse', pointerId: 1, isPrimary: true }, opts)); } catch (e) {}
    }
    if (!Ev) {
      var m = type.replace('pointer', 'mouse');
      try { Ev = new MouseEvent(m, opts); } catch (e) { return; }
    }
    try { el.dispatchEvent(Ev); methods.push(type); } catch (e) {}
  }
  try {
    fire('pointerover');  fire('pointerenter');
    fire('mouseover');    fire('mouseenter');
    fire('pointermove');  fire('mousemove');
    fire('pointerdown');  fire('mousedown');
    fire('pointerup');    fire('mouseup');
  } catch (e) {}

  // --- 6. el.click() for default actions (submit, nav, toggle) ---
  // Deliberately skip fire('click') before this so native + synthetic don't double-fire.
  var clicked = false;
  try {
    if (typeof el.click === 'function') { el.click(); methods.push('native'); clicked = true; }
  } catch (e) { methods.push('native_error:' + String(e && e.message || e).slice(0, 80)); }
  if (!clicked) {
    // Last-ditch: synthesize a click event ourselves.
    fire('click');
  }

  return {
    ok: true,
    methods: methods,
    selector: sel,
    tag: tag,
    cx: cx, cy: cy,
    href: (tag === 'a' && el.href) ? String(el.href).slice(0, 200) : null
  };
} catch (e) {
  return { ok: false, reason: 'exception', error: String(e && e.message || e) };
}
})()`
}

// Translate sanitized plan actions into the exact payload Firecrawl's
// /v1/scrape `actions` array expects. Right now the only translation we do
// is swapping native `{type:'click', selector}` for an `executeJavascript`
// action running the browser-use-style click above. Everything else passes
// through untouched. This is applied at the fcScrape boundary so internal
// pipeline metadata (burstActions probing `sa.type === 'click'`, log labels,
// etc.) keeps working with the original sanitized shape.
function toFirecrawlActions(actions) {
  if (!Array.isArray(actions)) return actions
  return actions.map((a) => {
    if (a && a.type === 'click' && a.selector) {
      return { type: 'executeJavascript', script: browserUseClickScript(a.selector) }
    }
    return a
  })
}

// Pull the browser-use click-result (from `browserUseClickScript`) out of a
// Firecrawl scrape response. Click results are objects WITHOUT a `viewport`
// field, so we can distinguish them from rect-probe returns. Returns the
// latest click result found, or null if none.
function parseClickResultFromScrape(scrape) {
  const list = scrape?.actions?.javascriptReturns || scrape?.actions?.javascript_returns || []
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k]
    const v = e?.return ?? e?.value ?? e?.result ?? (typeof e === 'object' ? e : null)
    if (v && typeof v === 'object' && !v.viewport && typeof v.ok === 'boolean') {
      return v
    }
  }
  return null
}

// Pull the rect-probe return value out of a Firecrawl scrape response.
// Firecrawl's response shape for executeJavascript can vary; try a few keys.
function parseRectFromScrape(scrape) {
  const list = scrape?.actions?.javascriptReturns || scrape?.actions?.javascript_returns || []
  for (let k = list.length - 1; k >= 0; k--) {
    const e = list[k]
    const v = e?.return ?? e?.value ?? e?.result ?? (typeof e === 'object' && e?.viewport ? e : null)
    if (v && typeof v === 'object' && v.viewport && typeof v.viewport.w === 'number' && typeof v.viewport.h === 'number') {
      return v
    }
  }
  return null
}

function rectToCursor(rect) {
  if (!rect || !rect.found || !rect.viewport?.w || !rect.viewport?.h) return null
  const cx = (rect.x + rect.w / 2) / rect.viewport.w
  const cy = (rect.y + rect.h / 2) / rect.viewport.h
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  // Clamp to [0.02, 0.98] so the cursor stays inside the visible stage.
  return {
    x: Math.max(0.02, Math.min(0.98, cx)),
    y: Math.max(0.02, Math.min(0.98, cy)),
  }
}

// Heuristic cursor position (normalized 0..1) for a given action.
// Used as a fallback when we can't probe the real element rect from the page
// (Firecrawl `executeJavascript` is the source of truth — see
// `selectorRectScript` above). The heuristic still drives non-selector
// actions (write/press/scroll) and the in-flight cursor before the rect
// arrives.
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

async function streamFireworks(messages, onDelta, { temperature = 0.3, model, max_tokens = 600, reasoning_effort = null } = {}) {
  const body = {
    model: model || FIREWORKS_ACT_MODEL,
    max_tokens,
    temperature,
    messages,
    stream: true,
  }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort
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
      { temperature: 0.3, reasoning_effort: FIREWORKS_PLAN_REASONING }
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
      { temperature: 0.3, json: false, reasoning_effort: FIREWORKS_PLAN_REASONING }
    )
    return out.trim()
  } catch (err) {
    const verdict = passed ? 'passed' : 'failed'
    return `Test ${verdict} in ${durationMs}ms. Final page: ${title || finalUrl}.`
  }
}

// ----- Agentic loop: model observes the page after every action and decides
// the next single tool call. Streams reasoning + tool calls + frames live. -----

const AGENT_SYSTEM = `You are an autonomous browser-testing agent. Each turn you receive:
1. The user's overall goal.
2. A screenshot of the current page (look at it carefully).
3. A numbered list of every interactive element the browser can currently see — this is your element index.
4. The current URL, page title, and a snippet of the page HTML.

You MUST respond by calling exactly ONE tool per turn. Do not write any prose; the tool call IS your action.

Tools available:
- navigate({ url }): go to a fully-qualified https URL (use this for the very first step if no page is loaded).
- click({ index }): click an element by its NUMBER from the element index list below the screenshot. Always use the index — never guess a CSS selector. Example: click({ index: 3 }) clicks element [3].
- type_text({ text }): type text into the field that was most recently clicked/focused. There is NO index — click the input first, then type.
- press({ key }): press a key (usually "Enter" to submit a form).
- scroll({ direction }): "up" or "down". Use this to reveal more elements if the one you need is not visible.
- wait({ milliseconds }): wait briefly for the page to settle (200-2000 ms).
- finish({ passed, reason, evidence }): end the test. Set passed=true if the goal was met, false otherwise. reason is a short human explanation; evidence is a quoted snippet from the observed page text that supports the verdict.

Rules:
- Always call exactly one tool per turn — never zero, never multiple.
- ALWAYS use click({ index: N }) — never make up CSS selectors.
- If an element you need is not in the list, scroll() to reveal more, then observe again.
- After typing, follow with press("Enter") or click the submit button index.
- Do not reuse real credentials; use placeholders like demo@example.com.
- Stop with finish() as soon as you have clear evidence the goal succeeded or definitively failed.`

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'navigate', description: 'Open a URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'click', description: 'Click an element by its index number from the element list. Always use index, never a CSS selector.', parameters: { type: 'object', properties: { index: { type: 'integer', description: 'The element index number shown in [brackets] in the element list' } }, required: ['index'] } } },
  { type: 'function', function: { name: 'type_text', description: 'Type into the focused field (click the field first)', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'press', description: 'Press a key', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll the page to reveal more elements', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'wait', description: 'Wait briefly for the page to settle', parameters: { type: 'object', properties: { milliseconds: { type: 'number' } }, required: ['milliseconds'] } } },
  { type: 'function', function: { name: 'finish', description: 'End the test', parameters: { type: 'object', properties: { passed: { type: 'boolean' }, reason: { type: 'string' }, evidence: { type: 'string' } }, required: ['passed', 'reason'] } } },
]

// Resolve a click-by-index tool call into a Firecrawl action.
// `currentElements` is the element list from the most recent page observation.
function resolveClickIndex(index, currentElements) {
  const el = Array.isArray(currentElements)
    ? currentElements.find((e) => e.index === index)
    : null
  const selector = el?.selector || null
  return { selector, element: el || null }
}

function agentToolToFirecrawl(name, args, currentElements) {
  switch (name) {
    case 'click': {
      const idx = Number(args.index)
      const { selector } = resolveClickIndex(idx, currentElements)
      if (!selector) return null
      return { type: 'click', selector }
    }
    case 'type_text': return { type: 'write', text: String(args.text ?? '') }
    case 'press':     return { type: 'press', key: String(args.key || 'Enter') }
    case 'scroll':    return { type: 'scroll', direction: args.direction === 'up' ? 'up' : 'down' }
    case 'wait':      return { type: 'wait', milliseconds: Math.max(50, Math.min(5000, Number(args.milliseconds) || 500)) }
    default:          return null
  }
}

function shortLabel(name, args, currentElements) {
  switch (name) {
    case 'navigate':  return `navigate to ${args.url}`
    case 'click': {
      const idx = Number(args.index)
      const el = Array.isArray(currentElements) ? currentElements.find((e) => e.index === idx) : null
      const desc = el ? `[${idx}] ${el.text || el.role || el.tag}`.slice(0, 50) : `[${idx}]`
      return `click ${desc}`
    }
    case 'type_text': return `type "${String(args.text || '').slice(0, 60)}"`
    case 'press':     return `press ${args.key}`
    case 'scroll':    return `scroll ${args.direction}`
    case 'wait':      return `wait ${args.milliseconds}ms`
    case 'finish':    return `finish (${args.passed ? 'pass' : 'fail'})`
    default:          return name
  }
}

function htmlToObservation(html) {
  if (!html) return ''
  let s = String(html)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style>/gi, ' ')
       .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
       .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
       .replace(/\son\w+="[^"]*"/gi, '')
       .replace(/\sstyle="[^"]*"/gi, '')
       .replace(/\sclass="[^"]*"/gi, '')
       .replace(/\sdata-[a-z0-9-]+="[^"]*"/gi, '')
       .replace(/\s+/g, ' ')
       .trim()
  return s.slice(0, 6000)
}

async function streamAgentTurn({ messages, onReasoning, onContent, signal }) {
  const body = {
    model: FIREWORKS_AGENT_MODEL,
    max_tokens: 1024,
    temperature: 0.2,
    messages,
    tools: AGENT_TOOLS,
    tool_choice: 'auto',
    stream: true,
    reasoning_effort: FIREWORKS_PLAN_REASONING,
  }
  const hasPriorAssistant = messages.some((m) => m.role === 'assistant')
  if (hasPriorAssistant) body.reasoning_history = 'preserved'

  const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '')
    throw new Error(`Fireworks ${r.status}: ${t.slice(0, 300)}`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  // tool_calls assembled by index
  const toolBuf = {}
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
      if (data === '[DONE]') break
      try {
        const j = JSON.parse(data)
        const d = j.choices?.[0]?.delta || {}
        if (d.reasoning_content) { reasoning += d.reasoning_content; onReasoning?.(d.reasoning_content) }
        if (d.content) { content += d.content; onContent?.(d.content) }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0
            const slot = toolBuf[i] || (toolBuf[i] = { name: '', args: '' })
            if (tc.function?.name) slot.name = tc.function.name
            if (tc.function?.arguments) slot.args += tc.function.arguments
          }
        }
      } catch {}
    }
  }
  // Pick the first complete tool call.
  const indices = Object.keys(toolBuf).map(Number).sort((a, b) => a - b)
  for (const i of indices) {
    const slot = toolBuf[i]
    if (!slot?.name) continue
    let args = {}
    try { args = JSON.parse(slot.args || '{}') } catch {}
    return { name: slot.name, args, reasoning, content }
  }
  return { name: null, args: null, reasoning, content }
}

async function forceFinishVerdict({ goal, observation, signal }) {
  const obsUrl = observation?.url || '(unknown)'
  const obsTitle = observation?.title || ''
  const obsText = String(observation?.text || '').slice(0, 6000)
  const body = {
    model: FIREWORKS_AGENT_MODEL,
    max_tokens: 220,
    temperature: 0,
    messages: [
      { role: 'system', content: AGENT_SYSTEM },
      {
        role: 'user',
        content:
          `You are at the final decision step and must call finish() now.\n` +
          `Goal: ${goal}\n` +
          `Current URL: ${obsUrl}\n` +
          `Page title: ${obsTitle}\n` +
          `Observed page text/html excerpt:\n${obsText}\n\n` +
          `Call finish({passed, reason, evidence}) immediately based only on this evidence.`,
      },
    ],
    tools: AGENT_TOOLS,
    tool_choice: { type: 'function', function: { name: 'finish' } },
  }
  const r = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Fireworks ${r.status}: ${text.slice(0, 300)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Fireworks returned non-JSON')
  }
  const calls = data?.choices?.[0]?.message?.tool_calls
  const call = Array.isArray(calls) ? calls.find((c) => c?.function?.name === 'finish') : null
  if (!call) throw new Error('No finish tool call returned')
  let args = {}
  try {
    args = JSON.parse(call.function?.arguments || '{}')
  } catch {}
  return {
    passed: Boolean(args?.passed),
    reason: String(args?.reason || ''),
    evidence: String(args?.evidence || ''),
  }
}

function heuristicFinishVerdict(goal, observation) {
  const g = String(goal || '')
  const text = String(observation?.text || '').toLowerCase()
  const url = String(observation?.url || '').toLowerCase()
  const title = String(observation?.title || '').toLowerCase()
  const haystack = `${text}\n${url}\n${title}`
  const q = g.match(/["']([^"']{2,80})["']/)?.[1]
  const mention = g.match(/mentions?\s+([A-Za-z0-9._-]{2,40})/i)?.[1]
  const token = (q || mention || '').trim()
  if (token && haystack.includes(token.toLowerCase())) {
    return {
      passed: true,
      reason: `Reached step limit, but observed evidence satisfies "${token}".`,
      evidence: token,
    }
  }
  return {
    passed: false,
    reason: 'Agent reached step limit without calling finish(), and no conclusive evidence was found.',
    evidence: '',
  }
}

async function fetchAsDataUrl(url, signal) {
  try {
    const r = await fetch(url, { signal })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const ct = r.headers.get('content-type') || 'image/png'
    return `data:${ct};base64,${buf.toString('base64')}`
  } catch { return null }
}

app.post('/api/run-agent', async (req, res) => {
  // Background mode: kick off the agent loop, return immediately, and let
  // clients attach to /api/runs/:taskId/events to receive live + replayed
  // events. The run keeps going even if no client is attached.
  if (!FIREWORKS_API_KEY) return res.status(400).json({ error: 'FIREWORKS_API_KEY missing' })
  if (!FIRECRAWL_API_KEY) return res.status(400).json({ error: 'FIRECRAWL_API_KEY missing' })
  const { goal, startUrl, taskId } = req.body || {}
  if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal required' })
  if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' })

  const r = createOrResetRun(taskId, 'agent')
  res.json({ started: true, taskId, kind: 'agent' })

  ;(async () => {
    const send = (event, data) => runEvent(taskId, event, data)
    const ac = r.ac
    const startMs = Date.now()
    send('start', { goal, startUrl: startUrl || null })

    try {

    async function fcScrape(url, actions, formats = ['screenshot']) {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify({ url, formats, onlyMainContent: false, waitFor: 600, timeout: 60000, actions: toFirecrawlActions(actions) }),
      })
      const text = await r.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`Firecrawl non-JSON ${r.status}: ${text.slice(0, 200)}`) }
      if (!r.ok || data.success === false) throw new Error(`Firecrawl ${r.status}: ${data?.error || text.slice(0, 200)}`)
      return data.data || data
    }

    let currentUrl = startUrl || null
    let replay = []
    let lastShot = null
    let lastScrape = null
    let lastObservation = { url: currentUrl || '', title: '', text: '' }
    let currentElements = []   // numbered element list from the most recent observation
    let aborted = ac.signal.aborted
    ac.signal.addEventListener('abort', () => { aborted = true })
    const messages = [
      { role: 'system', content: AGENT_SYSTEM },
      { role: 'user', content: `Goal: ${goal}\n\n${currentUrl ? `Suggested starting URL: ${currentUrl}` : 'No starting URL provided — call navigate() first with a sensible https URL.'}` },
    ]

    let prev = { x: 0.5, y: 0.5 }
    let verdict = null
    const MAX_STEPS = 14
    for (let step = 0; step < MAX_STEPS; step++) {
      if (aborted) break
      // 1. Observe current page (only if we have a URL).
      let observation
      let screenshotDataUrl = null
      if (currentUrl) {
        send('cursor', { actionIndex: step, x: prev.x, y: prev.y, label: `observing ${currentUrl}`, busy: true })
        try {
          // Include the element-index extraction script so we get the numbered
          // element list in the same Firecrawl call as the screenshot.
          const acts = [
            ...replay,
            { type: 'wait', milliseconds: 400 },
            { type: 'screenshot' },
            { type: 'executeJavascript', script: buildElementIndexScript() },
          ]
          lastScrape = await fcScrape(currentUrl, acts, ['screenshot', 'html', 'markdown'])
          const shot = (lastScrape?.actions?.screenshots || [])[ (lastScrape?.actions?.screenshots || []).length - 1 ] || lastScrape?.screenshot
          if (shot) {
            lastShot = shot
            send('frame', { image: shot, actionIndex: step })
            screenshotDataUrl = await fetchAsDataUrl(shot, ac.signal)
          }
          // Extract the numbered element list from the executeJavascript return.
          currentElements = parseElementsFromScrape(lastScrape)
          observation = {
            url: lastScrape?.metadata?.sourceURL || currentUrl,
            title: lastScrape?.metadata?.title || '',
            text: htmlToObservation(lastScrape?.html || lastScrape?.markdown || ''),
            elements: currentElements,
          }
          lastObservation = observation
          send('observation', { step, url: observation.url, title: observation.title, elementCount: currentElements.length })
        } catch (err) {
          observation = { url: currentUrl, title: '', text: '', elements: [], error: String(err.message || err) }
          lastObservation = observation
          send('observation', { step, url: currentUrl, title: '', error: observation.error })
        }
      } else {
        observation = { url: '(no page yet)', title: '', text: '', elements: [] }
        lastObservation = observation
      }
      if (aborted) break

      // 2. Build user observation message — multimodal when we have a screenshot.
      // Include the numbered element index so the AI can click by number.
      const elementIndexText = formatElementsForAI(observation.elements || currentElements)
      const obsText = observation.error
        ? `Step ${step + 1}. Page load failed: ${observation.error}\nDecide the next single tool call.`
        : `Step ${step + 1}.\nCurrent URL: ${observation.url}\nPage title: ${observation.title}\n\n` +
          `Interactive elements on this page (use these index numbers to click):\n${elementIndexText}\n\n` +
          `Visible page HTML (truncated — for context only, use element index numbers above to click):\n${observation.text}\n\n` +
          `Call exactly one tool. To click something, use click({ index: N }) with the number from the list above.`
      const userContent = screenshotDataUrl
        ? [
            { type: 'image_url', image_url: { url: screenshotDataUrl } },
            { type: 'text', text: obsText },
          ]
        : obsText
      messages.push({ role: 'user', content: userContent })

      // 3. Stream agent turn.
      send('cursor', { actionIndex: step, x: prev.x, y: prev.y, label: 'agent thinking…', busy: true })
      let turn
      try {
        turn = await streamAgentTurn({
          messages,
          signal: ac.signal,
          onReasoning: (d) => send('reasoning_delta', { step, delta: d }),
          onContent:   (d) => send('content_delta',   { step, delta: d }),
        })
      } catch (err) {
        if (aborted) break
        const msg = `Agent step ${step + 1} failed: ${err.message || err}`
        send('error', { error: msg })
        patchRunTask(taskId, { status: 'fail', error: msg })
        return
      }
      if (aborted) break
      if (!turn.name) {
        // Some vision models reply with prose instead of a tool call. Nudge once.
        send('reasoning_delta', { step, delta: '\n[no tool call returned — re-prompting]\n' })
        messages.push({ role: 'user', content: 'You must call exactly one tool. Do not write prose. Pick the single best next tool call now.' })
        try {
          turn = await streamAgentTurn({
            messages,
            signal: ac.signal,
            onReasoning: (d) => send('reasoning_delta', { step, delta: d }),
            onContent:   (d) => send('content_delta',   { step, delta: d }),
          })
        } catch (err) {
          if (aborted) break
          const msg = `Agent step ${step + 1} retry failed: ${err.message || err}`
          send('error', { error: msg })
          patchRunTask(taskId, { status: 'fail', error: msg })
          return
        }
        if (!turn?.name) {
          const msg = `Agent step ${step + 1} returned no tool call after retry`
          send('error', { error: msg })
          patchRunTask(taskId, { status: 'fail', error: msg })
          return
        }
      }

      // Persist the assistant turn so the model has memory.
      const assistantMsg = {
        role: 'assistant',
        content: turn.content || '',
        tool_calls: [{ id: `c${step}`, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.args || {}) } }],
      }
      if (turn.reasoning) assistantMsg.reasoning_content = turn.reasoning
      messages.push(assistantMsg)

      const label = shortLabel(turn.name, turn.args || {}, currentElements)
      // For click-by-index, use the element's actual coordinates if available.
      let cursor
      if (turn.name === 'click' && turn.args?.index != null) {
        const el = currentElements.find((e) => e.index === Number(turn.args.index))
        if (el && el.cx != null && el.cy != null) {
          const vw = 1280; const vh = 800 // Firecrawl default viewport
          cursor = {
            x: Math.max(0.02, Math.min(0.98, el.cx / vw)),
            y: Math.max(0.02, Math.min(0.98, el.cy / vh)),
          }
        }
      }
      if (!cursor) {
        cursor = estimateCursor(turn.name === 'click' ? { type: 'click', selector: '' } : { type: turn.name }, prev)
      }
      prev = cursor
      send('thinking', { actionIndex: step, tool: turn.name, args: turn.args, label, rationale: turn.reasoning?.slice(0, 400) || '' })
      send('cursor', { actionIndex: step, x: cursor.x, y: cursor.y, label, busy: false })

      // For index-based clicks, we can use the stored element coordinates directly
      // (already applied above). Probe the real rect only as a refinement when
      // we have a resolved selector and the element coords weren't found.
      if (turn.name === 'click' && turn.args?.index != null && currentUrl) {
        const { selector: resolvedSel, element: resolvedEl } = resolveClickIndex(Number(turn.args.index), currentElements)
        if (resolvedSel && !resolvedEl?.cx) {
          try {
            const probe = await fcScrape(
              currentUrl,
              [...replay, { type: 'wait', milliseconds: 250 }, { type: 'executeJavascript', script: selectorRectScript(resolvedSel) }],
              ['html'],
            )
            const real = rectToCursor(parseRectFromScrape(probe))
            if (real) {
              cursor = real
              prev = real
              send('cursor', { actionIndex: step, x: real.x, y: real.y, label, busy: false })
              await sleep(180)
            }
          } catch { /* keep element-coord cursor */ }
        }
      }

      // 4. Execute tool.
      if (turn.name === 'finish') {
        verdict = { passed: Boolean(turn.args?.passed), reason: String(turn.args?.reason || ''), evidence: String(turn.args?.evidence || '') }
        // Tool result back to model (closes the tool call).
        messages.push({ role: 'tool', tool_call_id: `c${step}`, content: 'OK' })
        break
      }
      if (turn.name === 'navigate') {
        const newUrl = String(turn.args?.url || '').trim()
        if (newUrl) { currentUrl = newUrl; replay = []; currentElements = [] }
        messages.push({ role: 'tool', tool_call_id: `c${step}`, content: `navigated to ${newUrl}` })
        continue
      }
      const fcAct = agentToolToFirecrawl(turn.name, turn.args || {}, currentElements)
      if (fcAct) replay.push(fcAct)
      // Tell the model what we resolved the index to, so it has full context.
      const toolResult = (turn.name === 'click' && turn.args?.index != null)
        ? (() => {
            const el = currentElements.find((e) => e.index === Number(turn.args.index))
            return el ? `clicked [${el.index}] ${el.text || el.role || el.tag} (selector: ${el.selector})` : `click index ${turn.args.index} — element not found in current index`
          })()
        : 'OK'
      messages.push({ role: 'tool', tool_call_id: `c${step}`, content: toolResult })
    }

    const durationMs = Date.now() - startMs
    const finalUrl = lastScrape?.metadata?.sourceURL || currentUrl || ''
    const title = lastScrape?.metadata?.title || ''
    if (!verdict && !aborted) {
      try {
        verdict = await forceFinishVerdict({ goal, observation: lastObservation, signal: ac.signal })
      } catch {
        verdict = heuristicFinishVerdict(goal, lastObservation)
      }
    }
    const passed = verdict ? verdict.passed : false
    const expectations = [
      { kind: 'agent_verdict', value: verdict?.reason || (passed ? 'passed' : 'failed'), pass: passed },
    ]

    send('summary_start', { passed, expectations, finalUrl, title, durationMs })
    const summary = await streamSummaryRun(
      { plan: { name: goal, url: startUrl || finalUrl }, finalUrl, title, expectations, passed, durationMs },
      (delta) => send('summary_delta', { delta })
    )
    const screenshots = lastShot ? [lastShot] : []
    send('done', { summary, expectations, passed, finalUrl, title, durationMs, screenshots, verdict })
    patchRunTask(taskId, {
      status: passed ? 'pass' : 'fail',
      duration: durationMs,
      screenshots,
      expectations,
      finalUrl,
      title,
      summary,
    })
    } catch (err) {
      console.error('run-agent error:', err)
      const isAbort = err?.name === 'AbortError' || ac.signal.aborted
      if (!isAbort) {
        try { send('error', { error: String(err.message || err) }) } catch {}
        patchRunTask(taskId, { status: 'fail', error: String(err.message || err) })
      }
    } finally {
      const finalStatus = ac.signal.aborted ? 'aborted' : (r.taskPatch?.status === 'fail' ? 'error' : 'done')
      try { await endRun(taskId, finalStatus) } catch {}
    }
  })()
})

app.post('/api/run-stream', async (req, res) => {
  // Background mode: the planned-run worker is decoupled from the SSE socket.
  // We register the run in `runRegistry`, return immediately, and clients
  // attach to /api/runs/:taskId/events to follow along.
  if (!FIRECRAWL_API_KEY) return res.status(400).json({ error: 'FIRECRAWL_API_KEY missing' })
  const { plan, taskId } = req.body || {}
  if (!plan || !plan.url) return res.status(400).json({ error: 'plan with url required' })
  if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' })

  const r = createOrResetRun(taskId, 'planned')
  res.json({ started: true, taskId, kind: 'planned' })

  ;(async () => {
    const send = (event, data) => runEvent(taskId, event, data)
    const ac = r.ac
    let aborted = ac.signal.aborted
    ac.signal.addEventListener('abort', () => { aborted = true })

    try {
    send('start', { url: plan.url, totalActions: plan.actions.length })
    const start = Date.now()

    // ---- Firecrawl-only progressive streaming ----
    // We can't keep a session across HTTP calls on standard Firecrawl plans, so
    // we replay all prior actions on each step and capture a screenshot at the
    // end. The user sees one new frame per planned action, plus an animated
    // cursor between frames. Slower than a true live stream, but it works on
    // any Firecrawl plan and on deployment without local browsers.

    async function fcScrape({ url, actions, formats = ['screenshot'], onlyMain = false }) {
      const body = {
        url,
        formats,
        onlyMainContent: onlyMain,
        waitFor: 600,
        timeout: 60000,
        actions: toFirecrawlActions(actions),
      }
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
        body: JSON.stringify(body),
      })
      const text = await r.text()
      let data
      try { data = JSON.parse(text) } catch {
        throw new Error(`Firecrawl returned non-JSON (${r.status}): ${text.slice(0, 200)}`)
      }
      if (!r.ok || data.success === false) {
        throw new Error(`Firecrawl ${r.status}: ${data?.error || text.slice(0, 200)}`)
      }
      return data.data || data
    }

    // ---- Self-healing: when a click/wait selector fails, ask the AI to look
    // at the current page HTML and propose a corrected Playwright-compatible
    // selector for the same intent. Returns the new selector string, or null. ----
    async function repairSelector({ failedAction, intentLabel, html }) {
      try {
        const trimmedHtml = String(html || '').slice(0, 18000)
        const sys = `You repair broken Playwright selectors for an E2E test runner that uses Firecrawl's actions API.
You will be given:
1. The failing action (click or wait) the test agent tried.
2. A short label describing the user-visible intent.
3. A snippet of the current page HTML.

Return ONLY a JSON object: { "selector": "<new selector>" }
Rules:
- Selector must be a single Playwright-compatible selector that uniquely matches the intended element on this page.
- Strongly prefer text-engine selectors like "text=Sign in" or "text=/^Search/i" for buttons/links/labels.
- For inputs, prefer attribute selectors: input[name='q'], [aria-label='Search'], [placeholder*='Search'], input[type='email'].
- Do not invent class names. Use only attributes/text you can see in the HTML.
- If nothing in the HTML matches the intent, return { "selector": "" }.`
        const usr = `Failing action: ${JSON.stringify(failedAction)}
Intent: ${intentLabel}

HTML snippet:
${trimmedHtml}`
        const raw = await callFireworks(
          [{ role: 'system', content: sys }, { role: 'user', content: usr }],
          { temperature: 0, json: true, max_tokens: 200 }
        )
        const obj = JSON.parse(stripJsonFence(raw))
        const sel = String(obj?.selector || '').trim()
        return sel || null
      } catch { return null }
    }

    function pickScreenshot(scrape) {
      const fromActions = scrape?.actions?.screenshots
      if (Array.isArray(fromActions) && fromActions.length) {
        return fromActions[fromActions.length - 1]
      }
      return scrape?.screenshot || null
    }

    function allScreenshots(scrape) {
      const list = scrape?.actions?.screenshots
      if (Array.isArray(list) && list.length) return list
      return scrape?.screenshot ? [scrape.screenshot] : []
    }

    // Replay all screenshots returned by one Firecrawl call as a sequential
    // mini-clip so the user sees a short "video" of what just happened.
    async function streamShots(scrape, actionIndex) {
      const shots = allScreenshots(scrape)
      if (!shots.length) return null
      for (let k = 0; k < shots.length; k++) {
        send('frame', { image: shots[k], actionIndex, frameIndex: k, totalFrames: shots.length })
        if (k < shots.length - 1) await sleep(180)
      }
      return shots[shots.length - 1]
    }

    // Build a Firecrawl action list that captures several screenshots around
    // the real action so that, when the call returns, we can stream a burst
    // of frames to the client (closest thing to a live feed via /scrape).
    // For selector-based actions (click / wait-for-selector), we also probe
    // the target element's bounding rect via executeJavascript so the AI
    // cursor can be moved to the actual element instead of a heuristic guess.
    function burstActions({ replayPrior, sa, beforeWait = 600, dwell = 200, postShots = 4 }) {
      const out = [
        ...replayPrior,
        { type: 'wait', milliseconds: beforeWait },
        { type: 'screenshot' },           // before
      ]
      const probeSel = (sa.type === 'click' || (sa.type === 'wait' && sa.selector)) ? sa.selector : null
      if (probeSel) {
        out.push({ type: 'executeJavascript', script: selectorRectScript(probeSel) })
      }
      out.push(sa)
      for (let k = 0; k < postShots; k++) {
        out.push({ type: 'wait', milliseconds: dwell })
        out.push({ type: 'screenshot' })  // after, multiple times
      }
      return out
    }

    // ---- 1. Initial frame: just open the URL with one screenshot ----
    send('cursor', { actionIndex: -1, x: 0.5, y: 0.1, label: `opening ${plan.url}` })
    let lastShot = null
    try {
      const initial = await fcScrape({ url: plan.url, actions: [{ type: 'screenshot' }] })
      lastShot = pickScreenshot(initial)
      if (lastShot) send('frame', { image: lastShot, actionIndex: -1 })
    } catch (err) {
      send('cursor', { actionIndex: -1, x: 0.5, y: 0.1, label: `! open failed: ${String(err.message || err).slice(0, 80)}` })
    }

    // ---- 2. Walk through actions, replaying prior steps each call ----
    const replay = [] // accumulated sanitized actions executed so far
    let prev = { x: 0.5, y: 0.5 }
    let lastScrape = null
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
        else if (sa.type === 'screenshot' || sa.type === 'scrape') continue // we always shoot at end

        const cursor = estimateCursor(a, prev)
        prev = cursor
        send('thinking', {
          actionIndex: i,
          tool: sa.type,
          args: sa,
          label,
          rationale: `Step ${i + 1} of ${plan.actions.length}: ${label}`,
        })
        send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label })

        replay.push(sa)
        // Insert a small wait before clicks/writes/presses for resilience on slow pages.
        const needsWait = sa.type === 'click' || sa.type === 'write' || sa.type === 'press'
        const stepActions = burstActions({
          replayPrior: replay.slice(0, -1),
          sa,
          beforeWait: needsWait ? 600 : 250,
          dwell: 220,
          postShots: 4,
        })
        const isLast = i === plan.actions.length - 1
        const formats = isLast ? ['markdown', 'html', 'screenshot'] : ['screenshot']
        let ok = false
        // Tell the UI we're now waiting on Firecrawl to actually run this step.
        send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label: `${label} · executing…`, busy: true })
        // Helper: when we got a real rect back, animate the cursor onto the
        // actual element BEFORE streaming the post-action frames so the
        // user sees the cursor land on the right place.
        async function applyRealCursorIfAny(scrape) {
          const rect = parseRectFromScrape(scrape)
          const real = rectToCursor(rect)
          if (real) {
            prev = real
            send('cursor', { actionIndex: i, action: a, x: real.x, y: real.y, label, busy: true })
            await sleep(220)
            return real
          }
          return null
        }
        // The browser-use click script returns `{ok:false, reason}` silently
        // rather than throwing on failure, so we have to inspect the JS
        // return value and translate `ok:false` into a thrown error —
        // otherwise Firecrawl sees the action as successful and the existing
        // retry/repair chain below never fires.
        function assertClickSucceeded(scrape) {
          if (sa.type !== 'click') return
          const result = parseClickResultFromScrape(scrape)
          if (result && result.ok === false) {
            throw new Error(`click ${sa.selector}: ${result.reason || 'failed'}`)
          }
        }
        try {
          const scrape = await fcScrape({ url: plan.url, actions: stepActions, formats, onlyMain: false })
          lastScrape = scrape
          assertClickSucceeded(scrape)
          await applyRealCursorIfAny(scrape)
          const lastBurst = await streamShots(scrape, i)
          if (lastBurst) lastShot = lastBurst
          ok = true
        } catch (err) {
          // First retry: longer waits in case the element wasn't ready.
          try {
            const retry = burstActions({
              replayPrior: replay.slice(0, -1),
              sa,
              beforeWait: 1500,
              dwell: 350,
              postShots: 3,
            })
            const scrape = await fcScrape({ url: plan.url, actions: retry, formats, onlyMain: false })
            lastScrape = scrape
            assertClickSucceeded(scrape)
            await applyRealCursorIfAny(scrape)
            const lastBurst = await streamShots(scrape, i)
            if (lastBurst) lastShot = lastBurst
            ok = true
          } catch (err2) {
            // Self-healing: only relevant for selector-based actions (click/wait-for).
            let healed = false
            if ((sa.type === 'click' || (sa.type === 'wait' && sa.selector))) {
              try {
                send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label: `repairing selector for ${label}…` })
                // Grab current page HTML by replaying prior good actions only.
                const ctx = await fcScrape({
                  url: plan.url,
                  actions: [...replay.slice(0, -1), { type: 'wait', milliseconds: 600 }],
                  formats: ['html'],
                  onlyMain: false,
                })
                const newSel = await repairSelector({
                  failedAction: sa,
                  intentLabel: label,
                  html: ctx?.html || '',
                })
                if (newSel) {
                  const fixed = { ...sa, selector: newSel }
                  const heal = burstActions({
                    replayPrior: replay.slice(0, -1),
                    sa: fixed,
                    beforeWait: 800,
                    dwell: 250,
                    postShots: 3,
                  })
                  const scrape3 = await fcScrape({ url: plan.url, actions: heal, formats, onlyMain: false })
                  lastScrape = scrape3
                  // Check the repaired click too — if it also silently failed,
                  // don't mark healed so the outer skip path kicks in.
                  const healedResult = parseClickResultFromScrape(scrape3)
                  if (sa.type === 'click' && healedResult && healedResult.ok === false) {
                    throw new Error(`repaired click ${newSel}: ${healedResult.reason || 'failed'}`)
                  }
                  const realHealed = await applyRealCursorIfAny(scrape3)
                  const lastBurst3 = await streamShots(scrape3, i)
                  if (lastBurst3) lastShot = lastBurst3
                  // Replace the failed action in replay with the healed one.
                  replay[replay.length - 1] = fixed
                  healed = true
                  const cx = realHealed?.x ?? cursor.x
                  const cy = realHealed?.y ?? cursor.y
                  send('cursor', { actionIndex: i, action: a, x: cx, y: cy, label: `${label} (repaired → ${newSel.slice(0, 40)})` })
                }
              } catch { /* fall through to skip */ }
            }
            if (!healed) {
              replay.pop()
              send('cursor', { actionIndex: i, action: a, x: cursor.x, y: cursor.y, label: `! ${label} skipped: ${String(err2.message || err2).slice(0, 80)}` })
            }
          }
        }
        await sleep(120)
      }
    }

    // ---- 3. If we never got a full scrape (e.g. no actions), do one now ----
    if (!lastScrape || !lastScrape.html) {
      try {
        lastScrape = await fcScrape({
          url: plan.url,
          actions: [...replay, { type: 'wait', milliseconds: 400 }, { type: 'screenshot' }],
          formats: ['markdown', 'html', 'screenshot'],
        })
        const shot = pickScreenshot(lastScrape)
        if (shot) { lastShot = shot; send('frame', { image: shot, actionIndex: -1 }) }
      } catch {}
    }

    send('cursor', { actionIndex: -1, x: 0.5, y: 0.5, label: 'evaluating assertions' })
    const expectations = evaluateExpectations(plan, lastScrape || {})
    const passed = expectations.length === 0 ? true : expectations.every((e) => e.pass)
    const durationMs = Date.now() - start
    const finalUrl = lastScrape?.metadata?.sourceURL || lastScrape?.metadata?.url || plan.url
    const title = lastScrape?.metadata?.title || ''

    send('summary_start', { passed, expectations, finalUrl, title, durationMs })
    const summary = await streamSummaryRun(
      { plan, finalUrl, title, expectations, passed, durationMs },
      (delta) => send('summary_delta', { delta })
    )
    const screenshots = lastShot ? [lastShot] : []
    send('done', { summary, expectations, passed, finalUrl, title, durationMs, screenshots })
    patchRunTask(taskId, {
      status: passed ? 'pass' : 'fail',
      duration: durationMs,
      screenshots,
      expectations,
      finalUrl,
      title,
      summary,
    })
    } catch (err) {
      console.error('run-stream error:', err)
      const isAbort = err?.name === 'AbortError' || ac.signal.aborted
      if (!isAbort) {
        try { send('error', { error: String(err.message || err) }) } catch {}
        patchRunTask(taskId, { status: 'fail', error: String(err.message || err) })
      }
    } finally {
      const finalStatus = ac.signal.aborted ? 'aborted' : (r.taskPatch?.status === 'fail' ? 'error' : 'done')
      try { await endRun(taskId, finalStatus) } catch {}
    }
  })()
})

// ===== Background run subscription endpoints =====
//
// GET  /api/runs/:taskId/events   — SSE: replay buffered events + subscribe live
// GET  /api/runs/:taskId/status   — quick JSON status check (used on app load
//                                    to decide whether to re-attach to a run)
// POST /api/runs/:taskId/abort    — stop a running background run

app.get('/api/runs/:taskId/status', (req, res) => {
  const r = runRegistry.get(req.params.taskId)
  if (!r) return res.json({ exists: false })
  res.json({
    exists: true,
    status: r.status,
    kind: r.kind,
    eventCount: r.events.length,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  })
})

app.post('/api/runs/:taskId/abort', async (req, res) => {
  const r = runRegistry.get(req.params.taskId)
  if (!r) return res.status(404).json({ error: 'not found' })
  if (r.status !== 'running') return res.json({ ok: true, status: r.status })
  try { r.ac.abort() } catch {}
  runEvent(req.params.taskId, 'error', { error: 'Stopped by user' })
  patchRunTask(req.params.taskId, { status: 'fail', error: 'Stopped by user' })
  await endRun(req.params.taskId, 'aborted')
  res.json({ ok: true, status: 'aborted' })
})

app.get('/api/runs/:taskId/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
  })
  try { req.socket?.setNoDelay?.(true) } catch {}
  try { req.socket?.setKeepAlive?.(true, 15000) } catch {}
  res.flushHeaders?.()
  res.write(`: ${' '.repeat(2048)}\n\n`)

  const r = runRegistry.get(req.params.taskId)
  if (!r) {
    res.write(`event: end\ndata: ${JSON.stringify({ status: 'not_found' })}\n\n`)
    return res.end()
  }

  // Replay buffered events so a late attach catches up to the present.
  for (const e of r.events) {
    res.write(`event: ${e.event}\n`)
    res.write(`data: ${JSON.stringify(e.data)}\n\n`)
  }
  if (r.status !== 'running') {
    res.write(`event: end\ndata: ${JSON.stringify({ status: r.status })}\n\n`)
    return res.end()
  }
  // Subscribe to live events. Heartbeat every 10s so proxies don't time out.
  r.subs.add(res)
  const hb = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`) } catch {} }, 10000)
  r.heartbeats.set(res, hb)
  const cleanup = () => {
    clearInterval(hb)
    r.heartbeats.delete(res)
    r.subs.delete(res)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
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
