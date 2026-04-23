import pg from 'pg'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.warn('[warn] DATABASE_URL not set — task persistence disabled')
}

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null

export const dbReady = Boolean(pool)

function rowToTask(row) {
  if (!row) return null
  const data = row.data || {}
  return {
    ...data,
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listTasks() {
  if (!pool) return []
  const { rows } = await pool.query(
    'SELECT id, name, prompt, status, data, created_at, updated_at FROM tasks ORDER BY created_at DESC'
  )
  return rows.map(rowToTask)
}

export async function getTask(id) {
  if (!pool) return null
  const { rows } = await pool.query(
    'SELECT id, name, prompt, status, data, created_at, updated_at FROM tasks WHERE id = $1',
    [id]
  )
  return rowToTask(rows[0])
}

export async function upsertTask(task) {
  if (!pool) return null
  if (!task || !task.id) throw new Error('task.id required')
  const { id, name, prompt, status, createdAt, updatedAt, ...rest } = task
  const { rows } = await pool.query(
    `INSERT INTO tasks (id, name, prompt, status, data, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           prompt = EXCLUDED.prompt,
           status = EXCLUDED.status,
           data = EXCLUDED.data,
           updated_at = NOW()
     RETURNING id, name, prompt, status, data, created_at, updated_at`,
    [id, name || '', prompt || null, status || null, JSON.stringify(rest)]
  )
  return rowToTask(rows[0])
}

export async function deleteTask(id) {
  if (!pool) return false
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id])
  return rowCount > 0
}
