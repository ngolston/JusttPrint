#!/usr/bin/env node
'use strict';

// Each AI service's whole path for Categories and AI Tagging (src/core/aitagging.js), against a
// stand-in server: the request carries the category list (and JSON mode only where the service
// takes it), the answer in that service's usual shape gives a place from the list, and asking for
// a category leaves the tag prompt as it was (it only adds the list).

const assert = require('assert');
const http = require('http');

// The AI code logs each request and answer; only the results matter here.
console.debug = () => {};
console.log = (
  (log) =>
  (...args) =>
    /^(ok|FAIL) /.test(String(args[0])) && log(...args)
)(console.log);

const aitagging = require('../src/core/aitagging');
const { matchAiCategory } = require('../src/core/categories');
const { CATEGORY_LIST } = require('../src/core/category-list');
const { chatTextOf } = require('../src/server/puter-ai-proxy');

// The fixed list as rows ({ id, name, parent_id }), as listCategories() gives it.
const list = [];
for (const main of CATEGORY_LIST) {
  const mainRow = { id: list.length + 1, name: main.name, parent_id: null };
  list.push(mainRow);
  for (const sub of main.subcategories) list.push({ id: list.length + 1, name: sub.name, parent_id: mainRow.id });
}
const byId = new Map(list.map((c) => [c.id, c]));
const choices = list.filter((c) => c.parent_id).map((c) => `${byId.get(c.parent_id).name} > ${c.name}`);
const placeOf = (answer) => {
  const sub = matchAiCategory(answer, list);
  return sub ? `${byId.get(sub.parent_id).name} > ${sub.name}` : null;
};

const json = '{"tags": ["Dragon", "Figure"], "category": "Miniatures > Creatures"}';
// What each service usually sends back for the same question.
const replies = {
  openai: json,
  claude: `Here is the JSON:\n\`\`\`json\n${json}\n\`\`\``,
  gemini: `\`\`\`json\n${json}\n\`\`\``,
  // A local model (Ollama, LM Studio) naming the Subcategory alone, loosely spelled.
  custom: '{"tags": ["dragon", "figure"], "category": "creatures"}'
};

let lastBody = null;
let reply = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    lastBody = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: lastBody.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }]
      })
    );
  });
});

const IMAGE = Buffer.from('not really a picture').toString('base64');
const promptOf = (body) => body.messages[0].content.find((part) => part.type === 'text').text;

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  let failed = false;
  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };

  for (const service of ['openai', 'claude', 'gemini', 'custom']) {
    await test(`${service}: the request has the category list, and the answer places the model`, async () => {
      aitagging.initializeOpenAI('test-key', baseURL, service);
      reply = replies[service];
      const tags = await aitagging.generateTagsForImage(IMAGE, null, { maxTags: 2, useJsonResponse: true, categoryChoices: choices }, 0, 1);
      const prompt = promptOf(lastBody);
      for (const choice of choices) assert.ok(prompt.includes(`"${choice}"`), `the prompt lists ${choice}`);
      assert.strictEqual(!!lastBody.response_format, service === 'openai' || service === 'custom', 'JSON mode only where the service takes it');
      assert.deepStrictEqual(
        [...tags].map((t) => t.toLowerCase()),
        ['dragon', 'figure']
      );
      assert.strictEqual(placeOf(tags.category), 'Miniatures > Creatures');
    });
  }

  await test('puter: the answer places the model (also when Claude answers in parts)', async () => {
    // Puter's results: a string, an OpenAI-style message, a Claude-style message in parts.
    const results = [json, { message: { role: 'assistant', content: json } }, { message: { role: 'assistant', content: [{ type: 'text', text: json }] } }];
    for (const result of results) {
      // What the page hands back: the proxy's text.
      const text = chatTextOf(result);
      let asked = '';
      aitagging.initializeOpenAI(null, null, 'puter', async (prompt) => {
        asked = prompt;
        return text;
      });
      const tags = await aitagging.generateTagsForImage(IMAGE, 'gpt-5-nano', { maxTags: 2, useJsonResponse: true, categoryChoices: choices }, 0, 1);
      assert.ok(asked.includes('"Miniatures > Creatures"'), 'the prompt lists the choices');
      assert.strictEqual(placeOf(tags.category), 'Miniatures > Creatures');
    }
  });

  await test('asking for a category keeps the tag prompt and only adds the list', async () => {
    aitagging.initializeOpenAI('test-key', baseURL, 'openai');
    reply = json;
    const options = { maxTags: 5, useJsonResponse: true };
    await aitagging.generateTagsForImage(IMAGE, null, options, 0, 1);
    const plain = promptOf(lastBody);
    await aitagging.generateTagsForImage(IMAGE, null, { ...options, categoryChoices: choices }, 0, 1);
    const withList = promptOf(lastBody);
    const tagPart = plain.slice(0, plain.indexOf('You MUST respond'));
    assert.ok(withList.startsWith(tagPart), 'the tag instructions come first, unchanged');
    assert.ok(withList.includes('Also sort the model into exactly one category'), 'then the category list');
  });

  await test('an answer outside the list places nothing', async () => {
    assert.strictEqual(placeOf('Dragons > Big Ones'), null);
    assert.strictEqual(placeOf(''), null);
  });

  server.close();
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FAIL ai-category-services:', error);
  process.exitCode = 1;
  server.close();
});
