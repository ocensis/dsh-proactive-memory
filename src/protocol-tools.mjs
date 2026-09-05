// The paper-faithful protocol: four real tool schemas on the memory model's own request.
// These tools never touch ctx.tools — the executor agent's tool table is unchanged and the
// confirm-gate never sees them. Results are synthesized locally; nothing is dispatched.
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { parseTextReply } from './protocol-text.mjs'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const schema = (name, description, properties, required) => ({
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
})

export const MEMORY_TOOLS = [
  schema('memory_update_status', 'Replace the one-sentence status of where the task stands and what remains.',
    { status: str('One sentence.') }, ['status']),
  schema('memory_save_knowledge', 'Save or overwrite one fact that is costly to re-derive (ids, amounts, what the user ruled out, what is already verified).',
    { id: str('Short stable id, e.g. "k3". Reusing an id overwrites it.'), content: str('The fact.') }, ['id', 'content']),
  schema('memory_save_procedural', 'Save or overwrite one domain rule the agent has broken or is about to break, written as an instruction.',
    { id: str('Short stable id, e.g. "p1". Reusing an id overwrites it.'), content: str('The rule, phrased as an instruction.') }, ['id', 'content']),
  schema('memory_delete', 'Delete one bank entry that newer evidence contradicts.',
    { id: str('The id to delete.') }, ['id']),
]

const TO_EDIT = {
  memory_update_status: a => ({ op: 'update_status', content: a.status }),
  memory_save_knowledge: a => ({ op: 'save_knowledge', id: a.id, content: a.content }),
  memory_save_procedural: a => ({ op: 'save_procedural', id: a.id, content: a.content }),
  memory_delete: a => ({ op: 'delete', id: a.id }),
}

const addUsage = (total, u) => {
  if (!u) return total
  const out = { ...total }
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (typeof u[k] === 'number') out[k] = (out[k] ?? 0) + u[k]
  }
  return out
}

/**
 * Run the tool-calling loop.
 * @param streamOnce - (options) => Promise<{blocks, text, toolCalls, usage, finish, message}>; injected
 *   so this module stays free of ctx and stays unit-testable.
 * @returns {{edits, intervention, malformed, usage, finish, raw, rounds}}
 */
export async function runToolsProtocol({ streamOnce, options, messages, maxEdits = 6, maxRounds = 4, requireDecision = true }) {
  const convo = [...messages]
  const edits = []
  const malformed = []
  let usage
  let finish = { kind: 'stop' }
  let raw = ''

  for (let round = 1; round <= maxRounds; round++) {
    // A fresh array each round: the caller deep-freezes what it sends, and `convo` keeps growing.
    const out = await streamOnce({ ...options, messages: [...convo], tools: MEMORY_TOOLS })
    usage = addUsage(usage, out.usage)
    finish = out.finish
    raw = out.text

    if (out.toolCalls.length === 0) {
      const parsed = parseTextReply(out.text, { maxEdits: Math.max(0, maxEdits - edits.length), requireDecision })
      edits.push(...parsed.edits) // a text-only reply may still carry tags; accept both dialects
      malformed.push(...parsed.malformed)
      return { edits: edits.slice(0, maxEdits), intervention: parsed.intervention, malformed, usage, finish, raw, rounds: round }
    }

    for (const call of out.toolCalls) {
      const toEdit = TO_EDIT[call.name]
      if (!toEdit) { malformed.push(`unknown tool ${call.name}`); continue }
      let args
      try { args = JSON.parse(call.arguments || '{}') } catch { malformed.push(`${call.name}: unparsable arguments`); continue }
      if (!args || typeof args !== 'object') { malformed.push(`${call.name}: arguments not an object`); continue }
      edits.push(toEdit(args))
    }
    convo.push(out.message)
    for (const call of out.toolCalls) {
      convo.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'ok' }], isError: false }))
    }
  }

  malformed.push(`no text-only reply within ${maxRounds} rounds; treated as <no_intervention/>`)
  if (edits.length > maxEdits) {
    malformed.push(`over maxEditsPerCall: dropped ${edits.length - maxEdits} edit(s)`)
    edits.length = maxEdits
  }
  return { edits, intervention: null, malformed, usage, finish, raw, rounds: maxRounds }
}
