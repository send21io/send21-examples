// JSON file store: handled X-Send21-Delivery ids, confirmations waiting for odoo-web3's next
// sync, and bill drafts. Writes go to a temp file and are renamed into place.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type State = { deliveries: string[]; pending: Record<string, any>; bills: Record<string, any>; links: Record<string, any> };
export type Store = { read(): State; write(s: State): void };

export function fileStore(path: string): Store {
  return {
    read: () => ({ deliveries: [], pending: {}, bills: {}, links: {}, ...(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) }),
    write(s) {
      writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

export function memoryStore(): Store {
  let state: State = { deliveries: [], pending: {}, bills: {}, links: {} };
  return { read: () => structuredClone(state), write: (s) => (state = structuredClone(s)) };
}
