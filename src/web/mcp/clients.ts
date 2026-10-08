/**
 * How each MCP client is set up to reach JusttPrint. Each app wants its own format, so the
 * MCP Server dialog shows the one for the app the user picks, with the address and API token
 * already filled in.
 */

export type McpClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'other';

export interface McpClientSetup {
  id: McpClientId;
  name: string;
  /** Where the text goes, shown above it. */
  where: string;
  /** What the copied text is: a command to run, or JSON for a settings file. */
  kind: 'command' | 'json';
  text: string;
  /** Extra steps or requirements, shown under it. */
  note?: string;
}

export const SERVER_NAME = 'justtprint';

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Every client's setup for this address and token (the token may be empty when unknown). */
export function mcpClientSetups(url: string, token: string): McpClientSetup[] {
  const auth = token ? `Bearer ${token}` : 'Bearer <API token from Settings → JusttPrint Backend Access>';
  const plainHttp = /^http:\/\//i.test(url);
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      where: 'Run this in a terminal. Add --scope user to use it in every project.',
      kind: 'command',
      text: `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: ${auth}"`,
      note: 'Then type /mcp in Claude Code to check that it is connected.'
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      where: 'Settings → Developer → Edit Config, then add this to claude_desktop_config.json and restart Claude Desktop.',
      kind: 'json',
      text: json({
        mcpServers: {
          [SERVER_NAME]: {
            command: 'npx',
            // The token goes through an environment variable: a space inside an argument breaks on Windows.
            args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}', ...(plainHttp ? ['--allow-http'] : [])],
            env: { AUTH_HEADER: auth }
          }
        }
      }),
      note: 'Claude Desktop reaches the JusttPrint backend through mcp-remote, which needs Node.js on this computer. If the file already has mcpServers, add only the justtprint entry.'
    },
    {
      id: 'cursor',
      name: 'Cursor',
      where: 'Settings → MCP → Add new MCP server, or add this to ~/.cursor/mcp.json.',
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: auth } } } })
    },
    {
      id: 'vscode',
      name: 'VS Code (Copilot)',
      where: 'Command Palette → "MCP: Open User Configuration", or a .vscode/mcp.json file in your project.',
      kind: 'json',
      text: json({ servers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: auth } } } }),
      note: 'Keep .vscode/mcp.json out of git: it holds the API token.'
    },
    {
      id: 'other',
      name: 'Other MCP clients',
      where: 'Clients that take a URL and headers (Streamable HTTP transport).',
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: auth } } } })
    }
  ];
}

/** The API token from the server's client config (`Authorization: Bearer <token>`). */
export function tokenFromClientConfig(config: { mcpServers?: Record<string, { headers?: Record<string, string> }> } | null | undefined): string {
  const header = Object.values(config?.mcpServers ?? {})[0]?.headers?.Authorization ?? '';
  return header.replace(/^Bearer\s+/i, '').trim();
}
