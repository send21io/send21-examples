// Minimal .env loader (no dependency). Real environment variables win.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(dir = process.cwd()) {
  const file = resolve(dir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// For logs: never print a key or secret, only that it is set.
export function redact(value) {
  return value ? `set (${String(value).slice(0, 4)}…, hidden)` : "missing";
}
