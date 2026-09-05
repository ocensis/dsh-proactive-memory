// Shared fakes. No network, no API key, no dsh runtime — only the message factories.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/config.mjs'

export const cfg = (over = {}) => resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' }, ...over })

export const userMsg = text =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

export const pluginMsg = (text, plugin = 'proactive-memory') =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'recall' } })

export const assistantMsg = (text, calls = []) => ({
  id: `a${Math.random()}`,
  role: 'assistant',
  content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c, i) => ({ type: 'tool-call', id: `c${i}`, name: c.name, arguments: c.arguments }))],
  source: { kind: 'model', provider: 'p', model: 'm' },
})

export const toolMsg = (callId, text, isError = false) => ({
  id: `t${Math.random()}`,
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
  source: { kind: 'tool', callId },
})

/** Scripted stream chunks for a text-only reply. */
export const textChunks = (text, usage = { inputTokens: 100, outputTokens: 20 }) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Scripted stream chunks for a reply that calls memory tools. */
export const toolChunks = (calls, usage = { inputTokens: 100, outputTokens: 20 }) => [
  ...calls.map((c, i) => ({ type: 'tool-call-delta', index: i, id: `mc${i}`, name: c.name, argumentsDelta: JSON.stringify(c.args) })),
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/**
 * A fake cordis context: records listeners and events, and streams whatever the script yields.
 * `script` is either an array of chunk-arrays (consumed in order) or a function of the options.
 */
export function makeCtx({ script = [], services = {} } = {}) {
  const listeners = new Map()
  const events = []
  const calls = []
  let i = 0
  return {
    listeners,
    events,
    calls,
    get llmCalls() { return calls.length },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return () => {} },
    emit(event, payload) { events.push({ event, payload }); return [] },
    get(name) { return services[name] },
    effect(fn) { return fn?.() },
    llm: {
      async *stream(options) {
        calls.push(options)
        const chunks = typeof script === 'function' ? script(options, i++) : (script[i++] ?? [])
        if (typeof chunks === 'string') throw new Error(chunks) // a string in the script means "fail here"
        for (const c of chunks) yield c
      },
    },
  }
}

export const preStepOf = ctx => ctx.listeners.get('agent/pre-step')?.[0]

export function fakeAgent(id = 's1', derived = []) {
  return { id, session: { id, deriveMessages: () => derived } }
}

/** Drive one pre-step through the listener, with the loop's own default decision. */
export function runPreStep(ctx, { agent, messages, turn = 1, step = 1, context, decision }) {
  const base = decision ?? { kind: 'enter', messages: context ? [...messages, context] : [...messages] }
  return preStepOf(ctx)({ agent, messages, turn, step, signal: AbortSignal.any([]) }, async () => base)
}

export const reminderIn = decision => decision.messages.find(m => m.source?.plugin === 'proactive-memory')
export const textOf = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
