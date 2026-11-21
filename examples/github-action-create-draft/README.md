# GitHub Action: create a send21 draft and comment its status

A composite [GitHub Action](https://docs.github.com/en/actions) that creates a [send21](https://send21.io/) payment draft with a scoped API key and comments the draft id and status on an issue or pull request.

**The key cannot move funds.** The workflow only prepares the payment. A person signs and sends it from their own wallet. send21 never holds keys or funds, never signs and never broadcasts. Store the key as a GitHub secret (`SEND21_API_KEY`); never commit it and never use a key that could broadcast a transaction — send21 keys cannot do that anyway.

This is a useful hook for a maintainer payout after a merge or a labelled issue. It is not a bug-bounty desk and it does not escrow funds.

## Use it

After this folder is on `main` in `send21io/send21-examples`:

```yaml
- uses: send21io/send21-examples/examples/github-action-create-draft@main
  with:
    api-key: ${{ secrets.SEND21_API_KEY }}
    receiver-address: ${{ vars.SEND21_RECEIVER_ADDRESS }}
    network: Solana
    currency: Usdc
    fiat-currency: EUR
    fiat-amount: "25"
```

A complete workflow is in [`example-workflow.yml`](example-workflow.yml). It runs when an issue is labelled `payout-ready`.

The key needs `drafts:write` (and `drafts:read` to print status). On default ApprovedOnly accounts, `receiver-address` must already be approved in send21 (passkey or authenticator code). Account keys use the live networks; https://send21.io/demo is the testnet demo.

The default idempotency key is `send21-draft-<owner>/<repo>#<issue-number>`, so re-running the workflow on the same issue returns the same draft instead of creating another one.

`expiryHours` is 1 to 720 (default 24) and never moves once the draft is created. Status values are `AwaitingPayment`, `Seen`, `Confirmed`, `Expired` and `Cancelled`. Once confirmed, `confirmedAt` is set once.

## Inputs and outputs

See [`action.yml`](action.yml). Notable inputs: `fiat-amount` or `amount-sats`, `issue-number` (defaults to the current issue or pull request), and `comment` (set to `false` to skip the comment). Outputs: `draft-id`, `status`, `payment-uri`, `comment-url`.

The comment tells reviewers that the draft is only prepared, and that a person must sign and send from their own wallet.

## Tests

```sh
cd examples/github-action-create-draft
npm test
```

The tests cover request-body building and the comment wording. They do not call the live API.

Docs: https://send21.io/docs/quickstart · Questions: info@send21.io
