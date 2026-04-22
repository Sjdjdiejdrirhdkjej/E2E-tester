import { useEffect, useMemo, useRef, useState } from 'react'

function uid() { return 't' + Math.random().toString(36).slice(2, 8) }

function stepsFromPrompt(p) {
  const lower = p.toLowerCase()
  const steps = ['visit /']
  if (lower.includes('login') || lower.includes('sign in')) steps.push('fill #email', 'fill #password', 'click button[type=submit]', 'expect url to include /dashboard')
  else if (lower.includes('search')) steps.push('fill input[name=q]', 'press Enter', 'expect .results .item to have count >= 1')
  else if (lower.includes('checkout') || lower.includes('cart')) steps.push('click .product button.add', 'click #cart-icon', 'click button#checkout', 'expect text "Order confirmed"')
  else if (lower.includes('protected') || lower.includes('auth')) steps.push('visit /admin', 'expect url to include /login')
  else if (lower.includes('sign up') || lower.includes('register')) steps.push('visit /signup', 'fill #email', 'fill #password', 'click button[type=submit]', 'expect text "Welcome"')
  else steps.push('expect document.title to exist', 'expect status to be 200')
  return steps
}

export default function App() {
  const [tests, setTests] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const cancelRef = useRef(false)
  const streamRef = useRef(null)

  const selected = useMemo(() => tests.find((t) => t.id === selectedId) || null, [tests, selectedId])

  const counts = useMemo(() => {
    const c = { total: tests.length, pass: 0, fail: 0, running: 0, pending: 0 }
    for (const t of tests) c[t.status] = (c[t.status] || 0) + 1
    return c
  }, [tests])

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [selected?.log, selected?.stepStatuses])

  useEffect(() => {
    setNavOpen(false)
  }, [selectedId])

  function updateTest(id, patch) {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  function createFromPrompt(prompt) {
    const p = prompt.trim()
    if (!p) return null
    const name = p.length > 70 ? p.slice(0, 67) + '…' : p
    const test = {
      id: uid(),
      name,
      prompt: p,
      status: 'pending',
      duration: null,
      log: '',
      stepStatuses: [],
      steps: stepsFromPrompt(p),
    }
    setTests((prev) => [test, ...prev])
    setSelectedId(test.id)
    return test
  }

  async function runTest(test) {
    updateTest(test.id, {
      status: 'running',
      duration: null,
      log: `▶ Starting "${test.name}"\n`,
      stepStatuses: test.steps.map(() => 'pending'),
    })
    const start = performance.now()
    const stepStatuses = test.steps.map(() => 'pending')
    let log = `▶ Starting "${test.name}"\n`

    for (let i = 0; i < test.steps.length; i++) {
      if (cancelRef.current) {
        log += `■ Cancelled at step ${i + 1}\n`
        updateTest(test.id, { status: 'fail', log, stepStatuses, duration: Math.round(performance.now() - start) })
        return 'fail'
      }
      stepStatuses[i] = 'running'
      log += `  → ${test.steps[i]}\n`
      updateTest(test.id, { log, stepStatuses: [...stepStatuses] })
      await new Promise((r) => setTimeout(r, 280 + Math.random() * 360))
      const failed = Math.random() < 0.06
      stepStatuses[i] = failed ? 'fail' : 'pass'
      log += failed ? `    ✖ assertion failed\n` : `    ✔ ok\n`
      updateTest(test.id, { log, stepStatuses: [...stepStatuses] })
      if (failed) {
        const dur = Math.round(performance.now() - start)
        log += `\nFAILED in ${dur}ms\n`
        updateTest(test.id, { status: 'fail', log, duration: dur })
        return 'fail'
      }
    }
    const dur = Math.round(performance.now() - start)
    log += `\nPASSED in ${dur}ms\n`
    updateTest(test.id, { status: 'pass', log, duration: dur })
    return 'pass'
  }

  async function submitDraft() {
    const t = createFromPrompt(draft)
    setDraft('')
    if (!t || running) return
    setRunning(true)
    cancelRef.current = false
    await runTest(t)
    setRunning(false)
  }

  async function runSelected() {
    if (!selected || running) return
    setRunning(true)
    cancelRef.current = false
    await runTest({ ...selected })
    setRunning(false)
  }

  async function runAll() {
    if (running || tests.length === 0) return
    setRunning(true)
    cancelRef.current = false
    const ids = tests.map((t) => t.id)
    for (const id of ids) {
      if (cancelRef.current) break
      const fresh = tests.find((t) => t.id === id)
      if (!fresh) continue
      const reset = { ...fresh, status: 'pending', stepStatuses: [], log: '' }
      updateTest(id, reset)
      await runTest(reset)
    }
    setRunning(false)
  }

  function cancel() { cancelRef.current = true }
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
            {running ? (
              <button className="btn danger" onClick={cancel}>Stop</button>
            ) : selected ? (
              <button className="btn primary" onClick={runSelected}>Run</button>
            ) : (
              <button className="btn ghost" onClick={runAll} disabled={tests.length === 0}>
                Run all{tests.length ? ` (${counts.total})` : ''}
              </button>
            )}
          </div>
        </header>

        {selected ? (
          <div className="run">
            <div className="run-stream" ref={streamRef}>
              <h1 className="run-title">{selected.name}</h1>
              <div className="run-sub">{selected.prompt}</div>

              <div className="summary-pills">
                <span className={`pill ${selected.status === 'pass' ? 'pass' : selected.status === 'fail' ? 'fail' : selected.status === 'running' ? 'run' : ''}`}>
                  <span className={`dot ${selected.status}`} /> {selected.status}
                </span>
                <span className="pill"><span className="num">{selected.steps.length}</span>&nbsp;steps</span>
                {selected.duration != null && (
                  <span className="pill"><span className="num">{selected.duration}</span>&nbsp;ms</span>
                )}
              </div>

              <div className="bubble">
                <div className="who">Plan</div>
                <div className="body">
                  I'll execute {selected.steps.length} steps to verify this scenario, then report a verdict.
                </div>
              </div>

              <div className="bubble">
                <div className="who">Steps</div>
                <div className="steps" style={{ marginTop: 8 }}>
                  {selected.steps.map((s, i) => {
                    const st = selected.stepStatuses[i] || 'pending'
                    return (
                      <div className="step" key={i}>
                        <span className={`dot ${st}`} />
                        <span className="label">{s}</span>
                        <span className="tag">{st}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

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
                <div className="k">ID</div><div className="v">{selected.id}</div>
                <div className="k">Status</div><div className="v">{selected.status}</div>
                <div className="k">Steps</div><div className="v">{selected.steps.length}</div>
                <div className="k">Duration</div><div className="v">{selected.duration != null ? `${selected.duration} ms` : '—'}</div>
              </div>

              <div className="aside-h">Suite</div>
              <div className="summary-pills">
                <span className="pill"><span className="num">{counts.total}</span> total</span>
                <span className="pill pass"><span className="num">{counts.pass || 0}</span> passed</span>
                <span className="pill fail"><span className="num">{counts.fail || 0}</span> failed</span>
                <span className="pill run"><span className="num">{counts.running || 0}</span> running</span>
              </div>
            </aside>

            <div className="dock">
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder="Describe another test scenario…"
              />
            </div>
          </div>
        ) : (
          <div className="scroll">
            <div className="hero">
              <h1 className="hello">Hello, <span className="accent">what shall we test today?</span></h1>
              <p className="subhello">Describe a user scenario in plain English and I'll plan & run it.</p>

              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder='e.g. "Sign up with a new email and verify a welcome screen appears"'
              />
            </div>
          </div>
        )}
      </section>
    </div>
  )
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
              <span className={`dot ${t.status}`} />
              <span className="name">{t.name}</span>
              <span className="meta">{t.duration != null ? `${t.duration}ms` : ''}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function PromptBox({ value, onChange, onSubmit, placeholder }) {
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
            onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={1}
      />
      <div className="prompt-row">
        <div className="chip-row">
          <span className="chip"><Icon name="globe" /> Browser</span>
          <span className="chip"><Icon name="bolt" /> Headless</span>
        </div>
        <button className="send" onClick={onSubmit} title="Run" aria-label="Run">
          <Icon name="arrow-up" />
        </button>
      </div>
    </div>
  )
}

function Icon({ name }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  switch (name) {
    case 'plus':
      return <svg viewBox="0 0 24 24" {...common}><path d="M12 5v14M5 12h14"/></svg>
    case 'menu':
      return <svg viewBox="0 0 24 24" {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    case 'x':
      return <svg viewBox="0 0 24 24" {...common}><path d="M6 6l12 12M18 6 6 18"/></svg>
    case 'arrow-up':
      return <svg viewBox="0 0 24 24" {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    case 'globe':
      return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></svg>
    case 'bolt':
      return <svg viewBox="0 0 24 24" {...common}><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z"/></svg>
    default:
      return null
  }
}
