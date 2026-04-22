import { useEffect, useMemo, useRef, useState } from 'react'

const SEED_TESTS = [
  {
    id: 't1',
    name: 'Login flow — happy path',
    tags: ['auth', 'smoke'],
    prompt: 'Verify a user can log in with valid credentials and reach /dashboard.',
    steps: [
      'visit /login',
      'fill #email "user@example.com"',
      'fill #password "••••••••"',
      'click button[type=submit]',
      'expect url to include /dashboard',
    ],
  },
  {
    id: 't2',
    name: 'Checkout — single item',
    tags: ['checkout'],
    prompt: 'Add one product to the cart and complete checkout end-to-end.',
    steps: [
      'visit /shop',
      'click .product[data-id="42"] button.add',
      'click #cart-icon',
      'click button#checkout',
      'expect text "Order confirmed"',
    ],
  },
  {
    id: 't3',
    name: 'Search returns results',
    tags: ['search', 'smoke'],
    prompt: 'Type a query into the search bar and assert at least one result.',
    steps: [
      'visit /',
      'fill input[name=q] "shoes"',
      'press Enter',
      'expect .results .item to have count >= 1',
    ],
  },
  {
    id: 't4',
    name: 'Profile update persists',
    tags: ['profile'],
    prompt: 'Edit the display name on /profile and confirm it survives reload.',
    steps: [
      'login as "user@example.com"',
      'visit /profile',
      'fill #name "Jane Doe"',
      'click button#save',
      'reload',
      'expect #name to have value "Jane Doe"',
    ],
  },
]

const SUGGESTIONS = [
  {
    icon: 'login',
    title: 'Test a login flow',
    desc: 'Form submit, redirect & session check',
    prompt: 'Test the login flow end-to-end and verify the user lands on /dashboard.',
  },
  {
    icon: 'cart',
    title: 'Validate a checkout',
    desc: 'Add to cart through payment confirmation',
    prompt: 'Walk through adding an item to the cart and completing checkout.',
  },
  {
    icon: 'search',
    title: 'Smoke-test search',
    desc: 'Query, results, empty state',
    prompt: 'Run a smoke test on the search page with the query "shoes".',
  },
  {
    icon: 'shield',
    title: 'Auth + permissions',
    desc: 'Protected routes & role gating',
    prompt: 'Verify that protected routes redirect unauthenticated users to /login.',
  },
]

function uid() { return 't' + Math.random().toString(36).slice(2, 8) }

export default function App() {
  const [tests, setTests] = useState(() =>
    SEED_TESTS.map((t) => ({ ...t, status: 'pending', duration: null, log: '', stepStatuses: [] }))
  )
  const [selectedId, setSelectedId] = useState(null)
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState('')
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

  function updateTest(id, patch) {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  function stepsFromPrompt(p) {
    const lower = p.toLowerCase()
    const steps = ['visit /']
    if (lower.includes('login')) steps.push('fill #email "user@example.com"', 'fill #password "••••••••"', 'click button[type=submit]', 'expect url to include /dashboard')
    else if (lower.includes('search')) steps.push('fill input[name=q] "shoes"', 'press Enter', 'expect .results .item to have count >= 1')
    else if (lower.includes('checkout') || lower.includes('cart')) steps.push('click .product button.add', 'click #cart-icon', 'click button#checkout', 'expect text "Order confirmed"')
    else if (lower.includes('protected') || lower.includes('auth')) steps.push('visit /admin', 'expect url to include /login')
    else steps.push('expect document.title to exist', 'expect status to be 200')
    return steps
  }

  function createFromPrompt(prompt) {
    const p = prompt.trim()
    if (!p) return null
    const name = p.length > 70 ? p.slice(0, 67) + '…' : p
    const test = {
      id: uid(),
      name,
      tags: ['draft'],
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
    if (!t) return
    if (running) return
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
    if (running) return
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
    <div className="app">
      <Sidebar
        tests={tests}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={newTask}
      />

      <section className="main">
        <header className="topbar">
          <div className="crumb">
            {selected ? (<><span>Tests</span> · <b>{selected.name}</b></>) : (<>E2E Tester</>)}
          </div>
          <div className="top-actions">
            {running ? (
              <button className="btn danger" onClick={cancel}>Stop</button>
            ) : selected ? (
              <>
                <button className="btn ghost" onClick={runAll}>Run all</button>
                <button className="btn primary" onClick={runSelected}>Run test</button>
              </>
            ) : (
              <button className="btn ghost" onClick={runAll}>Run all ({counts.total})</button>
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
                {selected.tags.map((t) => <span className="pill" key={t}>#{t}</span>)}
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
                <div className="k">Tags</div><div className="v">{selected.tags.join(', ')}</div>
              </div>

              <div className="aside-h">Suite</div>
              <div className="summary-pills">
                <span className="pill"><span className="num">{counts.total}</span> total</span>
                <span className="pill pass"><span className="num">{counts.pass || 0}</span> passed</span>
                <span className="pill fail"><span className="num">{counts.fail || 0}</span> failed</span>
                <span className="pill run"><span className="num">{counts.running || 0}</span> running</span>
              </div>

              <div className="aside-h">Tips</div>
              <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                Describe a scenario in natural language in the prompt to spin up a new test.
              </div>
            </aside>

            <div className="dock">
              <PromptBox
                value={draft}
                onChange={setDraft}
                onSubmit={submitDraft}
                placeholder="Describe another test scenario…"
                small
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

              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    className="sugg"
                    onClick={() => { setDraft(s.prompt) }}
                  >
                    <div className="ico"><Icon name={s.icon} /></div>
                    <div className="t">{s.title}</div>
                    <div className="d">{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Sidebar({ tests, selectedId, onSelect, onNew }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark" />
          <span>e2e</span>
        </div>
        <button className="icon-btn" title="Search">
          <Icon name="search" />
        </button>
      </div>

      <button className="new-task" onClick={onNew}>
        <Icon name="plus" />
        New test
      </button>

      <div className="sidebar-section">History</div>
      <div className="history">
        {tests.map((t) => (
          <div
            key={t.id}
            className={`history-item ${t.id === selectedId ? 'active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <span className={`dot ${t.status}`} />
            <span className="name">{t.name}</span>
            <span className="meta">{t.duration != null ? `${t.duration}ms` : ''}</span>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <span className="avatar">QA</span>
        <span>QA Engineer</span>
      </div>
    </aside>
  )
}

function PromptBox({ value, onChange, onSubmit, placeholder, small }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [value])
  return (
    <div className="prompt" style={small ? { boxShadow: '0 -4px 24px -10px rgba(20,16,8,0.18), 0 1px 2px rgba(20,16,8,0.04)' } : undefined}>
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
      />
      <div className="prompt-row">
        <div className="chip-row">
          <span className="chip"><Icon name="globe" /> Browser</span>
          <span className="chip"><Icon name="bolt" /> Headless</span>
          <span className="chip"><Icon name="clock" /> 30s timeout</span>
        </div>
        <button className="send" onClick={onSubmit} title="Run">
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
    case 'search':
      return <svg viewBox="0 0 24 24" {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    case 'arrow-up':
      return <svg viewBox="0 0 24 24" {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    case 'globe':
      return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"/></svg>
    case 'bolt':
      return <svg viewBox="0 0 24 24" {...common}><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z"/></svg>
    case 'clock':
      return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    case 'login':
      return <svg viewBox="0 0 24 24" {...common}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>
    case 'cart':
      return <svg viewBox="0 0 24 24" {...common}><path d="M3 3h2l2.4 12.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>
    case 'shield':
      return <svg viewBox="0 0 24 24" {...common}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z"/></svg>
    default:
      return null
  }
}
