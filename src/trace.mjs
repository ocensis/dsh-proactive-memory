// Optional per-session JSONL trace of every consult: the exact system prompt, the exact user
// message, the raw reply. Reading these one by one is how the prompt gets tuned; the plugin's
// behavior must not depend on it, so every failure here is swallowed.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const safe = s => String(s ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)

// Callers fire and forget, so chain the writes per file: a trace read out of step order is worse
// than useless. The chain never rejects, so one bad write cannot poison the next.
const queues = new Map()

/** Append one JSON line to <dir>/<sessionId>.jsonl. No-op when dir is empty. */
export function appendTrace(dir, sessionId, record) {
  if (!dir) return Promise.resolve()
  const path = join(dir, `${safe(sessionId)}.jsonl`)
  const next = (queues.get(path) ?? Promise.resolve()).then(async () => {
    try {
      await mkdir(dir, { recursive: true })
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // Tracing is diagnostics; a full disk or a bad path must not cost a turn.
    }
  })
  queues.set(path, next)
  // Drop the chain once it drains, so a long-lived process does not accumulate one entry per episode.
  next.finally(() => { if (queues.get(path) === next) queues.delete(path) })
  return next
}
