import { CodeBlock, CopyButton } from "../components";
import { claudeCodeCommand, cursorConfig, curlCommand, inspectorCommand } from "../lib/snippets";

// Connect page (DESIGN §7.6): everything an external MCP client needs is the gateway URL plus a
// personal API key from the API keys page.

export function ConnectPage({ gatewayUrl, onOpenKeys }: { gatewayUrl: string; onOpenKeys: () => void }) {
  return (
    <section className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">External clients</p>
          <h2>Connect</h2>
          <p className="subtle">
            One URL for every enabled server. Replace the placeholder with a key from{" "}
            <button className="inlineLink" onClick={onOpenKeys}>
              API keys
            </button>
            .
          </p>
        </div>
      </header>

      <article className="card">
        <h3>Gateway URL</h3>
        <div className="inlineRow">
          <code className="bigCode">{gatewayUrl}</code>
          <CopyButton value={gatewayUrl} />
        </div>
        <p className="subtle">
          Streamable HTTP, stateless. Tools are named <code>server__tool</code> (for example <code>woo__list_orders</code>), so two servers with the same tool name never collide.
        </p>
      </article>

      <article className="card">
        <h3>Claude Code</h3>
        <CodeBlock code={claudeCodeCommand(gatewayUrl)} />
        <p className="subtle">
          Then run <code>/mcp</code> inside Claude Code to check that it is connected.
        </p>
      </article>

      <article className="card">
        <h3>Cursor</h3>
        <p className="subtle">
          Add to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project):
        </p>
        <CodeBlock code={cursorConfig(gatewayUrl)} />
      </article>

      <article className="card">
        <h3>MCP Inspector (CLI)</h3>
        <CodeBlock code={inspectorCommand(gatewayUrl)} />
      </article>

      <article className="card">
        <h3>curl</h3>
        <CodeBlock code={curlCommand(gatewayUrl)} />
      </article>
    </section>
  );
}
