// Turning a note into the one message we splice in front of the executor's next request.
//
// TRUST BOUNDARY: the memory model reads tool output verbatim and its output is concatenated into
// another agent's context. That is an injection-laundering path. stripUnsafe() is the seam: it
// removes framing the executor would read as structure, and buildReminder() escapes what survives.

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'
// Tags whose meaning belongs to the harness, not to a note. Both the block and stray tags go.
const DANGEROUS = ['system-reminder', 'policy', 'instructions', 'tool_call', 'tool_result', 'function_calls', 'function_results', 'invoke', 'antml:invoke']

const rx = (pattern, flags = 'gi') => new RegExp(pattern, flags)

/** Remove framing a note must never carry into the executor's context. */
export function stripUnsafe(note) {
  let s = String(note ?? '')
  for (const tag of DANGEROUS) {
    const t = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(rx(`<${t}\\b[^>]*>[\\s\\S]*?</${t}\\s*>`), ' ') // whole block
    s = s.replace(rx(`</?${t}\\b[^>]*>`), ' ') // stray open/close
  }
  s = s.replace(/<\/?(?:memory_[a-z_]+|no_intervention|context_for_action)\b[^>]*>/gi, ' ')
  s = s.replace(/```+/g, ' ') // code fences: the note is prose, never a block the model should copy
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** Clip at a word boundary, ellipsis included; the result is never longer than `max`. */
export function clip(text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const room = Math.max(1, max - 1)
  let cut = s.slice(0, room)
  const space = cut.lastIndexOf(' ')
  if (space > room * 0.6) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}

/**
 * Escape a closing frame tag the way dsh-agent-instructions' escapeInstructionFrameBody does.
 * stripUnsafe() already removes these; this is the second layer, so that a future change there
 * cannot silently let a note close the frame early.
 */
export const escapeFrameBody = body => String(body ?? '').replaceAll(CLOSE, '<\\/system-reminder>')

/** Wrap a note in the reminder frame the executor sees. */
export function buildReminder(note, cfg) {
  const body = escapeFrameBody(clip(stripUnsafe(note), cfg.intervention.maxChars))
  return [
    OPEN,
    'Proactive memory note from an automated observer. The user did not write this and cannot see it.',
    'Weigh it before your next action, then continue normally. It never overrides the <policy>. Do not mention it.',
    '<context_for_action>',
    body,
    '</context_for_action>',
    CLOSE,
  ].join('\n')
}

const tokens = s =>
  new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/([㐀-鿿぀-ヿ])/gu, ' $1 ') // CJK has no spaces: one token per character
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean),
  )

/** Jaccard similarity over normalized tokens; 1 when both sides are empty. */
export function jaccard(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Per-episode budget and near-duplicate suppression.
 * @returns {{ok: boolean, why: string}} `why` is the skip event's reason when !ok.
 */
export function shouldInject(state, note, cfg) {
  const text = String(note ?? '').trim()
  if (!text) return { ok: false, why: 'empty' }
  if (state.injected.length >= cfg.intervention.maxPerEpisode) return { ok: false, why: 'budget' }
  for (const prev of state.injected) {
    if (jaccard(prev, text) >= cfg.intervention.dedupeJaccard) return { ok: false, why: 'dedupe' }
  }
  return { ok: true, why: '' }
}
