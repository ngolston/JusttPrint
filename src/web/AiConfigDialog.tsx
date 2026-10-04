import { useEffect, useRef, useState } from 'react';
import { ai, settings } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openAiConfig?: () => void;
  }
}

type Service = 'openai' | 'claude' | 'gemini' | 'puter' | 'custom';

/** Endpoint and model a service starts with. */
const SERVICE_DEFAULTS: Record<Service, { endpoint: string; model: string }> = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  claude: { endpoint: 'https://api.anthropic.com/v1/', model: 'claude-haiku-4-5' },
  gemini: { endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash' },
  puter: { endpoint: 'https://js.puter.com/v2/', model: 'gpt-5-nano' },
  custom: { endpoint: '', model: '' }
};

const CLOUD_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'];

function apiKeyRequired(service: Service, endpoint: string): boolean {
  if (service === 'puter' || service === 'custom') return false;
  const url = endpoint.trim().toLowerCase();
  return !url || CLOUD_HOSTS.some((host) => url.includes(host));
}

interface Form {
  service: Service;
  apiKey: string;
  endpoint: string;
  model: string;
  maxTags: string;
  detailLevel: string;
  folderLevels: string;
  mergeStrategy: string;
  useCategories: boolean;
  allowRetagging: boolean;
  concurrency: string;
}

/** [form field, setting key, default] for the plain text settings. */
const TEXT_SETTINGS: [keyof Form, string, string][] = [
  ['maxTags', 'aiTagMaxTags', '10'],
  ['detailLevel', 'aiTagDetailLevel', 'medium'],
  ['folderLevels', 'aiTagFolderLevels', '2'],
  ['mergeStrategy', 'aiTagMergeStrategy', 'merge'],
  ['concurrency', 'aiTagConcurrency', '3']
];

const DEFAULT_FORM: Form = {
  service: 'puter', apiKey: '', ...SERVICE_DEFAULTS.puter,
  maxTags: '10', detailLevel: 'medium', folderLevels: '2', mergeStrategy: 'merge',
  useCategories: false, allowRetagging: false, concurrency: '3'
};

async function loadForm(): Promise<Form> {
  const get = (key: string) => settings.get<string | null>(key).catch(() => null);
  const stored = await Promise.all(['aiService', 'apiKey', 'apiEndpoint', 'aiModel', 'aiTagUseCategories', 'aiTagAllowRetagging', ...TEXT_SETTINGS.map(([, key]) => key)].map(get));
  const [service, apiKey, endpoint, model, useCategories, allowRetagging, ...text] = stored;
  const selected = (service && service in SERVICE_DEFAULTS ? service : 'puter') as Service;
  const defaults = SERVICE_DEFAULTS[selected];
  const form: Form = {
    ...DEFAULT_FORM,
    service: selected,
    // Puter.com always uses its own endpoint and model, and no key.
    apiKey: selected === 'puter' ? '' : apiKey || '',
    endpoint: selected === 'puter' ? defaults.endpoint : endpoint || defaults.endpoint,
    model: selected === 'puter' ? defaults.model : model || defaults.model,
    useCategories: useCategories === '1',
    allowRetagging: allowRetagging === '1'
  };
  TEXT_SETTINGS.forEach(([field, , fallback], index) => { (form[field] as string) = text[index] || fallback; });
  return form;
}

/**
 * Settings → AI Configuration: the AI service and its endpoint, model and key, the tag
 * generation options, and the tagging prompt (Edit Prompt opens a second dialog). Changes are
 * saved by Save only. Registers window.openAiConfig.
 */
export function AiConfigDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const promptDialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [result, setResult] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState('');

  useEffect(() => exposeGlobal('openAiConfig', () => {
    setResult('');
    loadForm()
      .then(setForm)
      .finally(() => { if (!dialogRef.current?.open) dialogRef.current?.showModal(); });
  }), []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  function changeService(service: Service) {
    setForm((previous) => ({ ...previous, service, ...SERVICE_DEFAULTS[service], apiKey: '' }));
  }

  async function test() {
    setTesting(true);
    setResult('Testing...');
    try {
      const model = form.model.trim() || (form.service === 'puter' ? SERVICE_DEFAULTS.puter.model : '');
      const outcome = await ai.test(form.service === 'puter' ? '' : form.apiKey.trim(), form.endpoint.trim(), model, form.service);
      setResult(outcome.success ? `Test successful! Tags: ${(outcome.tags || []).join(', ')}` : `Test failed: ${outcome.error || ''}`);
    } catch (error) {
      setResult(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const defaults = SERVICE_DEFAULTS[form.service];
      const values: [string, string][] = [
        ['apiKey', form.service === 'puter' ? '' : form.apiKey],
        ['apiEndpoint', form.endpoint || (form.service === 'puter' ? defaults.endpoint : SERVICE_DEFAULTS.openai.endpoint)],
        ['aiModel', form.model || (form.service === 'puter' ? defaults.model : SERVICE_DEFAULTS.openai.model)],
        ['aiService', form.service],
        ['aiTagUseCategories', form.useCategories ? '1' : '0'],
        ['aiTagAllowRetagging', form.allowRetagging ? '1' : '0'],
        ...TEXT_SETTINGS.map(([field, key, fallback]): [string, string] => [key, String(form[field]) || fallback])
      ];
      for (const [key, value] of values) await settings.save(key, value);
      dialogRef.current?.close();
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function editPrompt() {
    const current = await settings.get<string | null>('aiTagPrompt').catch(() => null);
    setPrompt(current && current.trim() ? current : await ai.defaultPrompt().catch(() => ''));
    promptDialogRef.current?.showModal();
  }

  async function savePrompt() {
    try {
      await settings.save('aiTagPrompt', prompt);
      promptDialogRef.current?.close();
      await showMessage('AI Prompt', 'Prompt saved.');
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save prompt');
    }
  }

  async function resetPrompt() {
    try {
      await settings.save('aiTagPrompt', '');
      await showMessage('AI Prompt', 'Prompt reset to default.');
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to reset prompt');
    }
  }

  const keyRequired = apiKeyRequired(form.service, form.endpoint);
  const textInput = (key: keyof Form, id: string, type = 'text', extra: Record<string, string | number> = {}) => (
    <input type={type} id={id} value={String(form[key])} {...extra}
      onChange={(event) => set(key, event.target.value as never)} />
  );

  return (
    <>
      <ModalDialog id="ai-config-dialog" title="AI Configuration" dialogRef={dialogRef}
        description={(
          <p className="setting-description">
            This feature uses your own AI service that supports the OpenAI API. You can configure it to work with services such as OpenAI, Claude, Deepseek, Gemini, Puter.com, or a local server (Ollama, LM Studio, and similar). The selected model must support image analysis (e.g., gpt-4o). Puter.com and local OpenAI-compatible servers do not require an API key. You can use the Test button to check that your AI is properly configured.
          </p>
        )}
        footer={(
          <>
            <button type="button" id="test-ai-config" disabled={testing} onClick={test}>Test</button>
            <button type="button" id="save-ai-config" disabled={saving} onClick={save}>Save</button>
            <button type="button" id="cancel-ai-config" onClick={() => dialogRef.current?.close()}>Cancel</button>
          </>
        )}>
        <div className="form-group">
          <label htmlFor="ai-service-select">AI Service:</label>
          <select id="ai-service-select" value={form.service} onChange={(event) => changeService(event.target.value as Service)}>
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="puter">Puter.com</option>
            <option value="custom">Custom (local / OpenAI-compatible)</option>
          </select>
        </div>
        {form.service !== 'puter' && (
          <div className="form-group">
            <label htmlFor="ai-api-key">{keyRequired ? 'API Key:' : 'API Key (optional):'}</label>
            <input type="password" id="ai-api-key" autoComplete="off" required={keyRequired} value={form.apiKey}
              onChange={(event) => set('apiKey', event.target.value)} />
            <small id="ai-api-key-hint">
              {keyRequired ? 'Required for this cloud service.' : 'Optional for local OpenAI-compatible servers (Ollama, LM Studio, and similar).'}
            </small>
          </div>
        )}
        <div className="form-group">
          <label htmlFor="ai-endpoint">API Endpoint:</label>
          {textInput('endpoint', 'ai-endpoint')}
        </div>
        <div className="form-group">
          <label htmlFor="ai-model">AI Model:</label>
          {textInput('model', 'ai-model')}
        </div>
        <hr className="ai-config-divider" />
        <h4 className="ai-config-subtitle">Tag Generation Settings</h4>
        <div className="form-group">
          <label htmlFor="ai-tag-max-tags">Maximum Tags:</label>
          {textInput('maxTags', 'ai-tag-max-tags', 'number', { min: 1, max: 50 })}
          <small>Maximum number of tags to generate per model (1-50)</small>
        </div>
        <div className="form-group">
          <label htmlFor="ai-tag-detail-level">Level of Detail:</label>
          <select id="ai-tag-detail-level" value={form.detailLevel} onChange={(event) => set('detailLevel', event.target.value)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <small>Detail level for tag generation (Low: "Toy", Medium: "Dragon", High: "Articulated Dragon")</small>
        </div>
        <div className="form-group">
          <label htmlFor="ai-tag-folder-levels">Folder levels:</label>
          {textInput('folderLevels', 'ai-tag-folder-levels', 'number', { min: 0, max: 6 })}
          <small>How many parent folders to send with the thumbnail, and to use for Tag from Folder and for tagging newly scanned files. 0 omits folders from the AI prompt and adds no folder tags on scan. For Kitchen/Bagel Slicer/model.3mf, 2 levels include Kitchen and Bagel Slicer.</small>
        </div>
        <div className="form-group">
          <label htmlFor="ai-tag-merge-strategy">Tag Merge Strategy:</label>
          <select id="ai-tag-merge-strategy" value={form.mergeStrategy} onChange={(event) => set('mergeStrategy', event.target.value)}>
            <option value="merge">Merge (add to existing tags)</option>
            <option value="append">Append (add only new tags)</option>
            <option value="replace">Replace (remove existing, add new)</option>
          </select>
          <small>How AI-generated tags should be combined with existing tags</small>
        </div>
        <div className="form-group">
          <div className="checkbox-container ai-config-checkbox">
            <input type="checkbox" id="ai-tag-use-categories" checked={form.useCategories} onChange={(event) => set('useCategories', event.target.checked)} />
            <label htmlFor="ai-tag-use-categories">Use Category-Based Tagging</label>
          </div>
          <small>Organize tags into categories (object type, style, complexity, material)</small>
        </div>
        <div className="form-group">
          <div className="checkbox-container ai-config-checkbox">
            <input type="checkbox" id="ai-tag-allow-retagging" checked={form.allowRetagging} onChange={(event) => set('allowRetagging', event.target.checked)} />
            <label htmlFor="ai-tag-allow-retagging">Allow Re-tagging</label>
          </div>
          <small>Allow re-tagging models that already have "AI Tagged" tag</small>
        </div>
        <div className="form-group">
          <label htmlFor="ai-tag-concurrency">Concurrent Requests:</label>
          {textInput('concurrency', 'ai-tag-concurrency', 'number', { min: 1, max: 10 })}
          <small>Number of tag generation requests to process simultaneously (1-10)</small>
        </div>
        <div className="form-group">
          <label>AI Prompt:</label>
          <div className="dialog-buttons ai-prompt-actions">
            <button type="button" id="edit-ai-prompt" onClick={editPrompt}>Edit Prompt</button>
            <button type="button" id="reset-ai-prompt" onClick={resetPrompt}>Reset Prompt</button>
          </div>
          <small>Customize the system prompt used for tag generation. Reset restores the built-in default.</small>
        </div>
        <div id="ai-config-result" className="result-message" role="status">{result}</div>
      </ModalDialog>

      <ModalDialog id="ai-prompt-edit-dialog" title="Edit AI Prompt" dialogRef={promptDialogRef}
        description={<p className="setting-description">This prompt is sent to the AI when generating tags. Leave empty to use the built-in default. Filename, folder, and description context is appended automatically when available.</p>}
        footer={(
          <>
            <button type="button" id="save-ai-prompt-edit" onClick={savePrompt}>Save</button>
            <button type="button" id="cancel-ai-prompt-edit" onClick={() => promptDialogRef.current?.close()}>Cancel</button>
          </>
        )}>
        <div className="form-group">
          <label htmlFor="ai-prompt-textarea">Prompt:</label>
          <textarea id="ai-prompt-textarea" className="ai-prompt-textarea" rows={16} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </div>
      </ModalDialog>
    </>
  );
}
