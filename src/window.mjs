// Build what the memory model gets to look at: the task, the tail of the transcript as JSON,
// and the notes we already told the executor agent.
//
// The transcript is JSON-framed on purpose: transcript text (tool output, user text) can contain
// anything, and JSON is a delimiter it cannot break out of. Everything in there is DATA.

export const PLUGIN = 'proactive-memory'

/**
 * The note a truncated **tool result** carries inside its marker — and nothing else does.
 *
 * A bare `[N chars cut]` says that something was removed; it does not say that what was removed may
 * be exactly the row being looked for. The pilot measured the difference: 8 of 33 notes claimed that
 * an id was ABSENT from a tool result, and several of those results had simply been cut through the
 * middle of the list the claim was about (a retail `get_product_details` runs to ~3.4k chars, and the
 * budget was 800). Absence is the one thing a middle-truncated result can never show.
 */
export const TOOL_RESULT_CUT_NOTE = 'result truncated, do not infer absence'

/**
 * Middle-truncate, marking how much was removed. `note`, when given, is spelled out inside that
 * marker; pass TOOL_RESULT_CUT_NOTE for a tool result, and nothing for arguments and one-line
 * summaries, where the extra words would eat most of a small budget.
 */
export function middleTruncate(s, max, note = '') {
  const text = String(s ?? '')
  if (text.length <= max) return text
  const head = Math.max(1, Math.floor(max / 2))
  const tail = Math.max(1, max - head)
  const marker = `…[${text.length - max} chars cut${note ? ` — ${note}` : ''}]…`
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

/** `<key_tool_calls>` budgets. Fixed, not configurable: one short line per call is the whole point. */
export const KEY_TOOL_ARG_CHARS = 300
export const KEY_TOOL_RESULT_CHARS = 600

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * One `<key_tool_calls>` line: `name(args) -> result` and `[error]` when the call failed.
 *
 * These are recorded from `tools/result` and replayed for the whole episode, so the memory model
 * still sees that a lookup returned an id long after that exchange scrolled out of the transcript
 * window — the gap that had it demanding authentication the agent had already done.
 */
export function formatKeyToolCall({ name, args, result, isError }, { resultChars = KEY_TOOL_RESULT_CHARS } = {}) {
  const argText = middleTruncate(oneLine(typeof args === 'string' ? args : JSON.stringify(args ?? {})), KEY_TOOL_ARG_CHARS)
  // A lookup that returns a whole customer record (banking: ~250-480 chars) must survive uncut, or the
  // memory model cannot tell which of the record's fields the user actually got right.
  const resultText = middleTruncate(oneLine(result), resultChars) || '(no text)'
  return `${name}(${argText}) -> ${resultText}${isError ? ' [error]' : ''}`
}

const blocks = m => (Array.isArray(m?.content) ? m.content : [])
const textOf = m => blocks(m).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n').trim()

/** Text of a tool-result block's nested content. */
function resultText(block) {
  const inner = Array.isArray(block?.content) ? block.content : []
  return inner.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n').trim()
}

function serialize(m, cfg) {
  const calls = blocks(m).filter(b => b?.type === 'tool-call')
  const result = blocks(m).find(b => b?.type === 'tool-result')
  const out = {}
  if (m.role === 'assistant') out.role = 'assistant'
  else out.role = result ? 'tool' : 'user'
  const text = textOf(m)
  if (text) out.text = middleTruncate(text, cfg.window.toolResultChars)
  if (calls.length > 0) {
    out.tool_calls = calls.map(c => ({ name: c.name, arguments: middleTruncate(c.arguments ?? '', cfg.window.argChars) }))
  }
  if (result) {
    out.tool_result = {
      text: middleTruncate(resultText(result), cfg.window.toolResultChars, TOOL_RESULT_CUT_NOTE),
      is_error: Boolean(result.isError),
    }
  }
  return out
}

const isEmpty = row => !row.text && !row.tool_calls && !row.tool_result

/**
 * @param derived - agent.session.deriveMessages(): what is already in the log.
 * @param claimed - the pre-step `messages` claimed from the inbox; not logged yet, so they are
 *   appended here or the memory model would never see the user turn it is about to answer.
 * @returns {{task: string, transcript: object[], alreadyTold: string[]}}
 */
export function buildWindow(derived, claimed, cfg) {
  const log = Array.isArray(derived) ? derived : []
  const inbox = Array.isArray(claimed) ? claimed : []
  const all = [...log, ...inbox]

  const firstUser = log.find(m => m?.source?.kind === 'user') ?? inbox.find(m => m?.source?.kind === 'user')
  const task = firstUser ? textOf(firstUser) : ''

  // Our own earlier reminders: unwrap the note out of the frame so the model reads what it said.
  const alreadyTold = all
    .filter(m => m?.source?.kind === 'plugin' && m.source.plugin === PLUGIN)
    .map(m => {
      const raw = textOf(m)
      const inner = /<context_for_action>([\s\S]*?)<\/context_for_action>/i.exec(raw)
      return (inner ? inner[1] : raw).trim()
    })
    .filter(Boolean)

  // Drop every plugin-sourced message: our reminders (repeated back as `alreadyTold`) and dsh's
  // runtime-context snapshots, which are boilerplate the memory model must not mistake for events.
  const transcript = all
    .filter(m => m && m.role !== 'system' && m.source?.kind !== 'plugin')
    .map(m => serialize(m, cfg))
    .filter(row => !isEmpty(row))
    .slice(-cfg.window.messages)

  return { task, transcript, alreadyTold }
}
