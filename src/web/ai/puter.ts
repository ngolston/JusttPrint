/**
 * Puter.com AI: the server asks this page to run a chat request ('puter-ai-chat-request'),
 * because Puter signs in the user in the browser. Puter.js loads on the first request.
 * (Known issue: the Content Security Policy blocks js.puter.com; see TODO.md.)
 */
import { onServerEvent } from '../page';

interface Puter {
  ai?: { chat?: (prompt: string, imageUrl?: string | null, options?: { model: string }) => Promise<unknown> };
  authToken?: string | null;
  ui?: { authenticateWithPuter?: () => Promise<void> };
}

declare global {
  interface Window {
    puter?: Puter;
  }
}

const SCRIPT = 'https://js.puter.com/v2/';
let loading: Promise<Puter> | null = null;

function loadPuter(): Promise<Puter> {
  if (window.puter?.ai) return Promise.resolve(window.puter);
  loading ??= new Promise<Puter>((resolve, reject) => {
    const waitForPuter = () => {
      let tries = 0;
      const timer = setInterval(() => {
        if (window.puter?.ai) {
          clearInterval(timer);
          resolve(window.puter);
        } else if (++tries >= 50) {
          clearInterval(timer);
          reject(new Error('Puter.js loaded but puter object not available'));
        }
      }, 100);
    };
    if (document.querySelector(`script[src="${SCRIPT}"]`)) return waitForPuter();
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = waitForPuter;
    script.onerror = () => reject(new Error('Failed to load Puter.js script'));
    document.head.appendChild(script);
  }).finally(() => { loading = null; });
  return loading;
}

const responseText = (response: unknown) => (typeof response === 'string' ? response
  : response && typeof response === 'object'
    ? String((response as { text?: string; content?: string; message?: string }).text || (response as { content?: string }).content || (response as { message?: string }).message || JSON.stringify(response))
    : String(response || ''));

/** Friendlier messages for the usual failures. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout|Network|Failed to fetch/.test(message)) return 'Network error: Unable to connect to Puter.com API. Please check your internet connection. If running in Docker, ensure the container or browser has internet access.';
  if (/CORS|Access-Control-Allow-Origin/.test(message)) return 'Puter.com API blocked by browser CORS policy. The server proxy should handle this — try refreshing the page.';
  if (message.includes('403')) return 'Puter.com API access denied (403). This may be due to CORS restrictions or API limitations. Please try using a different AI service or check puter.com documentation.';
  if (message.includes('Forbidden')) return 'Puter.com API access forbidden. This service may require additional setup or have usage restrictions.';
  return message || 'Unknown error';
}

/** Ask Puter AI. Off puter.com, requests go through the server's proxy (/api/puter-ai/chat). */
async function chat(prompt: string, imageUrl: string | null, model: string | null): Promise<string> {
  const puter = await loadPuter();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Network timeout: Unable to reach Puter.com API. Please check your internet connection.')), 55000));
  const modelName = model || 'gpt-5-nano';
  const onPuterCom = /^(www\.)?puter\.com$/i.test(window.location.hostname);
  if (onPuterCom) {
    if (!puter.ai?.chat) throw new Error('Puter.js AI chat is not available. Please refresh the application.');
    return responseText(await Promise.race([puter.ai.chat(prompt, imageUrl, { model: modelName }), timeout]));
  }
  if (!puter.authToken) await puter.ui?.authenticateWithPuter?.();
  const request = fetch('/api/puter-ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, imageUrl: imageUrl || null, model: modelName, authToken: puter.authToken || null })
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Puter AI proxy error (${response.status})`);
    return data.response;
  });
  return responseText(await Promise.race([request, timeout]));
}

if (typeof window !== 'undefined') {
  onServerEvent('puter-ai-chat-request', async (requestId: string, prompt: string, imageUrl: string | null, model: string | null) => {
    try {
      window.electron?.send?.('puter-ai-chat-response', requestId, { response: await chat(prompt, imageUrl, model) });
    } catch (error) {
      console.error('[Puter AI] Error calling puter.ai.chat:', error);
      window.electron?.send?.('puter-ai-chat-response', requestId, { error: explain(error) });
    }
  });
}
