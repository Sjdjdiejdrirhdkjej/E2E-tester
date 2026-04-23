import { useEffect, useMemo, useRef, useState } from 'react'

function uid() { return 't' + Math.random().toString(36).slice(2, 8) }

async function readJson(r) {
  const text = await r.text()
  if (!text) {
    throw new Error(
      r.status === 504 || r.status === 502
        ? `Backend unreachable (HTTP ${r.status}). The dev server may still be starting — try again in a moment.`
        : `Empty response from server (HTTP ${r.status}).`
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Server returned non-JSON (HTTP ${r.status}): ${text.slice(0, 160)}`)
  }
}

function describeAction(a) {
  switch (a?.type) {
    case 'wait':       return `wait ${a.milliseconds || 0}ms`
    case 'click':      return `click ${a.selector}`
    case 'write':      return `type "${a.text}" → ${a.selector}`
    case 'press':      return `press ${a.key}`
    case 'scroll':     return `scroll ${a.direction || 'down'}`
    case 'screenshot': return 'screenshot'
    case 'scrape':     return 'scrape page'
    default:           return JSON.stringify(a)
  }
}

async function streamRun(plan, handlers) {
  const r = await fetch('/api/run-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  })
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '')
    throw new Error(t || `HTTP ${r.status}`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = 'message'; let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim()
        else if (line.startsWith('data: ')) data += line.slice(6)
      }
      if (!data) continue
      let payload
      try { payload = JSON.parse(data) } catch { continue }
      handlers[event]?.(payload)
    }
  }
}

export default function App() {
  const [tests, setTests] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const streamRef = useRef(null)

  const selected = useMemo(() => tests.find((t) => t.id === selectedId) || null, [tests, selectedId])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [selected?.log, selected?.status, selected?.screenshots?.length, selected?.strategistMessage])

  useEffect(() => { setNavOpen(false) }, [selectedId])

  function update(id, patch) {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  async function executePlannedRun(id, plan, displayNameFallback) {
    update(id, {
      status: 'running',
      name: plan.name || displayNameFallback,
      url: plan.url,
      actions: plan.actions,
      expect: plan.expect,
      stepDescriptions: plan.actions.map(describeAction),
      log: '',
      stage: { image: null, cursor: { x: 0.5, y: 0.5 }, label: 'preparing browser…', actionIndex: -1, finished: false },
      summary: null,
    })

    try {
      await streamRun(plan, {
        start: () => {
          update(id, { stage: { image: null, cursor: { x: 0.5, y: 0.5 }, label: 'spinning up browser…', actionIndex: -1, finished: false } })
        },
        cursor: (p) => {
          setTests((prev) => prev.map((t) => t.id === id ? {
            ...t,
            stage: { ...(t.stage || {}), cursor: { x: p.x, y: p.y }, label: p.label, actionIndex: p.actionIndex }
          } : t))
        },
        frame: (p) => {
          setTests((prev) => prev.map((t) => t.id === id ? {
            ...t,
            stage: { ...(t.stage || {}), image: p.image, actionIndex: p.actionIndex }
          } : t))
        },
        summary_start: (p) => {
          setTests((prev) => prev.map((t) => t.id === id ? {
            ...t,
            status: p.passed ? 'pass' : 'fail',
            duration: p.durationMs,
            expectations: p.expectations || [],
            finalUrl: p.finalUrl,
            title: p.title,
            summary: '',
            summaryStreaming: true,
            stage: t.stage ? { ...t.stage, label: p.passed ? 'done' : 'failed', finished: true } : null,
          } : t))
        },
        summary_delta: (p) => {
          setTests((prev) => prev.map((t) => t.id === id
            ? { ...t, summary: (t.summary || '') + (p.delta || '') }
            : t))
        },
        done: (p) => {
          setTests((prev) => prev.map((t) => t.id === id ? {
            ...t,
            status: p.passed ? 'pass' : 'fail',
            duration: p.durationMs,
            screenshots: p.screenshots || [],
            expectations: p.expectations || [],
            finalUrl: p.finalUrl,
            title: p.title,
            summary: p.summary || t.summary,
            summaryStreaming: false,
            stage: {
              image: (p.screenshots && p.screenshots[p.screenshots.length - 1]) || t.stage?.image || null,
              cursor: t.stage?.cursor || { x: 0.5, y: 0.5 },
              label: p.passed ? 'done' : 'failed',
              actionIndex: -1,
              finished: true,
            },
          } : t))
        },
        error: (p) => {
          setTests((prev) => prev.map((t) => t.id === id ? {
            ...t,
            status: 'fail',
            error: p.error,
            summary: null,
            stage: t.stage ? { ...t.stage, label: 'error', finished: true } : null,
          } : t))
        },
      })
    } catch (err) {
      update(id, {
        status: 'fail',
        error: String(err.message || err),
        stage: null,
      })
    } finally {
      setBusy(false)
    }
  }

  async function finalizeActPromptRun(id, goal, actPrompt) {
    setTests((prev) => prev.map((t) => t.id === id ? {
      ...t,
      actPrompt,
      status: 'planning',
      assistantSnapshot: null,
      clarifyingAnswers: '',
      log: (t.log || '') + '\nStrategist called create_plan. Act planner is building the executable plan…\n',
    } : t))

    let plan
    try {
      const r = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: actPrompt }),
      })
      const data = await readJson(r)
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      plan = data.plan
    } catch (err) {
      setTests((prev) => prev.map((t) => t.id === id ? {
        ...t,
        status: 'fail',
        error: String(err.message || err),
        log: (t.log || '') + `\nAct planner failed: ${err.message || err}\n`,
      } : t))
      setBusy(false)
      return
    }

    const fallbackName = goal.length > 70 ? goal.slice(0, 67) + '…' : goal
    await executePlannedRun(id, plan, fallbackName)
  }

  async function startPlanIntake(goal) {
    const id = uid()
    const draftTest = {
      id,
      name: goal.length > 70 ? goal.slice(0, 67) + '…' : goal,
      prompt: goal,
      actPrompt: null,
      strategistMessage: null,
      assistantSnapshot: null,
      clarifyingAnswers: '',
      status: 'clarifying',
      url: null,
      actions: [],
      expect: [],
      stepDescriptions: [],
      screenshots: [],
      expectations: [],
      finalUrl: null,
      title: '',
      duration: null,
      error: null,
      log: 'Plan mode: GLM 5.1 strategist (max reasoning) — only tool: create_plan → act agent…\n',
    }
    setTests((prev) => [draftTest, ...prev])
    setSelectedId(id)
    setBusy(true)

    let continuedToRun = false
    try {
      const r = await fetch('/api/plan-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal }),
      })
      const data = await readJson(r)
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      if (data.actPrompt) {
        continuedToRun = true
        await finalizeActPromptRun(id, goal, data.actPrompt)
        return
      }
      if (data.phase === 'converse') {
        update(id, {
          strategistMessage: data.strategistMessage || '',
          assistantSnapshot: data.assistantSnapshot || null,
          log: draftTest.log + 'Reply below; on continue the strategist must call create_plan for the act agent.\n',
        })
        return
      }
      throw new Error(data.error || 'Unexpected plan-intake response')
    } catch (err) {
      update(id, {
        status: 'fail',
        error: String(err.message || err),
        log: draftTest.log + `\nPlan mode failed: ${err.message || err}\n`,
      })
    } finally {
      if (!continuedToRun) setBusy(false)
    }
  }

  async function submitClarifyContinue() {
    const sel = selected
    if (!sel || busy || sel.status !== 'clarifying') return
    const answers = (sel.clarifyingAnswers || '').trim()
    if (!answers) return
    const id = sel.id
    const goal = sel.prompt
    setBusy(true)
    try {
      const r = await fetch('/api/plan-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          answers,
          assistantSnapshot: sel.assistantSnapshot || null,
        }),
      })
      const data = await readJson(r)
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      if (data.actPrompt) {
        await finalizeActPromptRun(id, goal, data.actPrompt)
        return
      }
      if (data.phase === 'converse') {
        update(id, {
          strategistMessage: data.strategistMessage || '',
          assistantSnapshot: data.assistantSnapshot || null,
          clarifyingAnswers: '',
        })
        setBusy(false)
        return
      }
      throw new Error(data.error || 'Unexpected plan-intake response')
    } catch (err) {
      update(id, {
        status: 'fail',
        error: String(err.message || err),
      })
      setBusy(false)
    }
  }

  async function planAndRun(prompt) {
    const id = uid()
    const draftTest = {
      id,
      name: prompt.length > 70 ? prompt.slice(0, 67) + '…' : prompt,
      prompt,
      actPrompt: null,
      strategistMessage: null,
      assistantSnapshot: null,
      clarifyingAnswers: '',
      status: 'planning',
      url: null,
      actions: [],
      expect: [],
      stepDescriptions: [],
      screenshots: [],
      expectations: [],
      finalUrl: null,
      title: '',
      duration: null,
      error: null,
      log: 'Asking the act planner to build the scenario…\n',
    }
    setTests((prev) => [draftTest, ...prev])
    setSelectedId(id)
    setBusy(true)

    let plan
    try {
      const r = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await readJson(r)
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      plan = data.plan
    } catch (err) {
      update(id, {
        status: 'fail',
        error: String(err.message || err),
        log: draftTest.log + `\nPlanner failed: ${err.message || err}\n`,
      })
      setBusy(false)
      return
    }

    await executePlannedRun(id, plan, draftTest.name)
  }

  async function submitDraft() {
    const v = draft.trim()
    if (!v || busy) return
    setDraft('')
    if (planMode) await startPlanIntake(v)
    else await planAndRun(v)
  }

  async function rerun() {
    if (!selected || busy) return
    const prompt = selected.actPrompt || selected.prompt
    await planAndRun(prompt)
  }

  async function replanFromHere() {
    if (!selected || busy) return
    const prompt = selected.actPrompt || selected.prompt
    const id = uid()
    const baseName = (selected.name || prompt).replace(/\s*·\s*replan.*$/i, '')
    const draftTest = {
      id,
      name: `${baseName} · replan`,
      prompt,
      actPrompt: selected.actPrompt || null,
      status: 'planning',
      url: null,
      actions: [],
      expect: [],
      stepDescriptions: [],
      screenshots: [],
      expectations: [],
      finalUrl: null,
      title: '',
      duration: null,
      error: null,
      log: `Replanning from ${selected.finalUrl || selected.url || '(unknown)'}…\n`,
    }
    setTests((prev) => [draftTest, ...prev])
    setSelectedId(id)
    setBusy(true)
    let plan
    try {
      const r = await fetch('/api/replan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          plan: { url: selected.url, actions: selected.actions || [], expect: selected.expect || [] },
          currentUrl: selected.finalUrl || selected.url,
          failedAt: typeof selected.failedAt === 'number' ? selected.failedAt : (selected.actions?.length || 0),
        }),
      })
      const data = await readJson(r)
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      plan = data.plan
    } catch (err) {
      update(id, { status: 'fail', error: String(err.message || err), log: draftTest.log + `\nReplan failed: ${err.message || err}\n` })
      setBusy(false)
      return
    }
    await executePlannedRun(id, plan, draftTest.name)
  }

  function newTask() { setSelectedId(null); setDraft('') }

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <Sidebar
        tests={tests}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={() => { newTask(); setNavOpen(false) }}
        onClose={() => setNavOpen(false)}
        onDelete={(id) => {
          setTests((prev) => prev.filter((t) => t.id !== id))
          setSelectedId((cur) => (cur === id ? null : cur))
        }}
      />

      <section className="main">
        <header className="topbar">
          <button className="icon-btn ink menu-btn" onClick={() => setNavOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <div className="crumb">
            {selected ? <b>{selected.name}</b> : <>E2E Tester</>}
          </div>
          <div className="top-actions">
            {selected && !busy && selected.status !== 'planning' && selected.status !== 'running' && selected.status !== 'clarifying' && (
              <>
                {selected.status === 'fail' && (selected.finalUrl || selected.url) && (
                  <button className="btn ghost" onClick={replanFromHere} title="Replan the remaining steps from where this run stopped">Replan from here</button>
                )}
                <button className="btn primary" onClick={rerun}>Re-run</button>
              </>
            )}
            {busy && (
              <span className="btn ghost" style={{ cursor: 'default' }}>
                <span className="dot running" style={{ display: 'inline-block', marginRight: 6 }} />
                Working…
              </span>
            )}
          </div>
        </header>

        {selected ? (
          <div className="run">
            <div className="run-stream" ref={streamRef}>
              <h1 className="run-title">{selected.name}</h1>
              <div className="run-sub">{selected.prompt}</div>

              <div className="summary-pills">
                <StatusPill status={selected.status} />
                {selected.actions?.length > 0 && (
                  <span className="pill"><span className="num">{selected.actions.length}</span>&nbsp;actions</span>
                )}
                {selected.duration != null && (
                  <span className="pill"><span className="num">{selected.duration}</span>&nbsp;ms</span>
                )}
                {selected.url && (
                  <a className="pill" href={selected.url} target="_blank" rel="noreferrer">
                    <Icon name="globe" />&nbsp;{shortUrl(selected.url)}
                  </a>
                )}
              </div>

              {selected.status === 'clarifying' && (
                <div className="bubble clarify">
                  <div className="who">Plan mode · GLM 5.1</div>
                  {selected.strategistMessage == null && busy ? (
                    <div className="clarify-loading">
                      <span className="loader" aria-hidden="true" />
                      <span>Strategist is thinking (only tool available: create_plan → act agent)…</span>
                    </div>
                  ) : (
                    <>
                      {selected.strategistMessage != null && (
                        <div className="clarify-md">{selected.strategistMessage}</div>
                      )}
                      <label className="clarify-label" htmlFor="clarify-answers">Your reply</label>
                      <textarea
                        id="clarify-answers"
                        className="clarify-ta"
                        rows={5}
                        value={selected.clarifyingAnswers || ''}
                        onChange={(e) => update(selected.id, { clarifyingAnswers: e.target.value })}
                        placeholder="Answer the strategist’s questions, or add any missing detail (URL, steps, what to assert)."
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="btn primary clarify-go"
                        disabled={busy || !(selected.clarifyingAnswers || '').trim()}
                        onClick={submitClarifyContinue}
                      >
                        Continue — create_plan → run
                      </button>
                    </>
                  )}
                </div>
              )}

              {(selected.stage || selected.status === 'running' || selected.status === 'planning') && (
                <LiveStage
                  stage={selected.stage}
                  status={selected.status}
                />
              )}

              {selected.actPrompt && selected.status !== 'clarifying' && (
                <div className="bubble">
                  <div className="who">Act brief (from plan mode)</div>
                  <div className="body" style={{ marginTop: 8, lineHeight: 1.55 }}>{selected.actPrompt}</div>
                </div>
              )}

              {(selected.summary || selected.summaryStreaming) && selected.status !== 'running' && selected.status !== 'planning' && selected.status !== 'clarifying' && (
                <div className="bubble">
                  <div className="who">Summary · act model</div>
                  <div className="body" style={{ marginTop: 8, lineHeight: 1.55 }}>
                    {selected.summary}
                    {selected.summaryStreaming && <span className="type-caret" />}
                  </div>
                </div>
              )}

              {selected.expectations?.length > 0 && selected.status !== 'running' && (
                <div className="bubble">
                  <div className="who">Assertions</div>
                  <div className="steps" style={{ marginTop: 8 }}>
                    {selected.expectations.map((e, i) => (
                      <div className="step" key={i}>
                        <span className={`dot ${e.pass ? 'pass' : 'fail'}`} />
                        <span className="label">{e.kind}: {e.value}</span>
                        <span className="tag">{e.pass ? 'pass' : 'fail'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.error && (
                <div className="bubble" style={{ borderColor: '#e8c4c0' }}>
                  <div className="who" style={{ color: 'var(--fail)' }}>Error</div>
                  <div className="body" style={{ color: 'var(--fail)' }}>{selected.error}</div>
                </div>
              )}
            </div>

            <aside className="run-aside">
              <div className="aside-h">Scenario</div>
              <div className="kv">
                <div className="k">Status</div><div className="v">{selected.status}</div>
                <div className="k">Start URL</div><div className="v">{selected.url || '—'}</div>
                <div className="k">Final URL</div><div className="v">{selected.finalUrl || '—'}</div>
                <div className="k">Title</div><div className="v">{selected.title || '—'}</div>
                <div className="k">Actions</div><div className="v">{selected.actions?.length || 0}</div>
                <div className="k">Duration</div><div className="v">{selected.duration != null ? `${selected.duration} ms` : '—'}</div>
              </div>

              <div className="aside-h">Stack</div>
              <div className="kv">
                <div className="k">Plan mode</div><div className="v">GLM 5.1 · create_plan only</div>
                <div className="k">Act planner</div><div className="v">Kimi K2 · Fireworks</div>
                <div className="k">Browser</div><div className="v">Firecrawl /scrape</div>
              </div>
            </aside>

            <div className="dock">
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder="Describe another test scenario…"
                disabled={busy || selected?.status === 'clarifying'}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
              />
            </div>
          </div>
        ) : (
          <div className="scroll">
            <div className="hero">
              <h1 className="hello">Hello, <span className="accent">what shall we test today?</span></h1>
              <p className="subhello">Just describe it, and consider it done.</p>
              <div className="examples">
                {[
                  'Open duckduckgo.com, search for "Replit Agent", verify a result mentions Replit',
                  'Go to news.ycombinator.com and verify the top story title is non-empty',
                  'On example.com, click "More information…" and confirm the URL changes to iana.org',
                  'Sign up on demoqa.com/automation-practice-form with placeholder data and submit',
                ].map((ex) => (
                  <button
                    key={ex}
                    className="example-chip"
                    onClick={() => !busy && planAndRun(ex)}
                    disabled={busy}
                    title="Try this scenario"
                  >
                    {ex}
                  </button>
                ))}
              </div>
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder='e.g. "Open duckduckgo.com, search for replit, verify a result mentions Replit"'
                disabled={busy}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function LiveStage({ stage, status }) {
  const x = stage?.cursor?.x ?? 0.5
  const y = stage?.cursor?.y ?? 0.5
  const label = stage?.label || (status === 'planning' ? 'planning…' : 'working…')
  const frameSrc = stage?.image || null
  return (
    <div className="stage">
      <div className="stage-bar">
        <span className="stage-dots">
          <span /><span /><span />
        </span>
        <span className="stage-label">
          <span className="stage-pulse" />
          {label}
        </span>
      </div>
      <div className="stage-frame">
        {frameSrc ? (
          <FrameImage src={frameSrc} alt="live browser stream frame" />
        ) : (
          <div className="stage-blank">
            <div className="loader" />
            <div className="stage-blank-text">{label}</div>
          </div>
        )}
        <div
          className="ai-cursor"
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M3 2 L3 18 L8 14 L11 21 L14 20 L11 13 L18 13 Z"
              fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          <span className="ai-cursor-tag">AI</span>
        </div>
      </div>
    </div>
  )
}

function FrameImage({ src, alt }) {
  const [lastGoodSrc, setLastGoodSrc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!src) return
    setLastGoodSrc(src)
    setFailed(false)
  }, [src])

  return (
    <>
      {lastGoodSrc ? (
        <img
          className="stage-img"
          src={lastGoodSrc}
          alt={alt}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="stage-blank">
          <div className="loader" />
          <div className="stage-blank-text">waiting for first frame…</div>
        </div>
      )}
      {failed && (
        <div className="stage-note">Latest frame failed to load; showing last good frame.</div>
      )}
    </>
  )
}

function StatusPill({ status }) {
  const cls = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : (status === 'running' || status === 'planning' || status === 'clarifying') ? 'run' : ''
  const label = status === 'planning' ? 'planning' : status === 'clarifying' ? 'plan mode' : status
  return (
    <span className={`pill ${cls}`}>
      <span className={`dot ${status === 'planning' || status === 'clarifying' ? 'running' : status}`} /> {label}
    </span>
  )
}

function shortUrl(u) {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname) } catch { return u }
}

function Sidebar({ tests, selectedId, onSelect, onNew, onClose, onDelete }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" />
          <span>e2e</span>
        </div>
        <button className="icon-btn close-btn" onClick={onClose} aria-label="Close menu">
          <Icon name="x" />
        </button>
      </div>

      <button className="new-task" onClick={onNew}>
        <Icon name="plus" />
        New test
      </button>

      <div className="sidebar-section">History</div>
      <div className="history">
        {tests.length === 0 ? (
          <div className="history-empty">No tests yet.</div>
        ) : (
          tests.map((t) => (
            <div
              key={t.id}
              className={`history-item ${t.id === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(t.id)}
            >
              <span className={`dot ${t.status === 'planning' || t.status === 'clarifying' ? 'running' : t.status}`} />
              <span className="name">{t.name}</span>
              <span className="meta">{t.duration != null ? `${t.duration}ms` : ''}</span>
              <button
                className="history-delete"
                aria-label="Delete task"
                title="Delete task"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete?.(t.id)
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function PromptBox({ value, onChange, onSubmit, placeholder, disabled, planMode, onPlanModeChange }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [value])
  return (
    <div className="prompt">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!disabled) onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
      />
      <div className="prompt-row">
        <div className="chip-row">
          <span className="chip"><Icon name="globe" /> Firecrawl</span>
          <span className="chip"><Icon name="bolt" /> Act planner</span>
          {onPlanModeChange && (
            <label className="chip plan-toggle" title="GLM 5.1 (max reasoning): only tool is create_plan to brief the act agent; otherwise asks in text">
              <input
                type="checkbox"
                checked={Boolean(planMode)}
                onChange={(e) => onPlanModeChange(e.target.checked)}
                disabled={disabled}
              />
              Plan mode
            </label>
          )}
        </div>
        <button className="send" onClick={onSubmit} title="Run" aria-label="Run" disabled={disabled}>
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
  )
}

function Icon({ name }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  switch (name) {
    case 'plus':       return <svg viewBox="0 0 24 24" {...common}><path d="M12 5v14M5 12h14"/></svg>
    case 'menu':       return <svg viewBox="0 0 24 24" {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    case 'x':          return <svg viewBox="0 0 24 24" {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>
    case 'arrow-up':   return <svg viewBox="0 0 24 24" {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    case 'globe':      return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></svg>
    case 'bolt':       return <svg viewBox="0 0 24 24" {...common}><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z"/></svg>
    case 'trash':      return <svg viewBox="0 0 24 24" {...common}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>
    default:           return null
  }
}
