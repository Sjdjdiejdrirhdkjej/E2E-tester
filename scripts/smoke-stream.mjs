// Live smoke test for the /api/run-stream SSE pipeline.
// Assumes the API server is already running on http://127.0.0.1:8000.
// Usage: node scripts/smoke-stream.mjs

import { writeFileSync, mkdirSync } from 'node:fs'

const API = process.env.API_BASE || 'http://127.0.0.1:8000'

// Hardcoded plan — skip the LLM planner so we isolate the streaming pipeline.
const plan = {
  name: 'DDG search smoke',
  url: 'https://duckduckgo.com/',
  actions: [
    { type: 'wait', milliseconds: 800 },
    { type: 'click', selector: 'input[name="q"]' },
    { type: 'write', text: 'firecrawl' },
    { type: 'press', key: 'Enter' },
    { type: 'wait', milliseconds: 2500 },
  ],
  expect: [
    { kind: 'contains_text', value: 'firecrawl' },
  ],
}

mkdirSync('/tmp/smoke-frames', { recursive: true })

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '')
  if (!m) return null
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') }
}

const events = []
const frames = []

const t0 = Date.now()
const r = await fetch(`${API}/api/run-stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plan }),
})
if (!r.ok || !r.body) {
  console.error('HTTP', r.status, await r.text().catch(() => ''))
  process.exit(1)
}

const reader = r.body.getReader()
const decoder = new TextDecoder()
let buf = ''
let summary = ''

outer: while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    let event = 'message'
    let data = ''
    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim()
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!data) continue
    let payload
    try { payload = JSON.parse(data) } catch { continue }

    if (event === 'frame') {
      const parsed = parseDataUrl(payload.image)
      if (parsed) {
        frames.push({
          t: Date.now() - t0,
          actionIndex: payload.actionIndex,
          bytes: parsed.buf.length,
          buf: parsed.buf,
        })
      }
      events.push({ t: Date.now() - t0, event, actionIndex: payload.actionIndex, bytes: parsed?.buf.length })
    } else if (event === 'summary_delta') {
      summary += payload.delta || ''
      // Don't log these individually.
    } else {
      events.push({ t: Date.now() - t0, event, ...payload, image: undefined })
    }

    if (event === 'done' || event === 'error') break outer
  }
}

// Save first, middle and last frame.
if (frames.length > 0) {
  const pick = [0, Math.floor(frames.length / 2), frames.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
  for (const [rank, idx] of pick.entries()) {
    const f = frames[idx]
    const tag = rank === 0 ? 'first' : rank === pick.length - 1 ? 'last' : 'middle'
    writeFileSync(`/tmp/smoke-frames/${tag}.jpg`, f.buf)
  }
  writeFileSync(
    '/tmp/smoke-frames/manifest.json',
    JSON.stringify(frames.map((f, i) => ({ i, t: f.t, actionIndex: f.actionIndex, bytes: f.bytes })), null, 2)
  )
}

const byEvent = {}
for (const e of events) byEvent[e.event] = (byEvent[e.event] || 0) + 1

console.log(JSON.stringify({
  totalMs: Date.now() - t0,
  events: byEvent,
  frameCount: frames.length,
  firstFrameAtMs: frames[0]?.t,
  lastFrameAtMs: frames[frames.length - 1]?.t,
  frameBytesMinMax: frames.length
    ? [Math.min(...frames.map((f) => f.bytes)), Math.max(...frames.map((f) => f.bytes))]
    : null,
  summary: summary || null,
  nonFrameEvents: events.filter((e) => e.event !== 'frame').slice(0, 20),
}, null, 2))
