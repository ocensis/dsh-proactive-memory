import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_ALWAYS_TEXT, resolveConfig, scheduled } from '../src/config.mjs'
import { buildSystem, loadPrompt, readPolicy } from '../src/memory-agent.mjs'

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
  assert.deepEqual(c.keyTools, [])
  assert.equal(c.policyFile, '')
  assert.equal(c.bankctx.maxChars, 1500)
  assert.equal(c.trace.dir, '')
})

test('bankctx has its own clip budget, clamped like every other number', () => {
  assert.equal(resolveConfig({ bankctx: { maxChars: 4000 } }).bankctx.maxChars, 4000)
  assert.equal(resolveConfig({ bankctx: { maxChars: 0 } }).bankctx.maxChars, 20)
  assert.equal(resolveConfig({ bankctx: { maxChars: 1e9 } }).bankctx.maxChars, 20000)
  // and it is independent of the note budget
  const c = resolveConfig({ intervention: { maxChars: 400 }, bankctx: { maxChars: 1500 } })
  assert.equal(c.intervention.maxChars, 400)
  assert.equal(c.bankctx.maxChars, 1500)
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

test('the prompt describes every section the model is actually sent', () => {
  const base = { mode: 'proactive', model: { provider: 'p', model: 'm' } }
  for (const locale of ['en', 'zh']) {
    const p = loadPrompt(resolveConfig({ ...base, locale }))
    for (const section of ['<task>', '<memory_bank>', '<already_told_the_agent>', '<key_tool_calls>', '<executed_writes>', '<transcript>', '<recent_writes>']) {
      assert.ok(p.includes(section), `${locale}: ${section}`)
    }
  }
  // …and the bank sections travel with the bank region
  const nobank = loadPrompt(resolveConfig({ ...base, mode: 'proactive-nobank' }))
  assert.ok(!nobank.includes('<memory_bank>'))
  assert.ok(nobank.includes('<key_tool_calls>'))
})

test('PHASE 2 names four triggers and forbids the invented-precondition nag', () => {
  const p = loadPrompt(resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' } }))
  assert.ok(p.includes('exactly four reasons'))
  assert.ok(p.includes('security question')) // named, as something never to demand
  assert.ok(/Never demand a verification step, a tool or a precondition that `<policy>` does not state/.test(p))
  assert.ok(p.includes('that lookup SUCCEEDED'))
  // the only worked positive example is a fact gap, and the identity nag appears only as a negative
  assert.ok(p.includes('does not contain item 5551'))
  assert.ok(/do NOT write "You have not verified the user's identity"/.test(p))
  const zh = loadPrompt(resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' }, locale: 'zh' }))
  assert.ok(zh.includes('只有四条'))
  assert.ok(zh.includes('不要**再写"你还没核验用户身份"') || zh.includes('就**不要**再写"你还没核验用户身份"'))
})

test('the policy region appears only when a policy was read, and is substituted verbatim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-policy-'))
  try {
    const file = join(dir, 'policy.md')
    // `$&` and `$'` are replacement patterns: a policy carrying them must still land byte for byte.
    const body = 'Authenticate by locating the user id via email, or via name + zip code.\nCosts $& and $\' stay literal.'
    await writeFile(file, `${body}\n`, 'utf8')

    const cfg = resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' }, policyFile: file })
    const policy = readPolicy(cfg)
    assert.equal(policy, body)

    const withPolicy = buildSystem(cfg, policy)
    assert.ok(withPolicy.includes('<policy>\nAuthenticate by locating the user id via email'))
    assert.ok(withPolicy.includes("Costs $& and $' stay literal."))
    assert.ok(withPolicy.includes('It is your ONLY source of rules'))
    assert.ok(!withPolicy.includes('{{policy}}'))

    const without = buildSystem(cfg, '')
    assert.ok(!without.includes('<policy>\n'))
    assert.ok(!without.includes('{{policy}}'))
    assert.ok(without.includes('write no `procedural` entries at all')) // the arm without a policy
    // the two are cached apart, not one bleeding into the other
    assert.notEqual(withPolicy, without)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable policyFile warns loudly and yields no policy, never a throw', async () => {
  const warned = []
  const original = console.warn
  console.warn = m => warned.push(m)
  try {
    const cfg = resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' }, policyFile: '/nope/definitely/not/here.md' })
    assert.equal(readPolicy(cfg), '')
    assert.equal(warned.length, 1)
    assert.ok(warned[0].includes('WARNING'))
    assert.ok(warned[0].includes('/nope/definitely/not/here.md'))
    assert.equal(readPolicy(resolveConfig({ mode: 'proactive', model: { provider: 'p', model: 'm' } })), '') // unset: silent
    assert.equal(warned.length, 1)
  } finally {
    console.warn = original
  }
})
