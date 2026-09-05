import assert from 'node:assert/strict'
import test from 'node:test'
import { TOOL_RESULT_CUT_NOTE, buildWindow, middleTruncate } from '../src/window.mjs'
import { assistantMsg, cfg, pluginMsg, toolMsg, userMsg } from './helpers.mjs'

test('keeps only the tail of the transcript', () => {
  const c = cfg({ window: { messages: 3 } })
  const derived = [userMsg('task'), assistantMsg('a1'), assistantMsg('a2'), assistantMsg('a3'), assistantMsg('a4')]
  const { transcript, task } = buildWindow(derived, [], c)
  assert.equal(task, 'task')
  assert.deepEqual(transcript.map(r => r.text), ['a2', 'a3', 'a4'])
})

test('plugin-sourced messages are excluded and our own notes come back as alreadyTold', () => {
  const c = cfg()
  const derived = [
    userMsg('task'),
    pluginMsg('<system-reminder>\nblah\n<context_for_action>\ncheck the id first\n</context_for_action>\n</system-reminder>'),
    pluginMsg('runtime context snapshot', 'dsh-runtime-context'),
    assistantMsg('ok'),
  ]
  const { transcript, alreadyTold } = buildWindow(derived, [], c)
  assert.deepEqual(transcript.map(r => r.text), ['task', 'ok'])
  assert.deepEqual(alreadyTold, ['check the id first'])
})

test('claimed messages are appended: the memory model must see the turn being answered', () => {
  const c = cfg()
  const { transcript } = buildWindow([userMsg('task'), assistantMsg('hi')], [userMsg('now refund it')], c)
  assert.equal(transcript.at(-1).text, 'now refund it')
  assert.equal(transcript.at(-1).role, 'user')
})

test('the task falls back to the claimed messages when the log has no user message yet', () => {
  assert.equal(buildWindow([], [userMsg('first ever turn')], cfg()).task, 'first ever turn')
  assert.equal(buildWindow([], [], cfg()).task, '')
})

test('tool calls and results are serialized and middle-truncated', () => {
  const c = cfg({ window: { toolResultChars: 60, argChars: 40 } })
  const long = 'x'.repeat(500)
  const derived = [
    assistantMsg('calling', [{ name: 'get_order', arguments: JSON.stringify({ id: long }) }]),
    toolMsg('c0', long, true),
  ]
  const { transcript } = buildWindow(derived, [], c)
  assert.deepEqual(transcript[0].tool_calls[0].name, 'get_order')
  assert.ok(transcript[0].tool_calls[0].arguments.includes('chars cut'))
  assert.ok(transcript[0].tool_calls[0].arguments.length < 90)
  assert.equal(transcript[1].role, 'tool')
  assert.equal(transcript[1].tool_result.is_error, true)
  assert.ok(transcript[1].tool_result.text.includes('chars cut'))
})

test('only a truncated tool result says that a truncation is not an absence', () => {
  const c = cfg({ window: { toolResultChars: 60, argChars: 40 } })
  const long = 'x'.repeat(500)
  const derived = [
    assistantMsg(long, [{ name: 'get_product_details', arguments: JSON.stringify({ id: long }) }]),
    toolMsg('c0', long),
  ]
  const { transcript } = buildWindow(derived, [], c)
  // the marker the memory model is told to read as "the middle was cut, absence proves nothing"
  assert.ok(transcript[1].tool_result.text.includes(`chars cut — ${TOOL_RESULT_CUT_NOTE}`))
  // …and nothing else carries it: an argument or a message text truncated the same way stays terse
  assert.ok(!transcript[0].tool_calls[0].arguments.includes(TOOL_RESULT_CUT_NOTE))
  assert.ok(transcript[0].tool_calls[0].arguments.includes('chars cut'))
  assert.ok(!transcript[0].text.includes(TOOL_RESULT_CUT_NOTE))
  // an untruncated result is left exactly as the tool returned it, marker-free
  const { transcript: whole } = buildWindow([toolMsg('c1', 'item_ids: 7777, 8888')], [], c)
  assert.equal(whole[0].tool_result.text, 'item_ids: 7777, 8888')
})

test('empty messages are dropped and the result is JSON-framable', () => {
  const derived = [assistantMsg(''), userMsg('real')]
  const { transcript } = buildWindow(derived, [], cfg())
  assert.equal(transcript.length, 1)
  assert.equal(JSON.parse(JSON.stringify(transcript))[0].text, 'real')
})

test('middleTruncate keeps both ends and says how much it cut', () => {
  assert.equal(middleTruncate('short', 10), 'short')
  const out = middleTruncate('abcdefghij'.repeat(10), 20)
  assert.ok(out.startsWith('abcdefghij'))
  assert.ok(out.endsWith('bcdefghij'))
  assert.ok(out.includes('[80 chars cut]'))
  // the note goes inside the marker, and only when one is asked for
  const noted = middleTruncate('abcdefghij'.repeat(10), 20, TOOL_RESULT_CUT_NOTE)
  assert.ok(noted.includes('[80 chars cut — result truncated, do not infer absence]'))
  assert.equal(middleTruncate('short', 10, TOOL_RESULT_CUT_NOTE), 'short')
})
