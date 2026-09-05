// The pre-step listener under a fake ctx. Everything here is offline: no API key, no dsh runtime.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { apply } from '../src/index.mjs'
import { jaccard } from '../src/inject.mjs'
import { assistantMsg, fakeAgent, makeCtx, pluginMsg, preStepOf, reminderIn, runPreStep, textChunks, textOf, toolChunks, toolMsg, userMsg } from './helpers.mjs'

const ARM = { mode: 'proactive', model: { provider: 'openrouter', model: 'cheap' }, trace: { console: false } }
const NOTE = '<context_for_action>Order #W1 does not contain item 5551; check which order the user means.</context_for_action>'
const kinds = ctx => ctx.events.map(e => e.payload.kind)
const of = (ctx, kind) => ctx.events.map(e => e.payload).filter(e => e.kind === kind)

/**
 * One episode driven the way dsh-agent-loop drives one (:516-573): one pre-step per model request;
 * messages are claimed from the inbox only on the first step of a turn; step() logs the assistant
 * reply and its tool results straight into the session before the next pre-step runs.
 * @returns {{modelSteps: number, injects: number}}
 */
async function runEpisode(ctx, agent, log, turns) {
  let modelSteps = 0
  let injects = 0
  for (const [i, spec] of turns.entries()) {
    for (let step = 1; step <= spec.steps; step++) {
      modelSteps++
      const claimed = step === 1 ? [userMsg(spec.user)] : []
      const base = { kind: 'enter', messages: [...claimed] }
      const out = await runPreStep(ctx, { agent, messages: claimed, turn: i + 1, step, decision: base })
      if (out !== base) injects++
      log.push(...claimed) // step/start appends the decision's messages
      const last = step === spec.steps
      log.push(assistantMsg(last ? 'all set' : 'looking that up', last ? [] : [{ name: 'get_order_details', arguments: '{}' }]))
      if (!last) log.push(toolMsg('c0', '{"status":"delivered"}')) // executeToolCalls appends these itself
    }
  }
  return { modelSteps, injects }
}

test('mode=off registers nothing at all', () => {
  const ctx = makeCtx()
  apply(ctx, { mode: 'off' })
  assert.equal(ctx.listeners.size, 0)
})

test('a rejected step is returned untouched and costs no model call', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const base = { kind: 'reject' }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')], decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
})

// Rule R1, case (a): at step 1 with nothing claimed the loop completes the turn without a request
// (dsh-agent-loop:542-545), so a spliced message would manufacture one.
test('step 1 with nothing claimed is returned untouched and costs no model call (rule R1)', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const base = { kind: 'enter', messages: [pluginMsg('runtime context', 'x')] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [], step: 1, decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
  assert.deepEqual(kinds(ctx), [])
})

// Rule R1, case (a) again, the other way round: something WAS claimed, but an earlier pre-step
// listener returned an empty decision. dsh-agent-loop:542-545 would still end the turn without a
// request, so the plugin must not splice — the inbox claim alone is not proof that the step runs.
test('step 1 with a claimed message but an emptied decision is returned untouched (rule R1)', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const base = { kind: 'enter', messages: [] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('cancel order W1')], step: 1, decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
  assert.deepEqual(kinds(ctx), [])
})

// Rule R1, case (b): a pre-step reached after the turn already ended. The previous reply had no
// tool calls, so the session log ends with an assistant message and no tool result follows it;
// dsh-agent-loop:541 breaks on an empty decision, and splicing would resurrect a finished turn.
test('a pre-step after the turn ended is returned untouched, even at step > 1 (rule R1)', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const log = [userMsg('cancel order W1'), assistantMsg('Done — anything else?')]
  const base = { kind: 'enter', messages: [] }
  const out = await runPreStep(ctx, { agent: fakeAgent('s1', log), messages: [], step: 3, decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
  assert.deepEqual(kinds(ctx), [])
})

// The mid-turn step the old empty-list guards suppressed. The previous reply made tool calls, so
// step() logged their results into the session and returned null: turnEnds is null, neither :541 nor
// :542-545 can fire, and the loop runs this step whatever we return. Splicing adds no request.
test('a mid-turn step is spliced into even though nothing was claimed', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const log = [
    userMsg('cancel order W1'),
    assistantMsg('Let me look.', [{ name: 'get_order_details', arguments: '{"order_id":"W1"}' }]),
    toolMsg('c1', '{"status":"pending"}'),
  ]
  const base = { kind: 'enter', messages: [] }
  const out = await runPreStep(ctx, { agent: fakeAgent('s1', log), messages: [], step: 3, decision: base })

  assert.notEqual(out, base)
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].source.plugin, 'proactive-memory')
  assert.ok(textOf(out.messages[0]).includes('Order #W1 does not contain item 5551'))
  assert.deepEqual(kinds(ctx), ['consult', 'inject'])
  assert.equal(of(ctx, 'inject')[0].step, 3)
})

test('a mid-turn reminder still precedes a trailing runtime-context message', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const log = [
    userMsg('cancel order W1'),
    assistantMsg('Let me look.', [{ name: 'get_order_details', arguments: '{"order_id":"W1"}' }]),
    toolMsg('c1', '{"status":"pending"}'),
  ]
  const context = pluginMsg('runtime context snapshot', 'dsh-runtime-context')
  const base = { kind: 'enter', messages: [context] }
  const out = await runPreStep(ctx, { agent: fakeAgent('s1', log), messages: [], step: 2, decision: base })

  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].source.plugin, 'proactive-memory') // index 0: lastClaimedIndex is -1
  assert.equal(out.messages[1], context)
})

test('a normal step splices one reminder after the last claimed message and before runtime context', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const claimed = [userMsg('please refund my order')]
  const context = pluginMsg('runtime context snapshot', 'dsh-runtime-context')
  const out = await runPreStep(ctx, { agent: fakeAgent('s1', [userMsg('hello'), assistantMsg('hi')]), messages: claimed, context })

  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 3)
  assert.equal(out.messages[0], claimed[0])
  assert.equal(out.messages[2], context)
  const reminder = out.messages[1]
  assert.equal(reminder.source.kind, 'plugin')
  assert.equal(reminder.source.plugin, 'proactive-memory')
  assert.equal(reminder.source.form, 'recall')
  assert.ok(textOf(reminder).includes('Order #W1 does not contain item 5551'))
  assert.ok(textOf(reminder).startsWith('<system-reminder>'))

  assert.deepEqual(kinds(ctx), ['consult', 'inject'])
  const consult = of(ctx, 'consult')[0]
  assert.equal(consult.decision, 'intervene')
  assert.equal(consult.model, 'cheap')
  assert.equal(consult.input_tokens, 100)
  assert.equal(consult.session_id, 's1')
  assert.equal(of(ctx, 'inject')[0].source, 'proactive')
})

test('the memory model gets the task, the transcript and the claimed turn', async () => {
  const ctx = makeCtx({ script: [textChunks('<no_intervention/>')] })
  apply(ctx, ARM)
  await runPreStep(ctx, { agent: fakeAgent('s1', [userMsg('cancel order W1')]), messages: [userMsg('yes please')] })
  const sent = textOf(ctx.calls[0].messages[0])
  assert.ok(sent.includes('<task>\ncancel order W1\n</task>'))
  assert.ok(sent.includes('<transcript step="1" window="8">'))
  assert.ok(sent.includes('yes please'))
  assert.ok(sent.includes('<recent_writes>\nunknown\n</recent_writes>')) // nothing configured to watch
  assert.ok(ctx.calls[0].system.includes('PHASE 2'))
  assert.equal(ctx.calls[0].temperature, 0)
  assert.equal(ctx.calls[0].maxTokens, 512)
})

test('no_intervention leaves the decision alone', async () => {
  const ctx = makeCtx({ script: [textChunks('<memory_update_status>fine</memory_update_status><no_intervention/>')] })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', messages: [...claimed] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: base })
  assert.equal(out, base)
  assert.equal(of(ctx, 'consult')[0].decision, 'no_intervention')
  assert.equal(of(ctx, 'consult')[0].edits, 1)
})

test('a consult that throws fails open with an error event', async () => {
  const ctx = makeCtx({ script: ['provider exploded'] })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', messages: [...claimed] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: base })
  assert.equal(out, base)
  assert.deepEqual(kinds(ctx), ['error'])
  assert.ok(of(ctx, 'error')[0].message.includes('provider exploded'))
})

test('a consult that times out fails open', async () => {
  const ctx = makeCtx({
    script: async function* () { await new Promise(r => setTimeout(r, 200)) },
  })
  ctx.llm.stream = async function* (options) {
    ctx.calls.push(options)
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  apply(ctx, { ...ARM, model: { ...ARM.model, timeoutMs: 500 } })
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', messages: [...claimed] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: base })
  assert.equal(out, base)
  assert.deepEqual(kinds(ctx), ['error'])
})

test('a terminal finish reason is an error, not a silent no-op', async () => {
  const ctx = makeCtx({ script: [[{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }]] })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: { kind: 'enter', messages: [...claimed] } })
  assert.ok(of(ctx, 'error')[0].message.includes('rate limited'))
})

// A truncated reply loses the closing tags the parser needs, so the intervention the model was in
// the middle of writing would parse as a deliberate `<no_intervention/>` — an arm that ran out of
// output budget would then report as an arm that chose silence. It must be an error instead.
// (Under the tools protocol it is worse: BlockAssembler drops the tool-call blocks on max-tokens,
// so that round's bank edits would disappear with no signal at all.)
test('a max-tokens (truncated) reply is an error, not a fake no_intervention', async () => {
  const truncated = '<memory_save_knowledge id="k1">user is Yusuf</memory_save_knowledge>\n'
    + '<context_for_action>You are about to run return_delivered_order_items'
  const ctx = makeCtx({
    script: [[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: truncated },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 512 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]],
  })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', messages: [...claimed] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: base })
  assert.equal(out, base) // still fails open: memory never breaks a turn
  assert.deepEqual(kinds(ctx), ['error']) // and never a consult event with decision=no_intervention
  assert.match(of(ctx, 'error')[0].message, /max-tokens/)
  assert.match(of(ctx, 'error')[0].message, /maxTokens=/)
})

test('mode=always injects the fixed text with zero model calls', async () => {
  const ctx = makeCtx()
  apply(ctx, { mode: 'always', trace: { console: false }, alwaysText: 'CHECK YOURSELF' })
  const claimed = [userMsg('hi')]
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed })
  assert.equal(ctx.llmCalls, 0)
  assert.ok(textOf(reminderIn(out)).includes('CHECK YOURSELF'))
  assert.deepEqual(kinds(ctx), ['inject'])
  assert.equal(of(ctx, 'inject')[0].source, 'always')

  // and it repeats every step: no dedupe, no budget — that is the arm.
  for (let i = 0; i < 20; i++) await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')], step: i + 2 })
  assert.equal(of(ctx, 'inject').length, 21)
})

test('the schedule skips uncounted steps without a model call', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, schedule: { firstStep: true, everySteps: 3 } })
  const agent = fakeAgent()
  for (let step = 1; step <= 4; step++) await runPreStep(ctx, { agent, messages: [userMsg(`m${step}`)], step })
  assert.equal(ctx.llmCalls, 2) // counted steps 1 and 4
  assert.deepEqual(of(ctx, 'skip').map(e => e.why), ['schedule', 'schedule'])
})

test('maxCallsPerEpisode caps model calls', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, schedule: { maxCallsPerEpisode: 2 } })
  const agent = fakeAgent()
  for (let step = 1; step <= 4; step++) await runPreStep(ctx, { agent, messages: [userMsg(`m${step}`)], step })
  assert.equal(ctx.llmCalls, 2)
  assert.deepEqual(of(ctx, 'skip').map(e => e.why), ['max-calls', 'max-calls'])
})

test('near-duplicate notes are suppressed and the budget is per episode', async () => {
  const ctx = makeCtx({ script: () => textChunks(NOTE) })
  apply(ctx, { ...ARM, intervention: { maxPerEpisode: 5 } })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('a')], step: 1 })
  await runPreStep(ctx, { agent, messages: [userMsg('b')], step: 2 })
  assert.equal(of(ctx, 'inject').length, 1)
  assert.deepEqual(of(ctx, 'skip').map(e => e.why), ['dedupe'])
})

test('episodes are isolated by agent id and dropped on agent/disposed', async () => {
  const ctx = makeCtx({ script: () => textChunks(NOTE) })
  apply(ctx, { ...ARM, intervention: { maxPerEpisode: 1 } })
  await runPreStep(ctx, { agent: fakeAgent('s1'), messages: [userMsg('a')] })
  await runPreStep(ctx, { agent: fakeAgent('s2'), messages: [userMsg('a')] })
  assert.equal(of(ctx, 'inject').length, 2) // s2 has its own budget

  await runPreStep(ctx, { agent: fakeAgent('s1'), messages: [userMsg('c')], step: 2 })
  assert.equal(of(ctx, 'skip').at(-1).why, 'budget')
  ctx.listeners.get('agent/disposed')[0]({ agent: fakeAgent('s1') })
  await runPreStep(ctx, { agent: fakeAgent('s1'), messages: [userMsg('d')], step: 3 })
  assert.equal(of(ctx, 'inject').length, 3) // fresh episode, fresh budget
})

test('tools protocol drives real tool schemas and synthesizes the results locally', async () => {
  const ctx = makeCtx({
    script: [
      toolChunks([{ name: 'memory_save_knowledge', args: { id: 'k1', content: 'user is verified' } }]),
      textChunks('<context_for_action>the total is wrong</context_for_action>'),
    ],
  })
  apply(ctx, { ...ARM, protocol: 'tools' })
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')] })
  assert.equal(ctx.llmCalls, 2)
  assert.deepEqual(ctx.calls[0].tools.map(t => t.name), ['memory_update_status', 'memory_save_knowledge', 'memory_save_procedural', 'memory_delete'])
  assert.equal(ctx.calls[1].messages.length, 3)
  assert.ok(textOf(reminderIn(out)).includes('the total is wrong'))
  assert.equal(of(ctx, 'consult')[0].edits, 1)
  assert.equal(of(ctx, 'consult')[0].input_tokens, 200) // summed across rounds
})

test('bankctx injects the rendered bank, and only when it changed', async () => {
  const ctx = makeCtx({
    script: [
      textChunks('<memory_update_status>verifying</memory_update_status>'),
      textChunks(''),
      textChunks('<memory_save_knowledge id="k1">order W1 is delivered</memory_save_knowledge>'),
    ],
  })
  apply(ctx, { ...ARM, mode: 'bankctx' })
  const agent = fakeAgent()
  const a = await runPreStep(ctx, { agent, messages: [userMsg('1')], step: 1 })
  assert.ok(textOf(reminderIn(a)).includes('Status: verifying'))
  assert.ok(!textOf(reminderIn(a)).includes('[k1]')) // internal ids stay internal

  const b = await runPreStep(ctx, { agent, messages: [userMsg('2')], step: 2 })
  assert.equal(reminderIn(b), undefined)
  assert.equal(of(ctx, 'skip').at(-1).why, 'dedupe')

  const c = await runPreStep(ctx, { agent, messages: [userMsg('3')], step: 3 })
  assert.ok(textOf(reminderIn(c)).includes('order W1 is delivered'))
})

// shouldInject is note-shaped: 12 injections an episode and Jaccard 0.8 over a bag of words. Two
// successive whole-bank renders differ by one entry and overlap almost completely, so that gate
// threw most bank updates away as 'dedupe' and then stopped the arm outright at the note budget —
// in the one arm whose whole definition is "the full bank is in the executor's context".
// `rendered !== state.lastBankRender` is bankctx's own dedupe, and it is the only one that applies.
test('bankctx is not gated by the note budget or the note dedupe', async () => {
  const ctx = makeCtx({
    script: (_options, i) =>
      textChunks(`<memory_save_knowledge id="k${i}">order W${i} is delivered and was paid by gift card</memory_save_knowledge>`),
  })
  apply(ctx, { ...ARM, mode: 'bankctx', intervention: { maxPerEpisode: 2, dedupeJaccard: 0.8 } })
  const agent = fakeAgent()
  for (let step = 1; step <= 6; step++) await runPreStep(ctx, { agent, messages: [userMsg(`m${step}`)], step })
  assert.equal(of(ctx, 'inject').length, 6) // every render that moved reaches the executor
  assert.deepEqual(of(ctx, 'skip'), [])
  // and successive renders really are near-duplicates under the metric that used to drop them
  const texts = of(ctx, 'inject').map(e => e.text)
  assert.ok(jaccard(texts.at(-2), texts.at(-1)) >= 0.8, String(jaccard(texts.at(-2), texts.at(-1))))
})

test('proactive-nobank never sends a bank and never keeps one', async () => {
  const ctx = makeCtx({ script: () => textChunks('<memory_save_knowledge id="k1">x</memory_save_knowledge>' + NOTE) })
  apply(ctx, { ...ARM, mode: 'proactive-nobank' })
  await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')] })
  const sent = textOf(ctx.calls[0].messages[0])
  assert.ok(!sent.includes('<memory_bank>'))
  assert.ok(!ctx.calls[0].system.includes('PHASE 1'))
})

test('a note that is nothing but markup is dropped, not injected empty', async () => {
  const ctx = makeCtx({ script: [textChunks('<context_for_action><tool_call>{"x":1}</tool_call></context_for_action>')] })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', messages: [...claimed] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: claimed, decision: base })
  assert.equal(out, base)
  assert.equal(of(ctx, 'skip').at(-1).why, 'empty')
})

test('a consult writes one trace line carrying the final verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-trace-'))
  const ctx = makeCtx({ script: [textChunks(NOTE), textChunks('<no_intervention/>')] })
  apply(ctx, { ...ARM, trace: { dir, console: false } })
  const agent = fakeAgent('trace-session')
  await runPreStep(ctx, { agent, messages: [userMsg('a')], step: 1 })
  await runPreStep(ctx, { agent, messages: [userMsg('b')], step: 2 })
  await setTimeout(50)
  const lines = (await readFile(join(dir, 'trace-session.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].injected, true)
  assert.equal(lines[1].injected, false)
  assert.ok(lines[0].system.includes('PHASE 1'))
  assert.ok(lines[0].user.includes('<transcript'))
  assert.equal(lines[0].usage.inputTokens, 100)
  await rm(dir, { recursive: true, force: true })
})

// 12 of the pilot's 1447 consults hit the deadline and left no trace line at all, so the JSONL was
// indistinguishable from a run where the plugin was simply never consulted at those steps.
test('a failed consult writes an error row carrying the prompts it had already built', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-trace-'))
  const ctx = makeCtx({ script: ['provider exploded', textChunks('<no_intervention/>')] })
  apply(ctx, { ...ARM, trace: { dir, console: false } })
  const agent = fakeAgent('err-session')
  await runPreStep(ctx, { agent, messages: [userMsg('cancel order W1')], step: 1 })
  await runPreStep(ctx, { agent, messages: [userMsg('b')], step: 2 })
  await setTimeout(50)
  const lines = (await readFile(join(dir, 'err-session.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 2) // the failure AND the success: one line per consult, always
  assert.deepEqual(Object.keys(lines[0]), ['turn', 'step', 'ms', 'code', 'message', 'system', 'user'])
  assert.equal(lines[0].step, 1)
  assert.ok(lines[0].message.includes('provider exploded'))
  assert.ok(lines[0].system.includes('PHASE 2'))
  assert.ok(lines[0].user.includes('cancel order W1'))
  assert.equal(typeof lines[0].ms, 'number')
  assert.equal(lines[1].injected, false) // the success row keeps its own shape
  await rm(dir, { recursive: true, force: true })
})

test('a timed-out consult writes an error row too, named by its abort reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-trace-'))
  const ctx = makeCtx()
  ctx.llm.stream = async function* (options) {
    ctx.calls.push(options)
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  apply(ctx, { ...ARM, model: { ...ARM.model, timeoutMs: 500 }, trace: { dir, console: false } })
  await runPreStep(ctx, { agent: fakeAgent('timeout-session'), messages: [userMsg('hi')], step: 1 })
  await setTimeout(50)
  const line = JSON.parse((await readFile(join(dir, 'timeout-session.jsonl'), 'utf8')).trim())
  assert.equal(line.code, 'TimeoutError')
  assert.ok(line.ms >= 400, String(line.ms))
  assert.ok(line.user.includes('<transcript'))
  await rm(dir, { recursive: true, force: true })
})

// ── the policy the memory model is judged against ─────────────────────────────────────────────
// Without it the prompt asks for "a rule of this domain" and a memory model invents one: 42 of the
// pilot's 48 procedural entries were verification rules retail's policy does not have.
test('policyFile is read once and rendered into every consult\'s system prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-policy-'))
  const file = join(dir, 'policy.md')
  await writeFile(file, 'Authenticate by locating the user id via email, or via name + zip code.\n', 'utf8')
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, policyFile: file })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('a')], step: 1 })
  await runPreStep(ctx, { agent, messages: [userMsg('b')], step: 2 })

  assert.ok(ctx.calls[0].system.includes('<policy>\nAuthenticate by locating the user id via email, or via name + zip code.\n</policy>'))
  assert.ok(ctx.calls[0].system.includes('It is your ONLY source of rules'))
  assert.equal(ctx.calls[0].system, ctx.calls[1].system) // constant per run: the prefix stays cacheable
  assert.ok(!textOf(ctx.calls[0].messages[0]).includes('<policy>')) // system prompt, not the user message
  await rm(dir, { recursive: true, force: true })
})

test('a missing policyFile warns and runs on without a policy', async () => {
  const warned = []
  const original = console.warn
  console.warn = m => warned.push(m)
  try {
    const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
    apply(ctx, { ...ARM, policyFile: '/nope/not/a/policy.md' })
    assert.equal(warned.length, 1) // once, at apply
    await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('a')], step: 1 })
    assert.equal(of(ctx, 'consult').length, 1) // the arm still runs
    assert.ok(!ctx.calls[0].system.includes('<policy>\n')) // no policy section — the tag is only ever mentioned
    assert.ok(ctx.calls[0].system.includes('write no `procedural` entries at all'))
    assert.equal(warned.length, 1)
  } finally {
    console.warn = original
  }
})

// ── <key_tool_calls>: the fact the window forgets ─────────────────────────────────────────────
// The pilot's dominant failure: find_user_id_by_* returned an id, the exchange scrolled out of the
// 8-message window, and the memory model went on demanding authentication for the rest of the run.
test('key tool calls are recorded with their results and outlive the transcript window', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, keyTools: ['find_user_id_by_name_zip'], window: { messages: 2 } })
  const agent = fakeAgent('s1', [])
  await runPreStep(ctx, { agent, messages: [userMsg('Yusuf Li, 91148')], step: 1 })

  const onResult = ctx.listeners.get('tools/result')[0]
  onResult(
    { agent, name: 'find_user_id_by_name_zip', arguments: { first_name: 'Yusuf', last_name: 'Li', zip: '91148' } },
    { isError: false, content: [{ type: 'text', text: 'yusuf_li_7255' }] },
  )
  onResult({ agent, name: 'get_order_details', arguments: { order_id: '#W1' } }, { isError: false, content: [{ type: 'text', text: 'not watched' }] })

  // the lookup is now far outside a 2-message window
  const log = [userMsg('Yusuf Li, 91148'), assistantMsg('thanks'), userMsg('and the speaker?'), assistantMsg('looking')]
  await runPreStep(ctx, { agent: fakeAgent('s1', log), messages: [userMsg('anything else?')], step: 2 })

  const sent = textOf(ctx.calls[1].messages[0])
  assert.ok(sent.includes('<key_tool_calls>\n- find_user_id_by_name_zip({"first_name":"Yusuf","last_name":"Li","zip":"91148"}) -> yusuf_li_7255\n</key_tool_calls>'), sent)
  assert.ok(!sent.includes('get_order_details')) // only the watched tools
  assert.ok(!sent.includes('91148"}) -> yusuf_li_7255\n- ')) // one line, one call
  assert.ok(!/"name": "find_user_id_by_name_zip"/.test(sent)) // and it is genuinely out of the window
})

test('a failed key tool call is marked, and long values are truncated', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, keyTools: ['find_user_id_by_email'] })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('hi')], step: 1 })
  const onResult = ctx.listeners.get('tools/result')[0]
  onResult(
    { agent, name: 'find_user_id_by_email', arguments: { email: 'x'.repeat(500) } },
    { isError: true, content: [{ type: 'text', text: `Error: user not found\n${'y'.repeat(500)}` }] },
  )
  await runPreStep(ctx, { agent, messages: [userMsg('again')], step: 2 })
  const line = /<key_tool_calls>\n- (.*)\n<\/key_tool_calls>/.exec(textOf(ctx.calls[1].messages[0]))[1]
  assert.ok(line.startsWith('find_user_id_by_email({"email":"xxx'))
  assert.ok(line.endsWith('[error]'), line)
  assert.ok(line.includes('chars cut'))
  assert.ok(line.length < 600, String(line.length))
  assert.equal(line.split('\n').length, 1) // never breaks the one-line-per-call shape
})

test('the key-tool log is capped, dropping the oldest calls', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, keyTools: ['lookup'] })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('hi')], step: 1 })
  const onResult = ctx.listeners.get('tools/result')[0]
  for (let i = 0; i < 25; i++) onResult({ agent, name: 'lookup', arguments: { i } }, { isError: false, content: [{ type: 'text', text: `r${i}` }] })
  await runPreStep(ctx, { agent, messages: [userMsg('again')], step: 2 })
  const section = /<key_tool_calls>\n([\s\S]*?)\n<\/key_tool_calls>/.exec(textOf(ctx.calls[1].messages[0]))[1]
  const lines = section.split('\n')
  assert.equal(lines.length, 20)
  assert.ok(lines[0].includes('-> r5'))
  assert.ok(lines.at(-1).includes('-> r24'))
})

test('the two write sections differ: recent_writes is consumed, executed_writes accumulates', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, writeTools: ['modify_order', 'cancel_order'] })
  const agent = fakeAgent()
  const preExec = ctx.listeners.get('tools/pre-execute')[0]
  await runPreStep(ctx, { agent, messages: [userMsg('hi')], step: 1 })
  assert.ok(textOf(ctx.calls[0].messages[0]).includes('<executed_writes>\n(none yet)\n</executed_writes>'))

  await preExec({ agent, name: 'modify_order', arguments: { id: 'W1' } }, async () => ({ kind: 'allow' }))
  await runPreStep(ctx, { agent, messages: [userMsg('ok')], step: 2 })
  await preExec({ agent, name: 'cancel_order', arguments: { id: 'W3' } }, async () => ({ kind: 'allow' }))
  await runPreStep(ctx, { agent, messages: [userMsg('ok')], step: 3 })

  const third = textOf(ctx.calls[2].messages[0])
  assert.ok(third.includes('<recent_writes>\ncancel_order {"id":"W3"}\n</recent_writes>'), third)
  assert.ok(third.includes('<executed_writes>\n- modify_order {"id":"W1"}\n- cancel_order {"id":"W3"}\n</executed_writes>'), third)
})

test('the cumulative sections are omitted entirely when nothing is configured to watch', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, ARM)
  await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')], step: 1 })
  const sent = textOf(ctx.calls[0].messages[0])
  assert.ok(!sent.includes('<key_tool_calls>'))
  assert.ok(!sent.includes('<executed_writes>'))
  assert.ok(sent.includes('<recent_writes>\nunknown\n</recent_writes>'))
})

// The whole bank is injected here, not a one-line note; on the note budget the render was cut
// mid-entry (215/335 of the pilot's injections) and the rules never made it in at all.
test('bankctx clips the rendered bank at its own budget, rules first', async () => {
  const long = 'The agent must list the action details and obtain an explicit yes before any database write. '.repeat(6)
  const ctx = makeCtx({ script: () => textChunks(`<memory_save_procedural id="p1">${long}</memory_save_procedural>`) })
  apply(ctx, { ...ARM, mode: 'bankctx', intervention: { maxChars: 400 }, bankctx: { maxChars: 1500 } })
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')], step: 1 })
  const text = textOf(reminderIn(out))
  assert.ok(text.includes('Rules to follow:'))
  assert.ok(text.length > 500, String(text.length)) // the note budget would have stopped at 400
  const body = /<context_for_action>\n([\s\S]*)\n<\/context_for_action>/.exec(text)[1]
  assert.ok(body.length <= 1500, String(body.length))
  assert.ok(body.startsWith('Rules to follow:')) // status last, so a clip cannot eat the rules
})

test('an unexpected throw anywhere after next() still returns the original decision', async () => {
  const ctx = makeCtx({ script: () => textChunks(NOTE) })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', get messages() { throw new Error('boom') } }
  const out = await preStepOf(ctx)({ agent: fakeAgent(), messages: claimed, turn: 1, step: 1, signal: AbortSignal.any([]) }, async () => base)
  assert.equal(out, base)
  assert.equal(of(ctx, 'error')[0].code, 'listener')
})

// The section can only ever report writes that already ran: tools/pre-execute fires as the call is
// dispatched, and the next consult happens at the pre-step after its result was logged.
test('tools/pre-execute only observes, and feeds <recent_writes>', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, writeTools: ['modify_order', 'cancel_order'] })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('hi')], step: 1 })

  const preExec = ctx.listeners.get('tools/pre-execute')[0]
  let nexted = false
  const decision = await preExec({ agent, name: 'modify_order', arguments: { id: 'W1' } }, async () => { nexted = true; return { kind: 'allow' } })
  assert.equal(nexted, true)
  assert.deepEqual(decision, { kind: 'allow' }) // observe only: never deny, never ask
  await preExec({ agent, name: 'get_order', arguments: { id: 'W2' } }, async () => ({ kind: 'allow' })) // not a write
  await preExec({ agent, name: 'cancel_order', arguments: { id: 'W3' } }, async () => ({ kind: 'allow' }))

  await runPreStep(ctx, { agent, messages: [userMsg('yes')], step: 2 })
  const sent = textOf(ctx.calls[1].messages[0])
  assert.ok(sent.includes('<recent_writes>\nmodify_order {"id":"W1"}\ncancel_order {"id":"W3"}\n</recent_writes>'), sent)

  // Consumed: the section covers the span since the previous consult, and writeTools is configured,
  // so an empty span reads `(none)` — a different answer from the unconfigured `unknown`.
  await runPreStep(ctx, { agent, messages: [userMsg('ok')], step: 3 })
  assert.ok(textOf(ctx.calls[2].messages[0]).includes('<recent_writes>\n(none)\n</recent_writes>'))
})

test('mode=always injects exactly once per model step across a whole episode', async () => {
  const ctx = makeCtx()
  apply(ctx, { mode: 'always', trace: { console: false }, alwaysText: 'CHECK YOURSELF' })
  const log = []
  const { modelSteps, injects } = await runEpisode(ctx, fakeAgent('s1', log), log, [
    { user: 'cancel order W1', steps: 4 },
    { user: 'yes, the keyboard', steps: 3 },
    { user: 'that is all', steps: 1 },
  ])
  assert.equal(modelSteps, 8)
  assert.equal(injects, 8) // one per model request, not one per user turn
  assert.equal(of(ctx, 'inject').length, 8)
  assert.deepEqual(of(ctx, 'inject').map(e => [e.turn, e.step]), [
    [1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [3, 1],
  ])
  assert.equal(ctx.llmCalls, 0)
  assert.deepEqual(of(ctx, 'skip'), [])
})

test('proactive consults on mid-turn steps, and the window carries the tool result that just arrived', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, schedule: { maxCallsPerEpisode: 100 } })
  const log = []
  const { modelSteps } = await runEpisode(ctx, fakeAgent('s1', log), log, [
    { user: 'cancel order W1', steps: 3 },
    { user: 'yes', steps: 2 },
  ])
  assert.equal(modelSteps, 5)
  assert.equal(ctx.llmCalls, 5) // one consult per model step
  assert.deepEqual(of(ctx, 'consult').map(e => [e.turn, e.step]), [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]])

  const midTurn = textOf(ctx.calls[1].messages[0]) // the consult at (turn 1, step 2)
  assert.ok(midTurn.includes('"role": "tool"'), midTurn)
  assert.ok(midTurn.includes('delivered'), midTurn) // the tool result step() logged a moment ago
  assert.ok(midTurn.includes('<transcript step="2"'), midTurn)
})

test('with no model configured it falls back to the executor default and warns once', async () => {
  const warned = []
  const original = console.warn
  console.warn = m => warned.push(m)
  try {
    const ctx = makeCtx({
      script: () => textChunks('<no_intervention/>'),
      services: { agentDefaultModel: { currentSelection: () => ({ provider: 'openrouter', model: 'executor-model' }) } },
    })
    apply(ctx, { mode: 'proactive', trace: { console: false } })
    const agent = fakeAgent()
    await runPreStep(ctx, { agent, messages: [userMsg('a')], step: 1 })
    await runPreStep(ctx, { agent, messages: [userMsg('b')], step: 2 })
    assert.equal(ctx.calls[0].model, 'executor-model')
    assert.equal(warned.length, 1)
    assert.ok(warned[0].includes('shares the executor model'))
  } finally {
    console.warn = original
  }
})
