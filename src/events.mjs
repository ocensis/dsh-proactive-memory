// One event channel out of the plugin: ctx.emit('proactive-memory/event', e).
// A host collects it however it likes (the tau2 harness has a ~25-line sink that forwards it into
// its per-session mailbox). We never session.append() — see rule R2 in the README.

const KINDS = new Set(['consult', 'inject', 'skip', 'error'])

function line(e) {
  const at = `[proactive-memory:${e.mode ?? '?'}] t${e.turn ?? '?'}/s${e.step ?? '?'}`
  if (e.kind === 'inject') return `${at} INJECT ${e.chars}c: ${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`
  if (e.kind === 'consult') return e.decision === 'intervene' ? '' : `${at} NO_INTERVENTION`
  if (e.kind === 'skip') return `${at} SKIP ${e.why}`
  if (e.kind === 'error') return `${at} ERROR ${e.message}`
  return ''
}

/**
 * Emit one event and (optionally) log its one-line form.
 * @param opts.mode - the arm, stamped on every line even when the event body has none.
 */
export function emit(ctx, kind, fields, { console: useConsole = true, mode } = {}) {
  const event = { kind, mode, ts: Date.now(), ...fields }
  if (!KINDS.has(kind)) event.kind = 'error'
  try {
    ctx?.emit?.('proactive-memory/event', event)
  } catch {
    // A listener that throws is the host's problem; it must never break a turn.
  }
  if (useConsole) {
    const text = line({ ...event, mode: event.mode ?? mode })
    if (text) console.log(text)
  }
  return event
}
