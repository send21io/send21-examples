// A tiny JSON-file store: pay links per order and handled X-Send21-Delivery ids.
// Writes go to a temp file and are renamed into place, so a crash never leaves half a file.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function fileStore(path) {
  const empty = { links: {}, deliveries: [] };
  const read = () => (existsSync(path) ? { ...empty, ...JSON.parse(readFileSync(path, "utf8")) } : structuredClone(empty));
  const write = (state) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  return {
    getLink: (orderId) => read().links[orderId] ?? null,
    saveLink(orderId, link) {
      const s = read();
      s.links[orderId] = { ...s.links[orderId], ...link };
      write(s);
    },
    hasDelivery: (id) => read().deliveries.includes(id),
    addDelivery(id) {
      const s = read();
      if (!s.deliveries.includes(id)) s.deliveries.push(id);
      s.deliveries = s.deliveries.slice(-5000);
      write(s);
    },
  };
}

export function memoryStore() {
  const links = {};
  const deliveries = new Set();
  return {
    getLink: (o) => links[o] ?? null,
    saveLink: (o, l) => (links[o] = { ...links[o], ...l }),
    hasDelivery: (id) => deliveries.has(id),
    addDelivery: (id) => deliveries.add(id),
  };
}
