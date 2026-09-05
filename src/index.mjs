// dsh-plugin-proactive-memory — one injection path, one auxiliary model call, one episode-scoped bank.
//
// The pre-step listener below is the whole plugin. It runs inside the agent loop's waterfall, so a
// throw there kills a turn: everything after next() is wrapped, and every failure returns the
// decision unchanged (fail-open). See README rules R1 (never inject into an empty step) and
// R2 (never session.append a custom event type, never systemPrompt.section()).
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyEdits, createBank, renderBank } from './bank.mjs'
import { Config, resolveConfig, scheduled } from './config.mjs'
import { emit } from './events.mjs'
import { buildReminder, clip, shouldInject, stripUnsafe } from './inject.mjs'
import { consult } from './memory-agent.mjs'
import { appendTrace } from './trace.mjs'
import { PLUGIN, buildWindow, middleTruncate } from './window.mjs'

export const name = PLUGIN
export const inject = ['llm']
export { Config }

const sidOf = x => String(x?.agent?.id ?? x?.agent?.session?.id ?? x?.id ?? 'unknown')

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (cfg.mode === 'off') return // registers nothing at all: zero listeners, zero cost

  const states = new Map() // String(agent.id) -> episode state. Never module-level: 4 sessions share a process.
  const stats = { consults: 0, injects: 0, skips: 0, errors: 0 }
  const log = (kind, fields) => emit(ctx, kind, fields, { console: cfg.trace.console, mode: cfg.mode })
  let warnedFallback = false

  /** The configured memory route, or the executor's own model with a loud one-time warning. */
  function resolveRoute() {
    if (cfg.model.provider && cfg.model.model) return { provider: cfg.model.provider, model: cfg.model.model }
    const fallback = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!fallback?.provider || !fallback?.model) throw new Error('no memory model configured and no agentDefaultModel to fall back to')
    if (!warnedFallback) {
      warnedFallback = true
      console.warn(
        `[proactive-memory] WARNING: memory model not configured; falling back to the executor's default model ` +
          `${fallback.provider}/${fallback.model} — the memory arm now shares the executor model`,
      )
    }
    return { provider: fallback.provider, model: fallback.model }
  }

  function stateFor(sid) {
    let s = states.get(sid)
    if (!s) {
      s = { bank: createBank(), counted: 0, calls: 0, injected: [], lastBankRender: '', lastWrite: null, toolErrors: 0, turn: 0 }
      states.set(sid, s)
    }
    return s
  }

  /** Everything after next(). Any throw in here is caught by the listener and fails open. */
  async function decide({ agent, messages, turn, step, signal }, decision) {
    // ── LOOP SAFETY (dsh-agent-loop:540-546, :571) ────────────────────────────────────────────
    // Splicing into an empty step manufactures a model request that would not otherwise happen —
    // exactly the agent.inject() bug. Three guards, all returning the decision untouched.
    if (decision.kind === 'reject') return decision
    if (!Array.isArray(messages) || messages.length === 0) return decision
    if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

    const sid = sidOf({ agent })
    const state = stateFor(sid)
    state.turn = turn
    state.counted++
    const at = { session_id: sid, turn, step }

    if (!scheduled(state.counted, cfg.schedule)) {
      stats.skips++
      log('skip', { ...at, why: 'schedule' })
      return decision
    }

    let note = null
    let source = cfg.mode
    let flushTrace = () => {} // set once a consult has happened; called with the final verdict
    if (cfg.mode === 'always') {
      note = cfg.alwaysText // zero model calls: this arm is the paper's always-inject
      source = 'always'
    } else {
      if (state.calls >= cfg.schedule.maxCallsPerEpisode) {
        stats.skips++
        log('skip', { ...at, why: 'max-calls' })
        return decision
      }
      const route = resolveRoute()
      const derived = agent?.session?.deriveMessages?.() ?? []
      const win = buildWindow(derived, messages, cfg)
      const aboutToAct = state.lastWrite ? `${state.lastWrite.name} ${state.lastWrite.args}` : ''
      state.lastWrite = null // consumed: <about_to_act> reports what happened since the last consult

      state.calls++
      let out
      try {
        out = await consult(ctx, cfg, state, { ...win, step, route, sessionId: agent?.session?.id, aboutToAct }, signal)
      } catch (error) {
        stats.errors++
        log('error', { ...at, message: String(error?.message ?? error), code: error?.name ?? 'Error' })
        return decision
      }
      stats.consults++
      log('consult', {
        ...at,
        protocol: cfg.protocol,
        provider: route.provider,
        model: route.model,
        ms: out.ms,
        input_tokens: out.usage?.inputTokens ?? null,
        output_tokens: out.usage?.outputTokens ?? null,
        cache_read_tokens: out.usage?.cacheReadTokens ?? null,
        reasoning_tokens: out.usage?.reasoningTokens ?? null,
        decision: out.decision,
        edits: out.edits,
        malformed: out.malformed.length,
        finish: out.finish?.kind ?? 'stop',
      })
      flushTrace = injected => void appendTrace(cfg.trace.dir, sid, {
        turn, step, system: out.system, user: out.user, reply: out.raw,
        parsed: { decision: out.decision, note: out.note, edits: out.edits, malformed: out.malformed },
        usage: out.usage ?? null, ms: out.ms, injected,
      })

      if (cfg.mode === 'bankctx') {
        // The bank IS the note here (the paper's "full bank in context" ablation). Only inject when
        // it actually moved, or every step would repeat the same block.
        const rendered = renderBank(state.bank, { ids: false })
        note = rendered && rendered !== state.lastBankRender ? rendered : null
        source = 'bankctx'
      } else {
        note = out.decision === 'intervene' ? out.note : null
        source = 'proactive'
      }
    }

    if (note === null) {
      if (cfg.mode === 'bankctx') { stats.skips++; log('skip', { ...at, why: 'dedupe' }) }
      flushTrace(false)
      return decision
    }
    // Judge the note as the executor would receive it: a reply that is nothing but markup strips to ''.
    if (!stripUnsafe(note).trim()) {
      stats.skips++
      log('skip', { ...at, why: 'empty' })
      flushTrace(false)
      return decision
    }
    if (cfg.mode !== 'always') {
      // `always` deliberately ignores budget and dedupe: injecting the same line every step is the arm.
      const gate = shouldInject(state, note, cfg)
      if (!gate.ok) {
        stats.skips++
        log('skip', { ...at, why: gate.why })
        flushTrace(false)
        return decision
      }
    }

    const text = buildReminder(note, cfg)
    const reminder = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN, form: 'recall' },
    })
    // Official splice (dsh-agent-instructions:1284-1288): right after the last claimed message, so the
    // reminder still precedes a trailing runtime-context message the loop appended.
    const lastClaimedIndex = decision.messages.findLastIndex(m => messages.includes(m))
    const spliced = decision.messages.toSpliced(lastClaimedIndex + 1, 0, reminder)

    state.injected.push(note)
    if (cfg.mode === 'bankctx') state.lastBankRender = note
    stats.injects++
    log('inject', { ...at, source, text, chars: text.length })
    flushTrace(true)
    return { kind: 'enter', messages: spliced }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      return await decide(payload, decision)
    } catch (error) {
      // Last-resort net. Memory must never be able to break a turn.
      stats.errors++
      try {
        log('error', {
          session_id: sidOf(payload), turn: payload?.turn, step: payload?.step,
          message: String(error?.message ?? error), code: 'listener',
        })
      } catch { /* even the event channel is optional */ }
      return decision
    }
  })

  // Observe-only. The confirm-gate is registered before us, so a gated deny never reaches here —
  // which is correct: a denied call is not "about to act", it is already a tool result in the log.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const state = states.get(sidOf(exec))
      if (state && cfg.writeTools.includes(exec.name)) {
        state.lastWrite = { name: exec.name, args: middleTruncate(JSON.stringify(exec.arguments ?? {}), cfg.window.argChars) }
      }
    } catch { /* observation only */ }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      const state = states.get(sidOf(exec))
      if (state && result?.isError) state.toolErrors++
    } catch { /* observation only */ }
  })

  // Destructuring in the parameter list would throw outside the try, so take the payload whole.
  ctx.on('agent/disposed', payload => {
    try { states.delete(sidOf({ agent: payload?.agent })) } catch { /* nothing to clean */ }
  })

  ctx.effect?.(() => () => {
    states.clear()
    console.log(`[proactive-memory:${cfg.mode}] stats ${JSON.stringify(stats)}`)
  })

  let banner = `${cfg.model.provider || '(default)'}/${cfg.model.model || '(default)'}`
  if (cfg.mode === 'always') banner = '(none)'
  console.log(
    `[proactive-memory] mode=${cfg.mode} protocol=${cfg.protocol} model=${banner} every=${cfg.schedule.everySteps} ` +
      `window=${cfg.window.messages} trace=${cfg.trace.dir || 'off'}`,
  )
}

// Re-exported so hosts and tests can reach the pieces without importing deep paths.
export { applyEdits, buildReminder, buildWindow, clip, consult, createBank, renderBank, resolveConfig, scheduled, shouldInject, stripUnsafe }
