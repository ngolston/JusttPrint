#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { completionOptions } = require('../src/core/aitagging');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const tagging = { maxTokens: 1000, temperature: 0.3 };

test('OpenAI sends max_completion_tokens and the temperature', () => {
  assert.deepStrictEqual(completionOptions('openai', 'gpt-4o-mini', tagging), { max_completion_tokens: 1000, temperature: 0.3 });
});

test('OpenAI reasoning models get no temperature and room to reason', () => {
  for (const model of ['gpt-5-nano', 'gpt-5.1', 'o3-mini', 'o4-mini', 'openai/gpt-5-mini']) {
    assert.deepStrictEqual(completionOptions('openai', model, tagging), { max_completion_tokens: 4000 }, model);
  }
  assert.deepStrictEqual(completionOptions('openai', 'gpt-5-nano', { maxTokens: 50 }), { max_completion_tokens: 4000 });
});

test('Claude and local servers keep max_tokens', () => {
  assert.deepStrictEqual(completionOptions('claude', 'claude-haiku-4-5', tagging), { max_tokens: 1000, temperature: 0.3 });
  assert.deepStrictEqual(completionOptions('custom', 'llava', tagging), { max_tokens: 1000, temperature: 0.3 });
});

test('a gpt-5 model behind a custom endpoint gets the reasoning rules', () => {
  assert.deepStrictEqual(completionOptions('custom', 'gpt-5-mini', tagging), { max_completion_tokens: 4000 });
});

test('Gemini gets no reply limit', () => {
  assert.deepStrictEqual(completionOptions('gemini', 'gemini-2.5-flash', tagging), { temperature: 0.3 });
  assert.deepStrictEqual(completionOptions('gemini', 'gemini-2.5-flash', { maxTokens: 50 }), {});
});
