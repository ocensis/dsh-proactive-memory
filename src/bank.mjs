// The memory model's private bank: {status, knowledge[], procedural[]}.
// The executor agent never sees it (except in `mode: bankctx`, which injects renderBank()).
// One bank per episode; isolation is the caller's Map keyed by String(agent.id) — never module state.

/** A fresh, empty bank. */
export function createBank() {
  return { status: '', knowledge: [], procedural: [] }
}

const LISTS = { save_knowledge: ['knowledge', 'maxKnowledge'], save_procedural: ['procedural', 'maxProcedural'] }

function upsert(list, id, content, cap) {
  const at = list.findIndex(e => e.id === id)
  if (at >= 0) list[at] = { id, content } // a reused id overwrites in place, keeping its age
  else list.push({ id, content })
  const dropped = []
  while (list.length > cap) dropped.push(list.shift()) // over the cap: drop the oldest
  return dropped
}

/**
 * Apply parsed edits to a bank in place.
 * @returns {{applied: number, rejected: string[]}} how many landed and why the rest did not.
 */
export function applyEdits(bank, edits, limits) {
  const rejected = []
  let applied = 0
  for (const edit of edits ?? []) {
    const op = edit?.op
    const content = typeof edit?.content === 'string' ? edit.content.trim() : ''
    const id = typeof edit?.id === 'string' ? edit.id.trim() : ''
    if (op === 'update_status') {
      if (!content) { rejected.push('update_status: empty'); continue }
      bank.status = content
      applied++
    } else if (op === 'save_knowledge' || op === 'save_procedural') {
      const [key, capKey] = LISTS[op]
      if (!id) { rejected.push(`${op}: missing id`); continue }
      if (!content) { rejected.push(`${op}[${id}]: empty`); continue }
      const cap = limits?.[capKey] ?? 12
      if (cap <= 0) { rejected.push(`${op}: ${capKey} is 0`); continue }
      for (const d of upsert(bank[key], id, content, cap)) rejected.push(`${op}: dropped oldest [${d.id}]`)
      applied++
    } else if (op === 'delete') {
      if (!id) { rejected.push('delete: missing id'); continue }
      const before = bank.knowledge.length + bank.procedural.length
      bank.knowledge = bank.knowledge.filter(e => e.id !== id)
      bank.procedural = bank.procedural.filter(e => e.id !== id)
      if (bank.knowledge.length + bank.procedural.length === before) rejected.push(`delete[${id}]: not found`)
      else applied++
    } else {
      rejected.push(`unknown op ${JSON.stringify(op)}`)
    }
  }
  return { applied, rejected }
}

/**
 * Deterministic plain-text rendering. Returns '' for a completely empty bank so that
 * `mode: bankctx` has nothing to inject before the model has learned anything.
 *
 * Order is rules → facts → status, most actionable first. `mode: bankctx` injects this whole
 * render and it is clipped to fit (`bankctx.maxChars`): with status first, a bank that outgrew the
 * budget lost exactly the rules, which are the part the executor could have acted on.
 *
 * @param opts.ids - keep the `[k1]` prefixes (the memory model needs them to overwrite/delete;
 *   the executor agent does not).
 */
export function renderBank(bank, { ids = true } = {}) {
  if (!bank) return ''
  const k = bank.knowledge ?? []
  const p = bank.procedural ?? []
  if (!bank.status && k.length === 0 && p.length === 0) return ''
  const line = e => `- ${ids ? `[${e.id}] ` : ''}${e.content}`
  const section = (label, list) => (list.length === 0 ? `${label}: (none)` : `${label}:\n${list.map(line).join('\n')}`)
  return [
    section('Rules to follow', p),
    section('Known facts', k),
    `Status: ${bank.status || '(none)'}`,
  ].join('\n')
}
