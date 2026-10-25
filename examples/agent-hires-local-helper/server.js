// Web UI for the helper task. The agent code and the send21 key run here, on the server.
//   npm start   then open http://localhost:3022
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { loadEnv } from "./lib/env.js";
import { mcpClient } from "./lib/mcp.js";
import { loadConfig, draftPaymentForDoneTask, readDraftStatus, confirmsDraft } from "./lib/agent.js";
import { client } from "./lib/send21.js";
import { chunk } from "./lib/address.js";
import { verifyV2 } from "./lib/webhook.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const cfg = loadConfig(dir);
const mcp = mcpClient();
const api = client();
const port = Number(process.env.PORT || 3022);

// One task in memory: in_progress -> awaiting_signature -> paid
const state = { phase: "in_progress", review: null, paid: null };
const handledDeliveries = new Set(); // this receiver ignores a delivery id it already handled

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, fail) => { const p = []; req.on("data", (c) => p.push(c)); req.on("end", () => ok(Buffer.concat(p))); req.on("error", fail); });

// Is the helper's address an owner-verified entry in the send21 address book?
// Only then does the UI say "pre-approved". Otherwise it says "the address you saved".
let helperApproved = null;
async function lookupHelperApproval() {
  try {
    const book = await mcp.callTool("list_address_book");
    helperApproved = Boolean((book ?? []).find((e) => e.address === cfg.helper.address && e.network === cfg.helper.network)?.verifiedAt);
  } catch { helperApproved = false; }
  return helperApproved;
}

function view() {
  const approved = state.review ? Boolean(state.review.approvedInSend21) : Boolean(helperApproved);
  return { task: cfg.task, helper: { ...cfg.helper, chunks: chunk(cfg.helper.address), source: cfg.fileName, approvedInSend21: approved }, idempotencyKey: cfg.idempotencyKey, ...state };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/task") { if (helperApproved === null) await lookupHelperApproval(); return json(res, 200, view()); }

    if (req.method === "POST" && url.pathname === "/api/task/done") {
      // The helper reported the task done. The agent drafts the payment.
      const r = await draftPaymentForDoneTask({ mcp, api }, cfg);
      if (r.stopped) return json(res, 409, { error: r.reason, steps: r.steps });
      const reused = state.review?.draft.id === r.draft.id;
      const qr = r.draft.paymentUri ? await QRCode.toString(r.draft.paymentUri, { type: "svg", margin: 1, color: { dark: "#1B1C20", light: "#FFFFFF" } }) : null;
      state.phase = r.draft.status === "Confirmed" ? "paid" : "awaiting_signature";
      state.review = { ...r, reused, qr };
      return json(res, 201, view());
    }

    if (req.method === "GET" && url.pathname === "/api/task/status") {
      if (state.review && state.phase !== "paid") {
        const s = await readDraftStatus(mcp, state.review.draft.id);
        state.review.draft.status = s.status;
        if (s.status === "Confirmed") { state.phase = "paid"; state.paid ??= { txId: s.paidTxId, confirmedAt: s.confirmedAt, localTest: false }; }
      }
      return json(res, 200, view());
    }

    if (req.method === "POST" && url.pathname === "/webhooks/send21") {
      const raw = await readBody(req);
      const delivery = String(req.headers["x-send21-delivery"] ?? "");
      const sig = req.headers["x-send21-signature-v2"];
      const real = verifyV2({ rawBody: raw, signatureHeader: sig, deliveryId: delivery, secret: process.env.SEND21_WEBHOOK_SECRET });
      const local = !real && verifyV2({ rawBody: raw, signatureHeader: sig, deliveryId: delivery, secret: process.env.LOCAL_TEST_WEBHOOK_SECRET });
      if (!real && !local) { res.writeHead(401); return res.end(); }
      if (handledDeliveries.has(delivery)) { res.writeHead(200); return res.end("already handled"); }
      handledDeliveries.add(delivery);
      const { event, data } = JSON.parse(raw.toString("utf8"));
      // Mark paid only for this task's draft, asset, network and billed amount.
      const expected = confirmsDraft(event, data, state.review?.draft);
      if (expected) { state.phase = "paid"; state.paid = { txId: data.txId, confirmedAt: data.confirmedAt, sentAmount: data.sentAmount, localTest: local }; }
      res.writeHead(200); return res.end(expected ? "ok" : "ignored");
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (req.method === "GET" && /^\/[\w.-]+$/.test(path)) {
      const body = await readFile(join(dir, "public", path)).catch(() => null);
      if (body) { res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }); return res.end(body); }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 502, { error: String(err.message).replace(/s21_[A-Za-z0-9_-]+/g, "s21_[hidden]") });
  }
});

server.listen(port, () => console.log(`agent-hires-local-helper on http://localhost:${port}  (task: ${cfg.task.title}; Idempotency-Key ${cfg.idempotencyKey})`));
