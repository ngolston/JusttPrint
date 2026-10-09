'use strict';

const express = require('express');

/**
 * Proxy Puter AI chat requests server-side to avoid CORS (api.puter.com only allows https://puter.com).
 * The browser still uses Puter.js for authentication/captcha; only the drivers/call is proxied.
 */
function registerPuterAiProxyRoute(expressApp) {
  expressApp.post('/api/puter-ai/chat', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const { prompt, imageUrl, model, authToken } = req.body || {};
      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      let args;
      if (imageUrl && typeof imageUrl === 'string') {
        const isVideo = /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(imageUrl) || imageUrl.startsWith('data:video/');
        const mediaBlock = isVideo ? { video_url: { url: imageUrl } } : { image_url: { url: imageUrl } };
        args = {
          vision: true,
          messages: [{ content: [prompt, mediaBlock] }],
          model: model || 'gpt-5-nano'
        };
      } else {
        args = {
          messages: [{ content: prompt }],
          model: model || 'gpt-5-nano'
        };
      }

      const puterBody = JSON.stringify({
        interface: 'puter-chat-completion',
        driver: 'ai-chat',
        test_mode: false,
        method: 'complete',
        args,
        auth_token: authToken || undefined
      });

      const puterResponse = await fetch('https://api.puter.com/drivers/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;actually=json',
          Origin: 'https://puter.com',
          Referer: 'https://puter.com/'
        },
        body: puterBody
      });

      let data;
      const puterRawBody = await puterResponse.text();
      try {
        data = puterRawBody ? JSON.parse(puterRawBody) : {};
      } catch (parseErr) {
        res.status(502).json({ error: `Invalid response from Puter API (${puterResponse.status})`, details: puterRawBody.slice(0, 500) });
        return;
      }

      if (!puterResponse.ok || data.success === false) {
        const errMsg = data?.error?.message || data?.message || `Puter API error (${puterResponse.status})`;
        const code = data?.error?.code || data?.code;
        res.status(puterResponse.status >= 400 ? puterResponse.status : 500).json({ error: errMsg, code, details: data });
        return;
      }

      const result = data.result;
      let chatText;
      if (typeof result === 'string') {
        chatText = result;
      } else if (result?.message?.content) {
        chatText = result.message.content;
      } else if (typeof result?.text === 'string') {
        chatText = result.text;
      } else if (result != null) {
        chatText = JSON.stringify(result);
      } else {
        chatText = '';
      }

      res.json({ response: chatText });
    } catch (err) {
      console.error('[Puter AI Proxy] Error:', err);
      res.status(500).json({ error: err.message || 'Puter AI proxy error' });
    }
  });
}

module.exports = { registerPuterAiProxyRoute };
