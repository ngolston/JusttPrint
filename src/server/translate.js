'use strict';

/**
 * English names for MakerWorld file names (腿部.stl → Legs), the way Settings → MakerWorld says:
 * 'free' asks MyMemory (a free translation service, no account), 'ai' asks the AI service set up
 * for AI Tagging, 'off' does not translate. Names already in Latin script are left as they are.
 */

const OpenAI = require('openai');
const { needsTranslation } = require('../core/makerworld');
const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');

const MODES = ['free', 'ai', 'off'];
const DEFAULT_MODE = 'free';
const SETTING_KEY = 'makerWorldTranslation';
// MyMemory takes up to 500 bytes per request.
const FREE_BATCH_BYTES = 450;
const TIMEOUT_MS = 20000;

const modeOf = (value) => (MODES.includes(value) ? value : DEFAULT_MODE);

/** Split texts into batches of at most `limit` bytes, one text per line. */
function batches(texts, limit) {
  const out = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    const bytes = Buffer.byteLength(text, 'utf8') + 1;
    if (current.length && size + bytes > limit) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

/** MyMemory, one request per batch of lines; the language is detected. */
async function translateFree(texts, fetchImpl = httpsFetch) {
  const result = [];
  for (const batch of batches(texts, FREE_BATCH_BYTES)) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(batch.join('\n'))}&langpair=${encodeURIComponent('Autodetect|en')}`;
    const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = JSON.parse((await readLimited(response, 1024 * 1024)).toString('utf8'));
    if (!response.ok || Number(body.responseStatus) !== 200) {
      throw new Error(body.responseDetails ? `MyMemory: ${body.responseDetails}` : `MyMemory answered ${response.status}`);
    }
    const lines = String(body.responseData && body.responseData.translatedText || '').split('\n');
    // A batch that comes back with a different number of lines is translated name by name.
    if (lines.length === batch.length) result.push(...lines);
    else if (batch.length > 1) for (const text of batch) result.push(...await translateFree([text], fetchImpl));
    else result.push(lines.join(' '));
  }
  return result;
}

const PROMPT = (texts) => `Translate each of these 3D model file names into short, natural English. Answer with only a JSON array of strings, the same length and order as the input, nothing else.\n\n${JSON.stringify(texts)}`;

/** The AI's answer → its JSON array of names, or throws. */
function parseAiAnswer(content, count) {
  const text = typeof content === 'string' ? content
    : (content && (content.message && content.message.content || content.text || content.content)) || '';
  const match = /\[[\s\S]*\]/.exec(String(text));
  const list = match ? JSON.parse(match[0]) : null;
  if (!Array.isArray(list) || list.length !== count) throw new Error('The AI service did not answer with the translations');
  return list.map((item) => String(item ?? ''));
}

/** The AI service from AI Tagging (Puter runs in the browser that asked). */
async function translateAi(texts, { aiSettings, puterHandler }) {
  const { apiKey, apiEndpoint, aiModel, aiService } = aiSettings;
  const service = String(aiService || 'openai').toLowerCase();
  if (service === 'puter') {
    if (!puterHandler) throw new Error('Puter runs in the browser: open the model in a browser to translate');
    return parseAiAnswer(await puterHandler(PROMPT(texts), null, aiModel || 'gpt-5-nano'), texts.length);
  }
  const { completionOptions, defaultBaseURLForService, defaultModelForService, requiresApiKey } = require('../core/aitagging');
  if (requiresApiKey(service, apiEndpoint) && !apiKey) throw new Error('The AI service has no API key (Settings → AI Tagging)');
  const endpoint = apiEndpoint && !/puter\.com/i.test(apiEndpoint) ? `${apiEndpoint.trim().replace(/\/+$/, '')}/` : defaultBaseURLForService(service);
  const client = new OpenAI({
    apiKey: apiKey || 'not-needed',
    baseURL: endpoint,
    timeout: 60000,
    maxRetries: 1,
    ...(service === 'claude' ? { defaultHeaders: { 'anthropic-version': '2023-06-01' } } : {})
  });
  const model = aiModel || defaultModelForService(service);
  const reply = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: PROMPT(texts) }],
    ...completionOptions(service, model, { maxTokens: 2000, temperature: 0 })
  });
  return parseAiAnswer(reply.choices && reply.choices[0] && reply.choices[0].message && reply.choices[0].message.content, texts.length);
}

/**
 * English names for `names` (null where none is needed or none came back), and what translated
 * them. Never throws: a failed translation leaves the names as they are, with `error`.
 */
async function translateNames(names, mode, deps = {}) {
  const english = names.map(() => null);
  const wanted = names.map((name, i) => ({ name: String(name || ''), i })).filter((item) => needsTranslation(item.name));
  if (mode === 'off' || !wanted.length) return { english, by: null, error: null };
  try {
    const texts = wanted.map((item) => item.name);
    const translated = mode === 'ai' ? await translateAi(texts, deps) : await translateFree(texts, deps.fetchImpl);
    wanted.forEach((item, k) => {
      const text = String(translated[k] || '').replace(/\s+/g, ' ').trim().slice(0, 255);
      if (text && text !== item.name) english[item.i] = text;
    });
    return { english, by: mode, error: null };
  } catch (error) {
    return { english, by: null, error: error.message || String(error) };
  }
}

module.exports = { DEFAULT_MODE, MODES, SETTING_KEY, batches, modeOf, parseAiAnswer, translateFree, translateNames };
