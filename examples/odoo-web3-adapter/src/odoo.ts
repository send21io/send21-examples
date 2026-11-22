// Odoo external JSON-RPC (/jsonrpc), the same API odoo-web3 uses (docs/odoo/sync.md).
export type Odoo = {
  executeKw: (model: string, method: string, args: unknown[], kwargs?: Record<string, unknown>) => Promise<any>;
};

export function odooClient({ url, db, username, password, fetchImpl = fetch }: { url: string; db: string; username: string; password: string; fetchImpl?: typeof fetch }): Odoo {
  let uid: number | null = null;
  let id = 0;
  async function rpc(service: string, method: string, args: unknown[]) {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++id }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`Odoo: ${json.error.data?.message ?? json.error.message}`);
    return json.result;
  }
  return {
    async executeKw(model, method, args, kwargs = {}) {
      uid ??= await rpc("common", "login", [db, username, password]);
      if (!uid) throw new Error("Odoo login failed");
      return rpc("object", "execute_kw", [db, uid, password, model, method, args, kwargs]);
    },
  };
}
