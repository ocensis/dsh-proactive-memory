import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ALWAYS_TEXT, resolveConfig, scheduled } from '../src/config.mjs'
import { loadPrompt } from '../src/memory-agent.mjs'

test('defaults are off and safe', () => {
  const c = resolveConfig({})
  assert.equal(c.mode, 'off')
  assert.equal(c.protocol, 'text')
  assert.equal(c.model.provider, '')
  assert.equal(c.schedule.everySteps, 1)
  assert.equal(c.window.messages, 8)
  assert.equal(c.intervention.dedupeJaccard, 0.8)
  assert.equal(c.alwaysText, DEFAULT_ALWAYS_TEXT)
  assert.deepEqual(c.writeTools, [])
  assert.equal(c.trace.dir, '')
})

test('an unknown arm is loud, out-of-range numbers are clamped', () => {
  assert.throws(() => resolveConfig({ mode: 'proactiv' }))
  assert.throws(() => resolveConfig({ protocol: 'json' }))
  const c = resolveConfig({ schedule: { everySteps: 0 }, window: { messages: -5 }, intervention: { dedupeJaccard: 9 } })
  assert.equal(c.schedule.everySteps, 1)
  assert.equal(c.window.messages, 1)
  assert.equal(c.intervention.dedupeJaccard, 1)
})

test('firstStep, everySteps and maxCallsPerEpisode define the schedule', () => {
  const every3 = { firstStep: true, everySteps: 3 }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(n => scheduled(n, every3)), [true, false, false, true, false, false, true])
  assert.equal(scheduled(1, { firstStep: false, everySteps: 3 }), false)
  assert.equal(scheduled(4, { firstStep: false, everySteps: 3 }), true)
  assert.deepEqual([1, 2, 3].map(n => scheduled(n, { firstStep: true, everySteps: 1 })), [true, true, true])
})

test('the prompt keeps or drops regions per arm', () => {
  const base = { mode: 'proactive', model: { provider: 'p', model: 'm' } }
  const full = loadPrompt(resolveConfig(base))
  assert.ok(full.includes('PHASE 1'))
  assert.ok(full.includes('PHASE 2'))
  assert.ok(full.includes('memory_save_knowledge'))
  assert.ok(!full.includes('<!--'))
  assert.ok(full.includes('At most 6 edits'))
  assert.ok(full.includes('at most 400 characters'))

  const nobank = loadPrompt(resolveConfig({ ...base, mode: 'proactive-nobank' }))
  assert.ok(!nobank.includes('PHASE 1'))
  assert.ok(!nobank.includes('memory_save_knowledge'))
  assert.ok(nobank.includes('PHASE 2'))

  const bankctx = loadPrompt(resolveConfig({ ...base, mode: 'bankctx' }))
  assert.ok(bankctx.includes('PHASE 1'))
  assert.ok(!bankctx.includes('PHASE 2'))
  assert.ok(!bankctx.includes('no_intervention'))

  const tools = loadPrompt(resolveConfig({ ...base, protocol: 'tools' }))
  assert.ok(tools.includes('PHASE 1'))
  assert.ok(!tools.includes('<memory_save_knowledge'))

  assert.ok(loadPrompt(resolveConfig({ ...base, locale: 'zh' })).includes('阶段一'))
})
