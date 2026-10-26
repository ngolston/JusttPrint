#!/usr/bin/env node
'use strict';

// Puter that cannot answer is not retried, and a run stops at the first such answer (src/core/aitagging.js PUTER_STOP).

const assert = require('assert');
const aitagging = require('../src/core/aitagging');
const { chatTextOf, cutOff, emptyAnswerError } = require('../src/server/puter-ai-proxy');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

(async () => {
  await test('the messages that stop a run', () => {
    for (const message of [
      'Not signed in to Puter: the sign-in was not finished within 2 minutes.',
      'Puter sign-in was cancelled.',
      'No JusttPrint page is open to ask Puter: keep one open.',
      'Puter did not answer in time: keep a JusttPrint page open.'
    ])
      assert.ok(aitagging.PUTER_STOP.test(message), message);
    assert.ok(!aitagging.PUTER_STOP.test('Network error: Unable to connect'), 'a network error is retried');
  });

  await test('"not signed in" is asked once, not retried', async () => {
    let calls = 0;
    aitagging.initializeOpenAI('', '', 'puter', async () => {
      calls++;
      throw new Error('Not signed in to Puter: the sign-in was not finished within 2 minutes.');
    });
    await assert.rejects(aitagging.generateTagsForImage('aGVsbG8=', 'gpt-5-nano', { maxTags: 3 }, 0, 5), /Not signed in to Puter/);
    assert.strictEqual(calls, 1);
  });

  await test('other Puter errors are still retried', async () => {
    let calls = 0;
    aitagging.initializeOpenAI('', '', 'puter', async () => {
      calls++;
      if (calls < 2) throw new Error('Network error');
      return '{"tags":["robot"]}';
    });
    const tags = await aitagging.generateTagsForImage('aGVsbG8=', 'gpt-5-nano', { maxTags: 3, useJsonResponse: true }, 0, 3);
    assert.strictEqual(calls, 2);
    assert.ok(tags.includes('robot'), JSON.stringify(tags));
  });

  // 9.7.2: gpt-5-nano used its reply limit thinking; the whole result became the tags "length" and "max_tokens".
  const cutOffResult = { message: { role: 'assistant', content: '' }, finish_reason: 'length', usage: { max_tokens: 2000 } };

  await test('a result without text is no answer, not its JSON', () => {
    assert.strictEqual(chatTextOf(cutOffResult), '');
    assert.strictEqual(chatTextOf({ message: { role: 'assistant', content: [] } }), '');
    assert.strictEqual(chatTextOf({ message: { content: '{"tags":["robot"]}' } }), '{"tags":["robot"]}');
  });

  await test('a cut-off answer says so; any empty answer matches EMPTY_ANSWER', () => {
    assert.ok(cutOff(cutOffResult));
    assert.ok(cutOff({ stop_reason: 'max_tokens', message: { content: [] } }));
    assert.ok(!cutOff({ message: { content: '' }, finish_reason: 'stop' }));
    assert.match(emptyAnswerError(cutOffResult), /ran out of room/);
    for (const result of [cutOffResult, { message: { content: '' } }]) assert.ok(aitagging.EMPTY_ANSWER.test(emptyAnswerError(result)));
  });

  await test('an empty Puter answer is an error, tried twice, never tags', async () => {
    for (const answer of ['', '   ', { usage: { max_tokens: 2000 }, finish_reason: 'length' }]) {
      let calls = 0;
      aitagging.initializeOpenAI('', '', 'puter', async () => {
        calls++;
        return answer;
      });
      await assert.rejects(aitagging.generateTagsForImage('aGVsbG8=', 'gpt-5-nano', { maxTags: 3, useJsonResponse: true }, 0, 5), aitagging.EMPTY_ANSWER);
      assert.strictEqual(calls, 2, JSON.stringify(answer));
    }
  });

  await test("the proxy's empty-answer error is tried once more, then shown", async () => {
    let calls = 0;
    aitagging.initializeOpenAI('', '', 'puter', async () => {
      calls++;
      throw new Error(emptyAnswerError(cutOffResult));
    });
    await assert.rejects(aitagging.generateTagsForImage('aGVsbG8=', 'gpt-5-nano', { maxTags: 3 }, 0, 5), /ran out of room/);
    assert.strictEqual(calls, 2);
  });

  await test('a second try that answers gives its tags', async () => {
    let calls = 0;
    aitagging.initializeOpenAI('', '', 'puter', async () => (++calls === 1 ? '' : '{"tags":["robot"]}'));
    const tags = await aitagging.generateTagsForImage('aGVsbG8=', 'gpt-5-nano', { maxTags: 3, useJsonResponse: true }, 0, 5);
    assert.ok(tags.includes('robot'), JSON.stringify(tags));
  });
})();
