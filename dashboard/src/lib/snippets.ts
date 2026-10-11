// Client configuration snippets for the Connect and API keys pages. All of them send the key as
// "Authorization: Bearer", which is what the gateway's /mcp expects (DESIGN §6.2).

export const SERVER_NAME = "team-gateway";
export const KEY_PLACEHOLDER = "mcpgw_XXXXXXXX_your-key";

export const claudeCodeCommand = (url: string, key = KEY_PLACEHOLDER) =>
  `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${key}"`;

export const cursorConfig = (url: string, key = KEY_PLACEHOLDER) =>
  JSON.stringify({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);

export const inspectorCommand = (url: string, key = KEY_PLACEHOLDER) =>
  `npx @modelcontextprotocol/inspector@2.8.0 --cli ${url} --header "Authorization: Bearer ${key}" --method tools/list`;

export const curlCommand = (url: string, key = KEY_PLACEHOLDER) =>
  `curl -s ${url} -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
