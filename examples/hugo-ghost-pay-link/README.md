# Hugo shortcode and Ghost embed for a send21 pay link

A light pay button you can drop into a [Hugo](https://gohugo.io/) site or a [Ghost](https://ghost.org/) post. It links to a [send21](https://send21.io/) pay link. The payer signs and sends from their own wallet; send21 never holds keys or funds.

Static sites have no server, so this button points at a **pay link you already created** (in the send21 app, or with `POST /api/v1/payment-requests`). For a new link per order, put a tiny backend in front — the [checkout-component](../checkout-component) example shows that pattern, and [webhook-receiver](../webhook-receiver) shows how to verify `X-Send21-Signature-V2` when the payment confirms.

The UI is white with soft neutrals. Send21 orange (`#F7931A`) is used only on the button.

## Hugo

Copy `layouts/shortcodes/send21-pay.html` into your Hugo site's `layouts/shortcodes/` folder, and add `assets/css/send21-pay.css` to your theme (or import it from your main stylesheet).

In a post:

```markdown
{{</* send21-pay link="https://send21.io/pay/..." amount="20" currency="EUR" label="Pay with crypto" */>}}
```

Parameters:

| Parameter | Required | Meaning |
| --- | --- | --- |
| `link` | yes | The full pay link (`https://send21.io` plus `payPath`) |
| `amount` | no | Shown above the button, for example `20` |
| `currency` | no | Fiat code next to the amount, for example `EUR` |
| `label` | no | Button text, default `Pay with crypto` |
| `note` | no | Overrides the short line under the button |

Create the pay link with a scoped key (`drafts:write`). New accounts only accept receiving addresses the owner approved. Account keys use the live networks; https://send21.io/demo is the testnet demo. `expiryHours` is 1 to 720 (default 24) and never moves once the link is created.

## Ghost

1. Create a pay link in send21 and copy it.
2. In Ghost, add a **HTML** card and paste `ghost-embed.html`.
3. Replace `https://send21.io/pay/REPLACE_ME` with your pay link, and edit the amount if you want.
4. Optionally move the `<style>` block to Settings → Code injection → Site header so every post can reuse the classes.

## Tests

```sh
cd examples/hugo-ghost-pay-link
npm test
```

Docs: https://send21.io/docs/quickstart · Questions: info@send21.io
