# send21 invoice agent for LangGraph

A LangGraph agent that bills a client in crypto and waits for the payment:

```
intake -> validate -> create_link -> send_link -> wait_for_payment (interrupt) -> handle_event -> paid
                          |                                ^                          |
                          +-> propose_addresses -> end     +---- needs_review <-------+
```

1. **Takes** a client, an amount and a fiat currency, as flags or as free text (`--text`, parsed by any LangChain chat model).
2. **Creates a send21 pay link** with the `create_payment_request` tool of the send21 MCP server (`https://send21.io/mcp`, via `langchain-mcp-adapters`). It sends `orderId` = invoice id, `idempotencyKey` and `reuseOpenForOrder: true`, so a retry returns the same link.
3. **Emails** the link (SMTP) or prints it.
4. **Pauses** with `interrupt()`. The state is kept in SQLite (`SqliteSaver`), so the process can exit.
5. [`webhook_server.py`](webhook_server.py) receives send21's webhook, verifies `X-Send21-Signature-V2` over the raw body, refuses deliveries more than 5 minutes old, ignores delivery ids it already handled (SQLite), and **resumes** the graph with `Command(resume=event)`.
6. On `draft.confirmed` with the right orderId, pay link id, amount and currency, the invoice is **paid** (`invoices` table). `draft.amount_mismatch` keeps it waiting as `needs_review`: you accept or decline that transfer yourself in send21, and the agent never decides.

**The agent proposes, you approve.** Receiving addresses come only from `SEND21_RECEIVE_OPTIONS`, which you set. If send21 answers `422 address_not_approved`, the agent proposes those addresses (`propose_receiving_address`) and stops. You approve them yourself in the send21 app with a passkey or authenticator code, then run the same command again. The agent never signs, sends or approves anything. The client pays from their own wallet; send21 never holds keys or funds.

## Setup (3 steps)

1. `pip install -r requirements.txt` (Python 3.10+).
2. Copy `.env.example` to `.env` and fill it in: `SEND21_API_KEY` (create it at https://send21.io/api-keys with scopes `drafts:write`, `drafts:read`, `addressbook:read`, plus `addressbook:write` to propose addresses) and `SEND21_RECEIVE_OPTIONS` with your own addresses, for example `[{"currency":"Usdc","network":"Solana","address":"..."}]`. USDT works on Solana and Ethereum only. Load the file with `set -a; . ./.env; set +a`.
3. Run the webhook receiver on a public HTTPS address (send21 refuses private and internal endpoints), register it once, and store the secret it prints (shown once) as `SEND21_WEBHOOK_SECRET`:
   ```bash
   python webhook_server.py --register https://your-host/send21/webhook   # needs webhooks:manage
   python webhook_server.py                                               # listens on :8021
   ```

Then bill someone:

```bash
python invoice_agent.py create --client "Acme Ltd" --email ap@acme.example --amount 250 --currency EUR --memo "Logo design"
python invoice_agent.py status INV-20261022-1A2B3C
# free text instead of flags: pip install langchain langchain-openai, set SEND21_LLM_MODEL=openai:gpt-4.1-mini
python invoice_agent.py create --text "Bill Acme 250 EUR for the logo, ap@acme.example"
```

## Tests

```bash
python -m unittest discover -s tests
```

Ten offline tests use a fake send21 and deliveries signed the way send21 signs them: the pay link uses only the configured addresses with an idempotency key; creating the same invoice twice bills once; a signed `draft.confirmed` marks the invoice paid and a repeated delivery is ignored; a bad, missing or more than 5-minute-old signature gets 401; a wrong amount is not paid; an amount mismatch waits for you; an unapproved address is proposed, not used; bad input creates nothing; an unsupported currency and network pair is refused; the free-text intake works with a model.

Also run live against send21: `create` made a real pay link over MCP (3 EUR, USDC and USDT on Solana). The local webhook server then got signed deliveries: a bad signature and a 400-second-old delivery got 401, `draft.amount_mismatch` left the invoice waiting as `needs_review`, `draft.confirmed` resumed the graph to `paid`, and the same delivery again was ignored. The free-text intake was tested with a fake model only.

Docs: https://send21.io/docs/mcp and https://send21.io/docs/webhooks · Questions: info@send21.io
