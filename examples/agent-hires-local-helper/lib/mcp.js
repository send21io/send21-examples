// Minimal MCP client for send21's remote server (Streamable HTTP, stateless JSON-RPC).
// https://send21.io/docs/mcp  The bearer key stays on the server that runs the agent.
export function mcpClient({ url = process.env.SEND21_MCP_URL || "https://send21.io/mcp", apiKey = process.env.SEND21_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("SEND21_API_KEY is not set. Copy .env.example to .env and add a scoped key.");
  let id = 0, session = null, ready = null;

  async function rpc(method, params) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${apiKey}` };
    if (session) headers["Mcp-Session-Id"] = session;
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    // The answer is plain JSON or one SSE "data:" line.
    const payload = text.trimStart().startsWith("{") ? text : text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    const msg = JSON.parse(payload);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async function init() {
    ready ??= rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-hires-local-helper", version: "0.1.0" } });
    return ready;
  }

  return {
    url,
    async callTool(name, args = {}) {
      await init();
      const result = await rpc("tools/call", { name, arguments: args });
      const text = result?.content?.find((c) => c.type === "text")?.text;
      let data = result?.structuredContent;
      if (data === undefined && text !== undefined) { try { data = JSON.parse(text); } catch { data = text; } }
      if (result?.isError) { const e = new Error(`${name}: ${typeof data === "string" ? data : JSON.stringify(data)}`); e.data = data; throw e; }
      return data;
    },
  };
}
