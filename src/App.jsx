import { useEffect, useMemo, useRef, useState } from 'react'

const SEED_TESTS = [
  {
    id: 't1',
    name: 'Login flow — happy path',
    tags: ['auth', 'smoke'],
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

function uid() {
  return 't' + Math.random().toString(36).slice(2, 8)
}

export default function App() {
  const [tests, setTests] = useState(() =>
    SEED_TESTS.map((t) => ({ ...t, status: 'pending', duration: null, log: '', stepStatuses: [] }))
  )
  const [selectedId, setSelectedId] = useState(SEED_TESTS[0].id)
  const [running, setRunning] = useState(false)
  const cancelRef = useRef(false)

  const selected = useMemo(() => tests.find((t) => t.id === selectedId), [tests, selectedId])

  const counts = useMemo(() => {
    const c = { total: tests.length, pass: 0, fail: 0, running: 0, pending: 0 }
    for (const t of tests) c[t.status] = (c[t.status] || 0) + 1
    return c
  }, [tests])

  function updateTest(id, patch) {
    setTests((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
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

      // Simulate step time + outcome
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 350))
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

  async function runAll() {
    if (running) return
    setRunning(true)
    cancelRef.current = false
    for (const t of tests) {
      if (cancelRef.current) break
      // re-read latest state by id
      const fresh = { ...t, status: 'pending', stepStatuses: [], log: '' }
      updateTest(t.id, fresh)
      await runTest(fresh)
    }
    setRunning(false)
  }

  async function runOne() {
    if (!selected || running) return
    setRunning(true)
    cancelRef.current = false
    await runTest({ ...selected })
    setRunning(false)
  }

  function cancel() {
    cancelRef.current = true
  }

  function resetAll() {
    setTests((prev) => prev.map((t) => ({ ...t, status: 'pending', duration: null, log: '', stepStatuses: [] })))
  }

  function addTest(name) {
    const n = name.trim()
    if (!n) return
    setTests((prev) => [
      ...prev,
      {
        id: uid(),
        name: n,
        tags: ['custom'],
        status: 'pending',
        duration: null,
        log: '',
        stepStatuses: [],
        steps: ['visit /', 'expect document.title to exist'],
      },
    ])
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <h1>E2E Tester</h1>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>scaffold</span>
        </div>
        <div className="actions">
          <button className="btn" onClick={resetAll} disabled={running}>Reset</button>
          {running ? (
            <button className="btn danger" onClick={cancel}>Cancel</button>
          ) : (
            <>
              <button className="btn" onClick={runOne} disabled={!selected}>Run selected</button>
              <button className="btn primary" onClick={runAll}>Run all</button>
            </>
          )}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="section-title">
            <span>Tests</span>
            <span>{counts.total}</span>
          </div>
          <div className="test-list">
            {tests.map((t) => (
              <div
                key={t.id}
                className={`test-item ${t.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className={`status-pill ${t.status}`} />
                <div className="name">
                  <div>{t.name}</div>
                  <div className="meta">{t.tags.join(' · ')}</div>
                </div>
                <span className="meta">{t.duration != null ? `${t.duration}ms` : ''}</span>
              </div>
            ))}
          </div>
          <AddTestRow onAdd={addTest} />
        </aside>

        <main className="main">
          <div className="summary">
            <div className="stat"><div className="label">Total</div><div className="value">{counts.total}</div></div>
            <div className="stat pass"><div className="label">Passed</div><div className="value">{counts.pass || 0}</div></div>
            <div className="stat fail"><div className="label">Failed</div><div className="value">{counts.fail || 0}</div></div>
            <div className="stat run"><div className="label">Running</div><div className="value">{counts.running || 0}</div></div>
          </div>

          <div className="runner">
            {!selected ? (
              <div className="empty">Select a test on the left</div>
            ) : (
              <>
                <h2>Steps — {selected.name}</h2>
                <div className="steps">
                  {selected.steps.map((s, i) => {
                    const st = selected.stepStatuses[i] || 'pending'
                    return (
                      <div className="step" key={i}>
                        <span className={`status-pill ${st}`} />
                        <span className="label">{s}</span>
                        <span className="duration">{st}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </main>

        <aside className="details">
          <div className="section-title"><span>Details</span></div>
          <div className="details-body">
            {!selected ? (
              <div className="empty">No test selected</div>
            ) : (
              <>
                <div className="kv">
                  <div className="k">ID</div><div>{selected.id}</div>
                  <div className="k">Status</div><div>{selected.status}</div>
                  <div className="k">Duration</div><div>{selected.duration != null ? `${selected.duration}ms` : '—'}</div>
                  <div className="k">Steps</div><div>{selected.steps.length}</div>
                  <div className="k">Tags</div><div>{selected.tags.join(', ')}</div>
                </div>
                <div className="log">{selected.log || '(no output yet)'}</div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}

function AddTestRow({ onAdd }) {
  const [v, setV] = useState('')
  return (
    <div className="add-row">
      <input
        className="input"
        placeholder="New test name…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onAdd(v); setV('') }
        }}
      />
      <button className="btn" onClick={() => { onAdd(v); setV('') }}>Add</button>
    </div>
  )
}
