// Test helper: runs the durable receiver as its own process, so the tests can
// kill it and start a fresh one on the same database file (a real restart with
// a new connection). Prints "ready <port>" when listening.
//
// FAULT=drop-ack       commit, then close the connection without answering (the ack is lost)
// FAULT=crash-before-commit  SIGKILL this process inside the transaction, before COMMIT
import { openStore } from "../store.js";
import { createWebhookServer } from "../server.js";

const store = openStore(process.env.SEND21_WEBHOOK_DB);
const fault = process.env.FAULT ?? "";
const hooks = {};
if (fault === "crash-before-commit") {
  // The delivery row and the order update are written but not committed. No
  // ROLLBACK code runs: the process just dies, like a crash or kill -9.
  hooks.beforeCommit = () => process.kill(process.pid, "SIGKILL");
}
if (fault === "drop-ack") {
  hooks.afterCommit = (res) => {
    res.socket.destroy();
    return true;
  };
}
const server = createWebhookServer({ secret: process.env.SEND21_WEBHOOK_SECRET, store, log: () => {}, hooks });
server.listen(0, "127.0.0.1", () => console.log(`ready ${server.address().port}`));
