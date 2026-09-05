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

/** Cap on the writes carried into one `<recent_writes>` section, oldest dropped first. */
const MAX_RECENT_WRITES = 8

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (cfg.mode === 'off') return // registers nothing at all: zero listeners, zero cost

  const states = new Map() // String(agent.id) -> episode state. Never module-level: 4 sessions share a process.
  const stats = { consults: 0, injects: 0, skips: 0, errors: 0, guards: 0 }
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
      s = { bank: createBank(), counted: 0, calls: 0, injected: [], lastBankRender: '', recentWrites: [], toolErrors: 0, turn: 0 }
      states.set(sid, s)
    }
    return s
  }

  /** Everything after next(). Any throw in here is caught by the listener and fails open. */
  async function decide({ agent, messages, turn, step, signal }, decision) {
    // ── LOOP SAFETY (dsh-agent-loop: preStep :492-514, turn :516-573, step :606-686) ──────────
    // The turn loop is: preStep() → three guard lines → session.append('step/start') → step(). So
    // there is exactly one pre-step per model request, and the question is never "is this step
    // real" but "would this step run if I returned the decision untouched".
    //
    //   :541      if (turnEnds && decision.messages.length === 0) break;
    //   :542-545  if (phase.step === 0 && decision.messages.length === 0) { turnEnds = completed; return false }
    //   :571      if (turnEnds && this.inbox.nextStep.length === 0) break;
    //
    // MID-TURN steps (step > 1, reached because the previous reply had tool calls) are SAFE to
    // splice into. step() logged their tool results straight into the session (:685, not via the
    // inbox) and returned null, so `turnEnds` is null and neither :541 nor :542-545 can fire: the
    // loop runs this step whatever we return. `messages` (the inbox claim, :496) is empty there
    // and `decision.messages` holds at most a runtime-context message, so the old "empty list"
    // guards below suppressed every mid-turn step silently — one consult per user turn instead of
    // one per model request. Splicing adds no request that would not happen anyway; the reminder is
    // logged as a user/message at step/start right after the tool results, the same position dsh's
    // own runtime-context message occupies.
    //
    // Two cases stay UNSAFE and are still guarded, both of them the R1 bug:
    //   (a) step 1 of a turn with nothing claimed — :542-545 completes the turn without a request,
    //       so a spliced message manufactures one.
    //   (b) any pre-step reached after the turn already ended (the previous reply had no tool calls,
    //       or hit max-tokens). That only happens when inbox.nextStep was non-empty (steering,
    //       inject), and :541 breaks on an empty decision — a splice resurrects a finished turn and
    //       the user turn ends up with two assistant messages.
    // The session log tells them apart: mid-turn ⇔ its last message is a tool result (role 'user',
    // source.kind 'tool'). After a completed turn the last message is the assistant reply — with no
    // tool-call blocks, or with blocks that max-tokens cut before any result could follow. Either
    // way not a tool-result message, so the test correctly says "not mid-turn".
    if (decision.kind === 'reject') return decision
    const claimed = Array.isArray(messages) ? messages : []
    const derived = agent?.session?.deriveMessages?.() ?? []
    const last = derived.at?.(-1)
    const midTurn = step > 1 && !!last && last.role === 'user' && last.source?.kind === 'tool'
    if (claimed.length === 0 && !midTurn) {
      stats.guards++ // counted, never an event: this is the common case, not an anomaly
      return decision
    }
    if (!Array.isArray(decision.messages)) return decision

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
      const win = buildWindow(derived, claimed, cfg)
      // Consumed here: <recent_writes> reports the writes observed since the PREVIOUS consult, all
      // of them already executed. `unknown` and `(none)` are different answers — nothing configured
      // to watch versus nothing written.
      const recentWrites = state.recentWrites.length
        ? state.recentWrites.join('\n')
        : (cfg.writeTools.length > 0 ? '(none)' : 'unknown')
      state.recentWrites = []

      state.calls++
      let out
      try {
        out = await consult(ctx, cfg, state, { ...win, step, route, sessionId: agent?.session?.id, recentWrites }, signal)
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
    // reminder still precedes a trailing runtime-context message the loop appended. On a mid-turn
    // step nothing was claimed, so this is -1 and the reminder lands at index 0 — still in front of
    // that runtime-context message.
    const lastClaimedIndex = decision.messages.findLastIndex(m => claimed.includes(m))
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

  // Observe-only, always next(). The confirm-gate is registered before us, so a gated deny never
  // reaches here — which is correct: a denied call never executed, and it is already a tool result
  // in the transcript the memory model reads anyway.
  //
  // This fires while the call is being dispatched, and the next consult happens at the pre-step
  // AFTER its result was logged: what we collect here is always a write that has already run, which
  // is what <recent_writes> says. There is no hook that sees a write before it executes.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const state = states.get(sidOf(exec))
      if (state && cfg.writeTools.includes(exec.name)) {
        state.recentWrites.push(`${exec.name} ${middleTruncate(JSON.stringify(exec.arguments ?? {}), cfg.window.argChars)}`)
        // Bounded: a consult that never happens (schedule, max-calls) must not grow this forever.
        if (state.recentWrites.length > MAX_RECENT_WRITES) state.recentWrites.splice(0, state.recentWrites.length - MAX_RECENT_WRITES)
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
