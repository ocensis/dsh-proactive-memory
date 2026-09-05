// The pre-step listener under a fake ctx. Everything here is offline: no API key, no dsh runtime.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { apply } from '../src/index.mjs'
import { assistantMsg, fakeAgent, makeCtx, pluginMsg, preStepOf, reminderIn, runPreStep, textChunks, textOf, toolChunks, userMsg } from './helpers.mjs'

const ARM = { mode: 'proactive', model: { provider: 'openrouter', model: 'cheap' }, trace: { console: false } }
const NOTE = '<context_for_action>You have not verified the user yet.</context_for_action>'
const kinds = ctx => ctx.events.map(e => e.payload.kind)
const of = (ctx, kind) => ctx.events.map(e => e.payload).filter(e => e.kind === kind)

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

test('an empty claimed list is returned untouched and costs no model call (rule R1)', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const base = { kind: 'enter', messages: [pluginMsg('runtime context', 'x')] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [], decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
  assert.deepEqual(kinds(ctx), [])
})

test('an empty decision is returned untouched: splicing there would manufacture a request', async () => {
  const ctx = makeCtx({ script: [textChunks(NOTE)] })
  apply(ctx, ARM)
  const base = { kind: 'enter', messages: [] }
  const out = await runPreStep(ctx, { agent: fakeAgent(), messages: [userMsg('hi')], decision: base })
  assert.equal(out, base)
  assert.equal(ctx.llmCalls, 0)
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
  assert.ok(textOf(reminder).includes('You have not verified the user yet.'))
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
  assert.ok(sent.includes('<about_to_act>\nunknown\n</about_to_act>'))
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

test('an unexpected throw anywhere after next() still returns the original decision', async () => {
  const ctx = makeCtx({ script: () => textChunks(NOTE) })
  apply(ctx, ARM)
  const claimed = [userMsg('hi')]
  const base = { kind: 'enter', get messages() { throw new Error('boom') } }
  const out = await preStepOf(ctx)({ agent: fakeAgent(), messages: claimed, turn: 1, step: 1, signal: AbortSignal.any([]) }, async () => base)
  assert.equal(out, base)
  assert.equal(of(ctx, 'error')[0].code, 'listener')
})

test('tools/pre-execute only observes, and feeds <about_to_act>', async () => {
  const ctx = makeCtx({ script: () => textChunks('<no_intervention/>') })
  apply(ctx, { ...ARM, writeTools: ['modify_order'] })
  const agent = fakeAgent()
  await runPreStep(ctx, { agent, messages: [userMsg('hi')], step: 1 })

  const preExec = ctx.listeners.get('tools/pre-execute')[0]
  let nexted = false
  const decision = await preExec({ agent, name: 'modify_order', arguments: { id: 'W1' } }, async () => { nexted = true; return { kind: 'allow' } })
  assert.equal(nexted, true)
  assert.deepEqual(decision, { kind: 'allow' }) // observe only: never deny, never ask
  await preExec({ agent, name: 'get_order', arguments: { id: 'W2' } }, async () => ({ kind: 'allow' }))

  await runPreStep(ctx, { agent, messages: [userMsg('yes')], step: 2 })
  const sent = textOf(ctx.calls[1].messages[0])
  assert.ok(sent.includes('<about_to_act>\nmodify_order {"id":"W1"}'), sent)

  await runPreStep(ctx, { agent, messages: [userMsg('ok')], step: 3 })
  assert.ok(textOf(ctx.calls[2].messages[0]).includes('<about_to_act>\nunknown')) // consumed
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
