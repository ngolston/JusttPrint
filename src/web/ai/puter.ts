/**
 * Puter.com AI: the server asks this page to run a chat request ('puter-ai-chat-request'),
 * because the Puter login lives in the browser (puterAuth.ts). The page sends the request with
 * that login to the server's proxy (/api/puter-ai/chat), which calls Puter.
 */
import { onServerEvent } from '../page';
import { ensureToken, forgetToken } from './puterAuth';

const responseText = (response: unknown) => (typeof response === 'string' ? response
  : response && typeof response === 'object'
    ? String((response as { text?: string; content?: string; message?: string }).text || (response as { content?: string }).content || (response as { message?: string }).message || JSON.stringify(response))
    : String(response || ''));

/** Friendlier messages for the usual failures. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/timeout|Network|Failed to fetch/.test(message)) return 'Network error: Unable to connect to Puter.com API. Please check your internet connection. If running in Docker, ensure the container or browser has internet access.';
  if (/CORS|Access-Control-Allow-Origin/.test(message)) return 'Puter.com API blocked by browser CORS policy. The JusttPrint backend proxy should handle this — try refreshing the page.';
  if (message.includes('403')) return 'Puter.com API access denied (403). This may be due to CORS restrictions or API limitations. Please try using a different AI service or check puter.com documentation.';
  if (message.includes('Forbidden')) return 'Puter.com API access forbidden. This service may require additional setup or have usage restrictions.';
  return message || 'Unknown error';
}

/** Puter refused the login (expired or signed out elsewhere). */
const loginRefused = (status: number, code: unknown) => status === 401 || code === 'token_auth_failed' || code === 'unauthorized';

async function proxyChat(prompt: string, imageUrl: string | null, model: string, authToken: string) {
  const response = await fetch('/api/puter-ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, imageUrl: imageUrl || null, model, authToken })
  });
  const data = await response.json().catch(() => ({}));
  return { response, data: data as { response?: string; error?: string; code?: unknown } };
}

/** Ask Puter AI through the server's proxy, signing in first when needed (once more if Puter refuses the login). */
async function chat(prompt: string, imageUrl: string | null, model: string | null): Promise<string> {
  const modelName = model || 'gpt-5-nano';
  const token = await ensureToken();
  let result = await proxyChat(prompt, imageUrl, modelName, token);
  if (loginRefused(result.response.status, result.data.code)) {
    forgetToken(token);
    result = await proxyChat(prompt, imageUrl, modelName, await ensureToken());
  }
  if (!result.response.ok) throw new Error(result.data.error || `Puter AI proxy error (${result.response.status})`);
  return responseText(result.data.response);
}

if (typeof window !== 'undefined') {
  onServerEvent('puter-ai-chat-request', async (requestId: string, prompt: string, imageUrl: string | null, model: string | null) => {
    try {
      window.electron?.send?.('puter-ai-chat-response', requestId, { response: await chat(prompt, imageUrl, model) });
    } catch (error) {
      console.error('[Puter AI] Request failed:', error);
      window.electron?.send?.('puter-ai-chat-response', requestId, { error: explain(error) });
    }
  });
}
