import { useEffect, useMemo, useRef, useState } from 'react'

function uid() { return 't' + Math.random().toString(36).slice(2, 8) }

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

export default function App() {
  const [tests, setTests] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const streamRef = useRef(null)

  const selected = useMemo(() => tests.find((t) => t.id === selectedId) || null, [tests, selectedId])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [selected?.log, selected?.status, selected?.screenshots?.length])

  useEffect(() => { setNavOpen(false) }, [selectedId])

  function update(id, patch) {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  async function planAndRun(prompt) {
    const id = uid()
    const draftTest = {
      id,
      name: prompt.length > 70 ? prompt.slice(0, 67) + '…' : prompt,
      prompt,
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
      log: 'Asking Kimi K2 to plan the scenario…\n',
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
      const data = await r.json()
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

    update(id, {
      status: 'running',
      name: plan.name || draftTest.name,
      url: plan.url,
      actions: plan.actions,
      expect: plan.expect,
      stepDescriptions: plan.actions.map(describeAction),
      log: `Plan from Kimi K2:\n  url: ${plan.url}\n  actions: ${plan.actions.length}\n  expectations: ${plan.expect.length}\n\nDispatching to Firecrawl…\n`,
    })

    const start = performance.now()
    try {
      const r = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      const duration = data.durationMs ?? Math.round(performance.now() - start)
      const okText = data.passed ? 'PASSED' : 'FAILED (assertion)'
      update(id, {
        status: data.passed ? 'pass' : 'fail',
        duration,
        screenshots: data.screenshots || [],
        expectations: data.expectations || [],
        finalUrl: data.finalUrl,
        title: data.title,
        log:
          `Plan from Kimi K2:\n  url: ${plan.url}\n  actions: ${plan.actions.length}\n\n` +
          `Firecrawl executed in ${duration}ms\n` +
          `Final URL: ${data.finalUrl}\n` +
          `Title: ${data.title || '(none)'}\n` +
          `Screenshots: ${(data.screenshots || []).length}\n\n` +
          (data.expectations || [])
            .map((e) => `  ${e.pass ? '✔' : '✖'} ${e.kind}: ${e.value}`)
            .join('\n') +
          `\n\n${okText}\n`,
      })
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      update(id, {
        status: 'fail',
        duration,
        error: String(err.message || err),
        log:
          `Plan from Kimi K2:\n  url: ${plan.url}\n  actions: ${plan.actions.length}\n\n` +
          `Firecrawl failed after ${duration}ms\n${err.message || err}\n`,
      })
    } finally {
      setBusy(false)
    }
  }

  async function submitDraft() {
    const v = draft.trim()
    if (!v || busy) return
    setDraft('')
    await planAndRun(v)
  }

  async function rerun() {
    if (!selected || busy) return
    await planAndRun(selected.prompt)
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
            {selected && !busy && selected.status !== 'planning' && selected.status !== 'running' && (
              <button className="btn primary" onClick={rerun}>Re-run</button>
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

              {selected.actions?.length > 0 && (
                <div className="bubble">
                  <div className="who">Plan · Kimi K2</div>
                  <div className="steps" style={{ marginTop: 8 }}>
                    {selected.actions.map((a, i) => (
                      <div className="step" key={i}>
                        <span className={`dot ${selected.status === 'running' ? 'running' : selected.status === 'pass' ? 'pass' : selected.status === 'fail' ? 'fail' : 'pending'}`} />
                        <span className="label">{describeAction(a)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.expectations?.length > 0 && (
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

              {selected.screenshots?.length > 0 && (
                <div className="bubble">
                  <div className="who">Screenshots · Firecrawl</div>
                  <div className="shots">
                    {selected.screenshots.map((src, i) => (
                      <a key={i} href={src} target="_blank" rel="noreferrer" className="shot">
                        <img src={src} alt={`Screenshot ${i + 1}`} loading="lazy" />
                      </a>
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

              {selected.log && (
                <div className="bubble">
                  <div className="who">Console</div>
                  <pre className="log" style={{ marginTop: 8 }}>{selected.log}</pre>
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
                <div className="k">Planner</div><div className="v">Kimi K2 · Fireworks</div>
                <div className="k">Browser</div><div className="v">Firecrawl /scrape</div>
              </div>
            </aside>

            <div className="dock">
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder="Describe another test scenario…"
                disabled={busy}
              />
            </div>
          </div>
        ) : (
          <div className="scroll">
            <div className="hero">
              <h1 className="hello">Hello, <span className="accent">what shall we test today?</span></h1>
              <p className="subhello">Describe a user scenario in plain English. Kimi K2 plans it, Firecrawl runs it in a real browser.</p>
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder='e.g. "Open duckduckgo.com, search for replit, verify a result mentions Replit"'
                disabled={busy}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function StatusPill({ status }) {
  const cls = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : (status === 'running' || status === 'planning') ? 'run' : ''
  const label = status === 'planning' ? 'planning' : status
  return (
    <span className={`pill ${cls}`}>
      <span className={`dot ${status === 'planning' ? 'running' : status}`} /> {label}
    </span>
  )
}

function shortUrl(u) {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname) } catch { return u }
}

function Sidebar({ tests, selectedId, onSelect, onNew, onClose }) {
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
              <span className={`dot ${t.status === 'planning' ? 'running' : t.status}`} />
              <span className="name">{t.name}</span>
              <span className="meta">{t.duration != null ? `${t.duration}ms` : ''}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function PromptBox({ value, onChange, onSubmit, placeholder, disabled }) {
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
          <span className="chip"><Icon name="bolt" /> Kimi K2</span>
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
    default:           return null
  }
}
