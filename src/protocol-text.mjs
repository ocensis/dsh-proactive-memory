// The one-round-trip protocol: the memory model reports bank edits and its decision as tags.
// The parser is deliberately forgiving about prose around the tags and about casing, and
// deliberately strict about the payload: a malformed edit is dropped and reported, never guessed.

const OPS = 'update_status|save_knowledge|save_procedural|delete'
const SELF_CLOSING = new RegExp(`<memory_(${OPS})\\b([^>]*?)/>`, 'gi')
const PAIRED_SRC = `<memory_(${OPS})\\b([^>]*)>([\\s\\S]*?)</memory_(${OPS})\\s*>`
const OPENING = new RegExp(`<memory_(${OPS})\\b`, 'i') // non-global on purpose: only ever used as a test
const ID_ATTR = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/i
const NO_INTERVENTION = /<no_intervention\s*\/?>/gi
const CONTEXT_FOR_ACTION = /<context_for_action\b[^>]*>([\s\S]*?)<\/context_for_action\s*>/gi

const idOf = attrs => {
  const m = ID_ATTR.exec(attrs ?? '')
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : ''
}
/** Blank a matched span while preserving offsets, so a later pass cannot re-match it. */
const blank = (s, start, end) => s.slice(0, start) + ' '.repeat(end - start) + s.slice(end)

/**
 * @param text - the memory model's raw reply.
 * @param opts.maxEdits - cap; edits past it are dropped and reported as malformed.
 * @param opts.requireDecision - false in `mode: bankctx`, where the prompt has no PHASE 2 and a
 *   missing decision is expected rather than malformed.
 * @returns {{edits: object[], intervention: string|null, malformed: string[]}}
 */
export function parseTextReply(text, { maxEdits = 6, requireDecision = true } = {}) {
  const raw = String(text ?? '')
  const malformed = []
  const found = []

  // Self-closing first, blanking each hit, so `<memory_delete id="k1"/>` can never be swallowed
  // as the opening tag of a later paired match.
  let scan = raw
  for (const m of [...raw.matchAll(SELF_CLOSING)]) {
    found.push({ at: m.index, op: m[1].toLowerCase(), id: idOf(m[2]), content: '' })
    scan = blank(scan, m.index, m.index + m[0].length)
  }
  // The content group is non-greedy, so a MISSING close tag would otherwise pair an opening with the
  // NEXT entry's close tag and swallow that entry whole: the swallowed fact is lost and raw markup
  // lands in the bank, with nothing reported. A content span that still holds a `<memory_…>` opening
  // is therefore rejected, and the scan resumes right after the unclosed opening tag so the entry it
  // swallowed is still matched on its own. Fresh RegExp per call: exec() carries lastIndex.
  const paired = new RegExp(PAIRED_SRC, 'gi')
  for (let m = paired.exec(scan); m !== null; m = paired.exec(scan)) {
    if (OPENING.test(m[3])) {
      malformed.push(`unclosed <memory_${m[1].toLowerCase()}>`)
      paired.lastIndex = m.index + m[0].indexOf('>') + 1 // past this opening tag; strictly forward
      continue
    }
    if (m[1].toLowerCase() !== m[4].toLowerCase()) { malformed.push(`mismatched </memory_${m[4]}>`); continue }
    found.push({ at: m.index, op: m[1].toLowerCase(), id: idOf(m[2]), content: m[3] })
  }
  found.sort((a, b) => a.at - b.at)

  const edits = []
  for (const f of found) {
    const content = f.content.trim()
    if (f.op === 'update_status') {
      if (!content) { malformed.push('memory_update_status: empty'); continue }
      edits.push({ op: 'update_status', content })
    } else if (f.op === 'delete') {
      if (!f.id) { malformed.push('memory_delete: missing id'); continue }
      edits.push({ op: 'delete', id: f.id })
    } else {
      if (!f.id) { malformed.push(`memory_${f.op}: missing id`); continue }
      if (!content) { malformed.push(`memory_${f.op}[${f.id}]: empty`); continue }
      edits.push({ op: f.op, id: f.id, content })
    }
  }
  if (edits.length > maxEdits) {
    malformed.push(`over maxEditsPerCall: dropped ${edits.length - maxEdits} edit(s)`)
    edits.length = maxEdits
  }

  // Decision: the LAST of `<no_intervention/>` / `<context_for_action>` wins, so a model that
  // reasons out loud ("...otherwise <no_intervention/>") before committing still lands where it meant to.
  const notes = [...raw.matchAll(CONTEXT_FOR_ACTION)].map(m => ({ at: m.index, note: m[1].trim() }))
  const silences = [...raw.matchAll(NO_INTERVENTION)].map(m => ({ at: m.index, note: null }))
  if (notes.length > 0 && silences.length > 0) malformed.push('both <no_intervention/> and <context_for_action>')
  const last = [...notes, ...silences].sort((a, b) => a.at - b.at).at(-1)

  let intervention = null
  if (last === undefined) {
    if (requireDecision) malformed.push('no intervention decision; treated as <no_intervention/>')
  } else if (last.note !== null) {
    if (last.note) intervention = last.note
    else malformed.push('empty <context_for_action>; treated as <no_intervention/>')
  }
  return { edits, intervention, malformed }
}
