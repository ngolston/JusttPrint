import { describe, expect, it } from 'vitest';
import { mcpClientSetups, tokenFromClientConfig } from './clients';

const URL = 'http://192.168.1.20:5000/mcp';
const TOKEN = 'pv_abc123';
const setup = (id: string, url = URL, token = TOKEN) => mcpClientSetups(url, token).find((s) => s.id === id)!;

describe('MCP client setups', () => {
  it('gives Claude Code one command with the URL and token', () => {
    expect(setup('claude-code').text).toBe(`claude mcp add --transport http justtprint ${URL} --header "Authorization: Bearer ${TOKEN}"`);
    expect(setup('claude-code').kind).toBe('command');
  });

  it('runs Claude Desktop through mcp-remote, with the token in an environment variable', () => {
    const server = JSON.parse(setup('claude-desktop').text).mcpServers.justtprint;
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', 'mcp-remote', URL, '--header', 'Authorization:${AUTH_HEADER}', '--allow-http']);
    expect(server.env).toEqual({ AUTH_HEADER: `Bearer ${TOKEN}` });
  });

  it('only allows plain HTTP for mcp-remote when the URL is plain HTTP', () => {
    const server = JSON.parse(setup('claude-desktop', 'https://library.example.com/mcp').text).mcpServers.justtprint;
    expect(server.args).not.toContain('--allow-http');
  });

  it('uses mcpServers for Cursor and servers with type http for VS Code', () => {
    expect(JSON.parse(setup('cursor').text)).toEqual({ mcpServers: { justtprint: { url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(JSON.parse(setup('vscode').text)).toEqual({ servers: { justtprint: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } } });
  });

  it('shows where to find the token when it is not known', () => {
    expect(setup('cursor', URL, '').text).toContain('<API token from Settings → Server Access>');
  });

  it('reads the token from the server client config', () => {
    expect(tokenFromClientConfig({ mcpServers: { justtprint: { headers: { Authorization: 'Bearer pv_x' } } } })).toBe('pv_x');
    expect(tokenFromClientConfig(null)).toBe('');
  });
});
