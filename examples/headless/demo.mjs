// `npm run demo` — the whole plugin end to end with no API key and no dsh runtime.
//
// A fake cordis context, a fake agent carrying a scripted retail transcript, and a scripted memory
// model. Prints what the memory model was asked, what it answered, what landed in the bank, and the
// exact message that would be spliced in front of the executor's next request.
//
// The two steps below are the two shapes a pre-step comes in:
//   step 1 of a turn — the user's message was claimed from the inbox;
//   a mid-turn step  — nothing was claimed, the previous reply called a tool and its result is
//                      already in the session log. One model request all the same.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../../src/index.mjs'

const SESSION = 'demo-session'
const line = s => console.log(s)
const rule = title => line(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)

// ── the scripted retail episode ───────────────────────────────────────────────────────────────
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text, calls = []) => ({
  id: `a-${Math.random()}`,
  role: 'assistant',
  content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c, i) => ({ type: 'tool-call', id: `call-${i}`, name: c.name, arguments: JSON.stringify(c.args) }))],
  source: { kind: 'model', provider: 'openrouter', model: 'executor' },
})
const toolResult = (callId, text, isError = false) => ({
  id: `t-${Math.random()}`,
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
  source: { kind: 'tool', callId },
})

const log = [
  user('Hi, I want to return the mechanical keyboard from my last order and get a refund.'),
  assistant('Happy to help. Let me look that up.', [{ name: 'find_user_id_by_email', args: { email: 'sara.doe@example.com' } }]),
  toolResult('call-0', 'sara_doe_496'),
  assistant('Found your account.', [{ name: 'get_order_details', args: { order_id: '#W2378156' } }]),
  toolResult('call-0', JSON.stringify({ order_id: '#W2378156', status: 'delivered', items: [{ name: 'Mechanical Keyboard', item_id: '1151293680', price: 272.51 }], payment_history: [{ payment_method_id: 'credit_card_9513926' }] })),
]

// ── the scripted memory model: one reply per consult ──────────────────────────────────────────
const replies = [
  `<memory_update_status>User wants to return a keyboard from #W2378156; identity looked up by email.</memory_update_status>
<memory_save_knowledge id="k1">User sara_doe_496, order #W2378156 delivered, keyboard item 1151293680 at $272.51.</memory_save_knowledge>
<memory_save_procedural id="p1">Return exchanges must be confirmed by the user with the exact item list and refund method before calling a write tool.</memory_save_procedural>
<no_intervention/>`,

  `<memory_save_knowledge id="k2">return_delivered_order_items on #W2378156 already ran and came back refused; the refund destination was never read back to the user.</memory_save_knowledge>
<context_for_action>The return you just attempted was refused because the user never confirmed it. Read back item 1151293680 ($272.51) and ask whether the refund goes to credit_card_9513926 or a gift card, then wait for an explicit yes before retrying.</context_for_action>`,
]

// ── the fake context ──────────────────────────────────────────────────────────────────────────
const listeners = new Map()
let consultIndex = 0
const ctx = {
  on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
  emit(event, payload) { events.push(payload) },
  get() { return undefined },
  effect(fn) { return fn?.() },
  llm: {
    async *stream(options) {
      lastRequest = options
      const text = replies[consultIndex++] ?? '<no_intervention/>'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 1420, outputTokens: 96 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}
const events = []
let lastRequest

const agent = { id: SESSION, session: { id: SESSION, deriveMessages: () => log } }
const textOf = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')

apply(ctx, {
  mode: 'proactive',
  model: { provider: 'openrouter', model: 'scripted-memory-model' },
  writeTools: ['return_delivered_order_items', 'modify_pending_order_items'],
})

const preStep = listeners.get('agent/pre-step')[0]
const preExecute = listeners.get('tools/pre-execute')[0]

/**
 * Drive one pre-step exactly the way dsh-agent-loop does. At step 1 of a turn the inbox claim is the
 * user's message and the loop's default decision is `[...claimed, context]`; on a mid-turn step the
 * claim is empty and the decision holds at most that runtime-context message.
 */
async function step({ claimed = [], turn, at }) {
  const context = createUserMessage({
    content: [{ type: 'text', text: '<runtime-context>…</runtime-context>' }],
    source: { kind: 'plugin', plugin: 'dsh-runtime-context', form: 'snapshot' },
  })
  const base = { kind: 'enter', messages: [...claimed, context] }
  const out = await preStep({ agent, messages: claimed, turn, step: at, signal: AbortSignal.any([]) }, async () => base)
  log.push(...claimed) // the loop appends the decision's messages at step/start
  return { out, base, context }
}

const sectionOf = (name, text) => new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1] ?? '(none)'

rule('STEP 1 of turn 2 — the user answers; the memory model is consulted and stays silent')
const first = await step({ claimed: [user('Yes, the keyboard.')], turn: 2, at: 1 })
line('\n· system prompt (first 3 lines):')
for (const l of lastRequest.system.split('\n').slice(0, 3)) line(`    ${l}`)
line('\n· user message sent to the memory model:')
line(textOf(lastRequest.messages[0]).split('\n').map(l => `    ${l}`).join('\n'))
line(`\n· decision: ${first.out === first.base ? 'unchanged — nothing spliced' : 'spliced'}`)

// The executor now runs a write. tools/pre-execute observes it and always next()s; by the time the
// next consult happens the call has executed and its result is in the log — which is exactly what
// <recent_writes> reports. The confirm gate ahead of us refused this one, so the result is an error.
await preExecute(
  { agent, name: 'return_delivered_order_items', arguments: { order_id: '#W2378156', item_ids: ['1151293680'], payment_method_id: 'credit_card_9513926' } },
  async () => ({ kind: 'allow' }),
)
log.push(assistant('Let me process that return.', [{ name: 'return_delivered_order_items', args: { order_id: '#W2378156' } }]))
log.push(toolResult('call-0', 'Confirmation required before this database update.', true))

rule('STEP 2 of turn 2 — a MID-TURN step: nothing claimed, one model request all the same')
line('\nThat reply called a tool, so the loop logged the tool result itself (dsh-agent-loop:685) and')
line('came straight back for another request: turnEnds is null, so neither :541 nor :542-545 can end')
line('the turn. The inbox claim is empty and the decision holds only the runtime-context message.')
line('The plugin recognises the step by the session log ending in a tool result, and splices into it.')
const second = await step({ claimed: [], turn: 2, at: 2 })
line('\n· <recent_writes> the memory model saw (already executed — it cannot stop them):')
line(sectionOf('recent_writes', textOf(lastRequest.messages[0])).split('\n').map(l => `    ${l}`).join('\n'))
line('\n· spliced messages, in order:')
for (const [i, m] of second.out.messages.entries()) {
  line(`    [${i}] source=${m.source.kind}${m.source.plugin ? `/${m.source.plugin}` : ''}${m.source.form ? ` form=${m.source.form}` : ''}`)
}
const reminder = second.out.messages.find(m => m.source.plugin === 'proactive-memory')
line('\n· the injected reminder, verbatim:')
line(textOf(reminder).split('\n').map(l => `    ${l}`).join('\n'))
line(`\n· the reminder sits at index ${second.out.messages.indexOf(reminder)}: nothing was claimed, so it goes first — still in front of`)
line('  the runtime context, the same place it takes after a claimed message.')

rule('EVENTS emitted on proactive-memory/event')
for (const e of events) {
  const { kind, ts, ...rest } = e
  line(`  ${kind.padEnd(8)} ${JSON.stringify(rest).slice(0, 190)}`)
}

rule('SUMMARY')
line(`  consults: ${events.filter(e => e.kind === 'consult').length}   injects: ${events.filter(e => e.kind === 'inject').length}   ` +
  `memory tokens: ${events.filter(e => e.kind === 'consult').reduce((n, e) => n + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0)}`)
line('  One consult per model request, the mid-turn one included — earlier versions of this plugin')
line('  dropped it silently because nothing had been claimed from the inbox.')
line('  No API key was used: the model stream above was scripted.\n')
