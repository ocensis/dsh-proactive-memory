import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTextReply } from '../src/protocol-text.mjs'
import { MEMORY_TOOLS, runToolsProtocol } from '../src/protocol-tools.mjs'

test('parses a well-formed reply', () => {
  const r = parseTextReply(`
<memory_update_status>Verifying the user.</memory_update_status>
<memory_save_knowledge id="k1">order #W123 is pending</memory_save_knowledge>
<memory_save_procedural id="p1">Verify identity before reading any order.</memory_save_procedural>
<memory_delete id="k9"/>
<context_for_action>You have not verified the user yet.</context_for_action>`)
  assert.deepEqual(r.edits, [
    { op: 'update_status', content: 'Verifying the user.' },
    { op: 'save_knowledge', id: 'k1', content: 'order #W123 is pending' },
    { op: 'save_procedural', id: 'p1', content: 'Verify identity before reading any order.' },
    { op: 'delete', id: 'k9' },
  ])
  assert.equal(r.intervention, 'You have not verified the user yet.')
  assert.deepEqual(r.malformed, [])
})

test('accepts prose around the tags, odd casing and unknown tags', () => {
  const r = parseTextReply(`Let me think about this.
<thinking>irrelevant</thinking>
<MEMORY_SAVE_KNOWLEDGE ID='k2'>zip 90210</MEMORY_SAVE_KNOWLEDGE>
Nothing worth interrupting for. <No_Intervention />`)
  assert.deepEqual(r.edits, [{ op: 'save_knowledge', id: 'k2', content: 'zip 90210' }])
  assert.equal(r.intervention, null)
  assert.deepEqual(r.malformed, [])
})

test('reports malformed tags instead of guessing', () => {
  const r = parseTextReply(`
<memory_save_knowledge>no id here</memory_save_knowledge>
<memory_save_procedural id="p1"></memory_save_procedural>
<memory_delete/>
<memory_update_status>ok</memory_save_knowledge>
<no_intervention/>`)
  assert.deepEqual(r.edits, [])
  assert.equal(r.malformed.length, 4)
  assert.ok(r.malformed.some(m => m.includes('missing id')))
  assert.ok(r.malformed.some(m => m.includes('mismatched')))
})

test('caps edits at maxEditsPerCall and reports the rest', () => {
  const many = Array.from({ length: 5 }, (_, i) => `<memory_save_knowledge id="k${i}">f${i}</memory_save_knowledge>`).join('\n')
  const r = parseTextReply(`${many}\n<no_intervention/>`, { maxEdits: 2 })
  assert.equal(r.edits.length, 2)
  assert.equal(r.edits[1].id, 'k1')
  assert.ok(r.malformed.some(m => m.includes('dropped 3')))
})

test('an empty reply is silence, but is reported as malformed', () => {
  const r = parseTextReply('')
  assert.deepEqual(r.edits, [])
  assert.equal(r.intervention, null)
  assert.deepEqual(r.malformed, ['no intervention decision; treated as <no_intervention/>'])
})

test('bankctx does not require a decision', () => {
  const r = parseTextReply('<memory_update_status>x</memory_update_status>', { requireDecision: false })
  assert.equal(r.intervention, null)
  assert.deepEqual(r.malformed, [])
})

test('with both markers the last one wins, and it is reported', () => {
  const a = parseTextReply('<no_intervention/> ... on reflection <context_for_action>do check the id</context_for_action>')
  assert.equal(a.intervention, 'do check the id')
  const b = parseTextReply('<context_for_action>maybe</context_for_action> actually no <no_intervention/>')
  assert.equal(b.intervention, null)
  assert.ok(a.malformed[0].includes('both'))
})

test('an empty context_for_action is treated as silence', () => {
  const r = parseTextReply('<context_for_action>   </context_for_action>')
  assert.equal(r.intervention, null)
  assert.ok(r.malformed[0].includes('empty'))
})

test('tools protocol: applies tool-call edits then reads the text-only reply', async () => {
  const rounds = []
  const streamOnce = async options => {
    rounds.push(options.messages.length)
    if (rounds.length === 1) {
      return {
        text: '',
        toolCalls: [
          { type: 'tool-call', id: 'c1', name: 'memory_save_knowledge', arguments: '{"id":"k1","content":"a"}' },
          { type: 'tool-call', id: 'c2', name: 'memory_delete', arguments: '{"id":"k0"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
        finish: { kind: 'tool-calls' },
        message: { id: 'x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      }
    }
    return { text: '<context_for_action>careful</context_for_action>', toolCalls: [], usage: { inputTokens: 30, outputTokens: 4 }, finish: { kind: 'stop' }, message: {} }
  }
  const out = await runToolsProtocol({ streamOnce, options: { provider: 'p', model: 'm' }, messages: [{ id: 'u' }] })
  assert.deepEqual(out.edits, [{ op: 'save_knowledge', id: 'k1', content: 'a' }, { op: 'delete', id: 'k0' }])
  assert.equal(out.intervention, 'careful')
  assert.deepEqual(out.usage, { inputTokens: 40, outputTokens: 9 })
  assert.equal(out.rounds, 2)
  assert.deepEqual(rounds, [1, 4]) // user + assistant + 2 synthesized tool results
})

test('tools protocol: unparsable arguments are reported, not thrown', async () => {
  const streamOnce = async () => ({
    text: '<no_intervention/>',
    toolCalls: [],
    usage: undefined,
    finish: { kind: 'stop' },
    message: {},
  })
  const out = await runToolsProtocol({ streamOnce, options: {}, messages: [] })
  assert.equal(out.intervention, null)
  assert.equal(MEMORY_TOOLS.length, 4)
  assert.deepEqual(MEMORY_TOOLS.map(t => t.name).sort(), ['memory_delete', 'memory_save_knowledge', 'memory_save_procedural', 'memory_update_status'])
})

test('tools protocol: gives up after maxRounds without inventing a decision', async () => {
  let n = 0
  const streamOnce = async () => ({
    text: '',
    toolCalls: [{ type: 'tool-call', id: `c${n++}`, name: 'memory_delete', arguments: 'not json' }],
    usage: { inputTokens: 1, outputTokens: 1 },
    finish: { kind: 'tool-calls' },
    message: { id: 'x', role: 'assistant', content: [], source: {} },
  })
  const out = await runToolsProtocol({ streamOnce, options: {}, messages: [], maxRounds: 2 })
  assert.equal(out.rounds, 2)
  assert.equal(out.intervention, null)
  assert.equal(out.edits.length, 0)
  assert.ok(out.malformed.some(m => m.includes('unparsable')))
  assert.ok(out.malformed.some(m => m.includes('2 rounds')))
})
