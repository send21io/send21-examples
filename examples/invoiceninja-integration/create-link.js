// node create-link.js <invoice id>  -> creates (or returns) the pay link and writes it to the invoice.
import { loadConfig } from "./src/config.js";
import { createLinkForInvoice } from "./src/handlers.js";
import { invoiceNinjaClient } from "./src/invoiceninja.js";
import { fileStore } from "./src/store.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: node create-link.js <invoice id>");
  process.exit(1);
}
const config = loadConfig();
const link = await createLinkForInvoice(id, {
  config,
  api: invoiceNinjaClient({ baseUrl: config.invoiceNinjaUrl, token: config.invoiceNinjaToken }),
  store: fileStore(config.storePath),
});
console.log(link);
