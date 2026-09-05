import assert from 'node:assert/strict'
import test from 'node:test'
import { applyEdits, createBank, renderBank } from '../src/bank.mjs'

const LIMITS = { maxKnowledge: 3, maxProcedural: 3, maxEditsPerCall: 6 }

test('a reused id overwrites in place', () => {
  const bank = createBank()
  applyEdits(bank, [
    { op: 'save_knowledge', id: 'k1', content: 'first' },
    { op: 'save_knowledge', id: 'k2', content: 'second' },
    { op: 'save_knowledge', id: 'k1', content: 'corrected' },
  ], LIMITS)
  assert.deepEqual(bank.knowledge, [{ id: 'k1', content: 'corrected' }, { id: 'k2', content: 'second' }])
})

test('delete removes from either list and reports a miss', () => {
  const bank = createBank()
  applyEdits(bank, [{ op: 'save_procedural', id: 'p1', content: 'r' }], LIMITS)
  const r = applyEdits(bank, [{ op: 'delete', id: 'p1' }, { op: 'delete', id: 'nope' }], LIMITS)
  assert.deepEqual(bank.procedural, [])
  assert.equal(r.applied, 1)
  assert.ok(r.rejected[0].includes('not found'))
})

test('over the cap the oldest entry is dropped', () => {
  const bank = createBank()
  const r = applyEdits(bank, [1, 2, 3, 4].map(i => ({ op: 'save_knowledge', id: `k${i}`, content: `f${i}` })), LIMITS)
  assert.deepEqual(bank.knowledge.map(e => e.id), ['k2', 'k3', 'k4'])
  assert.ok(r.rejected.some(m => m.includes('dropped oldest [k1]')))
})

test('status is one string, and malformed edits are rejected not applied', () => {
  const bank = createBank()
  const r = applyEdits(bank, [
    { op: 'update_status', content: '  checking identity ' },
    { op: 'update_status', content: '   ' },
    { op: 'save_knowledge', content: 'no id' },
    { op: 'nonsense' },
  ], LIMITS)
  assert.equal(bank.status, 'checking identity')
  assert.equal(r.applied, 1)
  assert.equal(r.rejected.length, 3)
})

test('banks are isolated by the caller keying them per agent id', () => {
  const states = new Map([['s1', createBank()], ['s2', createBank()]])
  applyEdits(states.get('s1'), [{ op: 'save_knowledge', id: 'k1', content: 'only s1' }], LIMITS)
  assert.equal(states.get('s1').knowledge.length, 1)
  assert.equal(states.get('s2').knowledge.length, 0)
})

test('renderBank is empty for an empty bank and deterministic otherwise', () => {
  const bank = createBank()
  assert.equal(renderBank(bank), '')
  applyEdits(bank, [
    { op: 'update_status', content: 'mid-refund' },
    { op: 'save_knowledge', id: 'k1', content: 'order #W1 delivered' },
  ], LIMITS)
  assert.equal(renderBank(bank), 'Status: mid-refund\nKnown facts:\n- [k1] order #W1 delivered\nRules to follow: (none)')
  assert.equal(renderBank(bank, { ids: false }), 'Status: mid-refund\nKnown facts:\n- order #W1 delivered\nRules to follow: (none)')
  assert.equal(renderBank(bank), renderBank(bank))
})
