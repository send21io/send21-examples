<?php

declare(strict_types=1);
/**
 * send21 payment adapter for FOSSBilling (https://fossbilling.org).
 *
 * send21 (https://send21.io) is non-custodial: it prepares a pay link, the client signs and
 * sends from their own wallet straight to your receiving address, and send21 tells you when
 * the payment confirms. send21 never holds keys or funds. The API key used here can create
 * pay links (drafts:read, drafts:write) and cannot move funds.
 *
 * Install: copy this file to src/library/Payment/Adapter/Send21.php and send21.png to
 * src/public/gateways/. Then Settings -> Payment gateways -> New payment gateway -> send21.
 * Register the webhook URL https://<billing-host>/ipn.php?gateway_id=<id> in send21.
 *
 * Product facts: https://send21.io/llms-full.txt and https://send21.io/swagger/v1/swagger.json
 *
 * @license MIT
 */
class Payment_Adapter_Send21 implements FOSSBilling\InjectionAwareInterface
{
    public const API_BASE = 'https://send21.io';
    public const TOLERANCE_SECONDS = 300;
    public const DECLINE_NOTE_MAX = 200;
    public const DEFAULT_DECLINE_NOTE = 'The invoice stays unpaid and the service is not started or renewed.';
    public const CURRENCIES = ['Btc', 'Usdc', 'Usdt', 'Eurc', 'Sol', 'Eth'];
    public const NETWORKS = ['Mainnet', 'Solana', 'Ethereum', 'Base', 'Arbitrum', 'Polygon'];
    public const METHODS = ['MultiOutput', 'Lightning'];

    protected ?Pimple\Container $di = null;

    /** @var callable|null fn(string $method, string $url, array $headers, ?string $body): array{status:int, body:string} */
    private $http;

    public function __construct(private $config)
    {
        foreach (['api_key' => 'send21 API key', 'webhook_secret' => 'webhook signing secret', 'options' => 'receiving options'] as $key => $label) {
            if (empty($this->config[$key])) {
                throw new Payment_Exception('The ":pay_gateway" payment gateway is not fully configured. Please configure the :missing', [':pay_gateway' => 'send21', ':missing' => $label], 4001);
            }
        }
    }

    public function setDi(Pimple\Container $di): void
    {
        $this->di = $di;
    }

    public function getDi(): ?Pimple\Container
    {
        return $this->di;
    }

    /** For tests: replace the HTTP call. */
    public function setHttpClient(callable $http): void
    {
        $this->http = $http;
    }

    public static function getConfig(): array
    {
        return [
            'supports_one_time_payments' => true,
            'supports_subscriptions' => false,
            'description' => 'Accept BTC (on-chain or Lightning), USDC, USDT, EURC, SOL and ETH with a send21 pay link. The client signs and sends from their own wallet straight to your address; send21 never holds funds. Register https://<your-host>/ipn.php?gateway_id=<this gateway id> as the send21 webhook URL. Refunds are manual, from your own wallet.',
            'logo' => [
                'logo' => 'send21.png',
                'height' => '30px',
                'width' => '90px',
            ],
            'form' => [
                'api_key' => [
                    'text',
                    ['label' => 'send21 API key (scopes drafts:read and drafts:write; it cannot move funds)'],
                ],
                'webhook_secret' => [
                    'text',
                    ['label' => 'Webhook signing secret (returned once by POST /api/v1/webhooks)'],
                ],
                'options' => [
                    'textarea',
                    ['label' => 'Receiving options as JSON, for example [{"currency":"Usdc","network":"Base","address":"0x..."},{"currency":"Btc","network":"Mainnet","address":"you@wallet.com","method":"Lightning"}]'],
                ],
                'decline_note' => [
                    'text',
                    ['label' => 'Shown on the pay page as "If you don\'t pay:" (optional, max 200 characters)', 'required' => false],
                ],
                'expiry_hours' => [
                    'text',
                    ['label' => 'Pay link open for this many hours, 1 to 720 (default 24)', 'required' => false],
                ],
            ],
        ];
    }

    // ---------------------------------------------------------------- pay link

    public function getHtml($api_admin, $invoice_id, $subscription): string
    {
        $invoice = $api_admin->invoice_get(['id' => $invoice_id]);
        if (($invoice['status'] ?? '') === 'paid') {
            return self::card('This invoice is paid. Thank you.', null, $invoice);
        }
        $request = self::buildPaymentRequest(
            $invoice,
            self::parseOptions((string) $this->config['options']),
            (string) ($this->config['decline_note'] ?? ''),
            (int) ($this->config['expiry_hours'] ?? 24)
        );
        $response = $this->call('POST', '/api/v1/payment-requests', $request['body'], $request['idempotency_key']);
        if (empty($response['payPath']) || !is_string($response['payPath']) || $response['payPath'][0] !== '/') {
            throw new Payment_Exception('send21 did not return a pay link');
        }

        return self::card(null, self::API_BASE . $response['payPath'], $invoice);
    }

    public static function orderIdForInvoice(int|string $invoiceId): string
    {
        return 'fossbilling-invoice-' . $invoiceId;
    }

    public static function cleanDeclineNote(string $note): string
    {
        $text = trim((string) preg_replace('/\s+/u', ' ', strip_tags($note)));
        if ($text === '') {
            $text = self::DEFAULT_DECLINE_NOTE;
        }
        if (mb_strlen($text) > self::DECLINE_NOTE_MAX) {
            $text = rtrim(mb_substr($text, 0, self::DECLINE_NOTE_MAX - 1)) . '…';
        }

        return $text;
    }

    public static function parseOptions(string $json): array
    {
        $list = json_decode($json, true);
        if (!is_array($list) || $list === [] || !array_is_list($list)) {
            throw new Payment_Exception('send21: add at least one receiving option');
        }
        $out = [];
        foreach ($list as $i => $o) {
            $n = $i + 1;
            if (!is_array($o) || !in_array($o['currency'] ?? null, self::CURRENCIES, true)) {
                throw new Payment_Exception("send21: option {$n} has an unknown currency");
            }
            if (!in_array($o['network'] ?? null, self::NETWORKS, true)) {
                throw new Payment_Exception("send21: option {$n} has an unknown network");
            }
            $address = trim((string) ($o['address'] ?? ''));
            if (strlen($address) < 3) {
                throw new Payment_Exception("send21: option {$n} has no address");
            }
            $item = ['currency' => $o['currency'], 'network' => $o['network'], 'address' => $address];
            if (isset($o['method'])) {
                if (!in_array($o['method'], self::METHODS, true)) {
                    throw new Payment_Exception("send21: option {$n} has an unknown method");
                }
                $item['method'] = $o['method'];
            }
            $out[] = $item;
        }

        return $out;
    }

    /** Body and Idempotency-Key for POST /api/v1/payment-requests. */
    public static function buildPaymentRequest(array $invoice, array $options, string $declineNote = '', int $expiryHours = 24): array
    {
        $total = round((float) $invoice['total'], 2);
        if ($total <= 0) {
            throw new Payment_Exception('send21: the invoice total must be above zero');
        }
        $orderId = self::orderIdForInvoice($invoice['id']);
        $number = trim(($invoice['serie'] ?? '') . ($invoice['nr'] ?? '')) ?: (string) $invoice['id'];

        return [
            // The same invoice and total gives the same key, so a reload never makes a second link.
            'idempotency_key' => $orderId . '-' . number_format($total, 2, '.', ''),
            'body' => [
                'fiatCurrency' => strtoupper((string) $invoice['currency']),
                'fiatAmount' => $total,
                'orderId' => $orderId,
                'memo' => mb_substr('Invoice ' . $number, 0, 140),
                'expiryHours' => max(1, min(720, $expiryHours ?: 24)),
                'declineNote' => self::cleanDeclineNote($declineNote),
                'reuseOpenForOrder' => true,
                'options' => $options,
            ],
        ];
    }

    private static function card(?string $message, ?string $link, array $invoice): string
    {
        $e = static fn ($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
        $amount = $e(number_format((float) ($invoice['total'] ?? 0), 2) . ' ' . ($invoice['currency'] ?? ''));
        $html = '<div style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;padding:20px;max-width:420px;color:#111827;font-family:system-ui,sans-serif">';
        $html .= '<p style="margin:0;color:#6B7280;font-size:14px">Amount due</p><p style="margin:4px 0 16px;font-size:24px;font-weight:600">' . $amount . '</p>';
        if ($link !== null) {
            $html .= '<a href="' . $e($link) . '" rel="noopener noreferrer" style="display:inline-block;background:#F7931A;color:#FFFFFF;padding:10px 18px;border-radius:8px;font-weight:600;text-decoration:none">Pay with crypto</a>';
            $html .= '<p style="margin:12px 0 0;color:#6B7280;font-size:13px">You sign and send from your own wallet, straight to us. The invoice is marked paid when the payment confirms.</p>';
        } else {
            $html .= '<p style="margin:0">' . $e($message) . '</p>';
        }

        return $html . '</div>';
    }

    private function call(string $method, string $path, ?array $body, ?string $idempotencyKey = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->config['api_key'], 'Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        $payload = $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $url = self::API_BASE . $path;

        if ($this->http !== null) {
            $res = ($this->http)($method, $url, $headers, $payload);
        } else {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 20,
            ]);
            if ($payload !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            }
            $raw = curl_exec($ch);
            $res = ['status' => (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'body' => is_string($raw) ? $raw : ''];
            curl_close($ch);
        }
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw new Payment_Exception('send21 API error :code', [':code' => $res['status']]);
        }

        return json_decode($res['body'], true) ?: [];
    }

    // ---------------------------------------------------------------- webhook

    public static function signV2(string $rawBody, string $deliveryId, int|string $timestamp, string $secret): string
    {
        return 't=' . $timestamp . ',v1=' . hash_hmac('sha256', $timestamp . '.' . $deliveryId . '.' . $rawBody, $secret);
    }

    /** X-Send21-Signature-V2: HMAC over "<t>.<delivery id>.<raw body>", constant time, 5-minute window. */
    public static function verifySignatureV2(string $rawBody, ?string $header, ?string $deliveryId, string $secret, ?int $now = null): bool
    {
        if ($secret === '' || !$header || !$deliveryId) {
            return false;
        }
        if (!preg_match('/(?:^|,)\s*t=(\d+)/', $header, $t) || !preg_match('/(?:^|,)\s*v1=([0-9a-f]{64})/', $header, $v1)) {
            return false;
        }
        if (abs(($now ?? time()) - (int) $t[1]) > self::TOLERANCE_SECONDS) {
            return false;
        }
        $expected = hash_hmac('sha256', $t[1] . '.' . $deliveryId . '.' . $rawBody, $secret);

        return hash_equals($expected, $v1[1]);
    }

    /**
     * What a verified delivery means for the invoice.
     *
     * @return array{action: string, note: string}
     */
    public static function decide(string $event, array $data, array $invoice): array
    {
        $orderId = self::orderIdForInvoice($invoice['id']);
        if (($data['orderId'] ?? null) !== $orderId) {
            return ['action' => 'ignore', 'note' => 'orderId does not match the invoice'];
        }
        if ($event === 'draft.confirmed') {
            if (($invoice['status'] ?? '') === 'paid') {
                return ['action' => 'ignore', 'note' => 'invoice already paid'];
            }
            $sameCurrency = strtoupper((string) ($data['fiatCurrency'] ?? '')) === strtoupper((string) $invoice['currency']);
            $sameAmount = isset($data['fiatAmount']) && round((float) $data['fiatAmount'], 2) === round((float) $invoice['total'], 2);
            if (!$sameCurrency || !$sameAmount) {
                return ['action' => 'review', 'note' => sprintf('confirmed %s %s, invoice is %s %s', $data['fiatAmount'] ?? '?', $data['fiatCurrency'] ?? '?', $invoice['total'], $invoice['currency'])];
            }

            return ['action' => 'pay', 'note' => sprintf('send21 %s %s on %s, tx %s', $data['sentAmount'] ?? '', $data['sentCurrency'] ?? '', $data['network'] ?? '', $data['txId'] ?? '')];
        }
        if (in_array($event, ['draft.amount_mismatch', 'draft.mismatch_reminder', 'draft.mismatch_unresolved'], true)) {
            return ['action' => 'review', 'note' => $event . ': a different amount arrived. Accept or decline it in send21; refunds are manual.'];
        }
        if ($event === 'payment_request.expired') {
            return ['action' => 'log', 'note' => 'pay link expired unpaid' . (!empty($data['opened']) ? ' (opened)' : '') . '; the invoice stays unpaid'];
        }

        return ['action' => 'ignore', 'note' => 'event ' . $event . ' not used'];
    }

    /**
     * Called by FOSSBilling's ipn.php for each delivery. $data holds the raw body and the
     * request headers ($data['server']['HTTP_X_SEND21_*']).
     */
    public function processTransaction($api_admin, $id, $data, $gateway_id): void
    {
        $raw = (string) ($data['http_raw_post_data'] ?? '');
        $server = $data['server'] ?? [];
        $deliveryId = isset($server['HTTP_X_SEND21_DELIVERY']) ? (string) $server['HTTP_X_SEND21_DELIVERY'] : null;
        $signature = isset($server['HTTP_X_SEND21_SIGNATURE_V2']) ? (string) $server['HTTP_X_SEND21_SIGNATURE_V2'] : null;

        if (!self::verifySignatureV2($raw, $signature, $deliveryId, (string) $this->config['webhook_secret'])) {
            throw new Payment_Exception('send21: invalid or expired webhook signature', [], 401);
        }

        // Retries reuse X-Send21-Delivery and send21 does not dedupe: skip ids already handled.
        $db = $this->di['db'];
        $seen = $db->findOne('Transaction', 'gateway_id = :g AND note = :n AND id != :id', [':g' => $gateway_id, ':n' => 'send21-delivery:' . $deliveryId, ':id' => $id]);
        if ($seen) {
            $this->finish($id, 'duplicate', 'already handled in transaction #' . $seen->id, $deliveryId);

            return;
        }

        $body = json_decode($raw, true);
        $event = (string) ($body['event'] ?? '');
        $payload = is_array($body['data'] ?? null) ? $body['data'] : [];
        $orderId = (string) ($payload['orderId'] ?? '');
        if (!preg_match('/^fossbilling-invoice-(\d+)$/', $orderId, $m)) {
            $this->finish($id, $event, 'not a FOSSBilling invoice payment', $deliveryId);

            return;
        }

        $invoice = $api_admin->invoice_get(['id' => (int) $m[1]]);
        $decision = self::decide($event, $payload, $invoice);

        if ($decision['action'] === 'pay') {
            $txId = (string) ($payload['txId'] ?? '');
            $api_admin->invoice_transaction_update([
                'id' => $id,
                'invoice_id' => $invoice['id'],
                'txn_id' => $txId,
                'txn_status' => 'Confirmed',
                'amount' => $payload['fiatAmount'],
                'currency' => strtoupper((string) $payload['fiatCurrency']),
                'type' => 'payment',
            ]);
            $api_admin->client_balance_add_funds([
                'id' => $invoice['client']['id'],
                'amount' => $payload['fiatAmount'],
                'description' => 'send21 payment ' . $txId,
                'type' => 'send21',
                'rel_id' => $txId,
            ]);
            $api_admin->invoice_pay_with_credits(['id' => $invoice['id']]);
        }

        $this->finish($id, $event, $decision['note'], $deliveryId, $decision['action'] === 'review' ? 'send21: needs your decision' : null);
    }

    private function finish(int|string $id, string $status, string $note, ?string $deliveryId, ?string $error = null): void
    {
        $db = $this->di['db'];
        $tx = $db->load('Transaction', $id);
        $tx->txn_status = $tx->txn_status ?: $status;
        $tx->status = 'processed';
        $tx->error = $error;
        $tx->note = 'send21-delivery:' . $deliveryId;
        $tx->output = $note;
        $tx->updated_at = date('Y-m-d H:i:s');
        $db->store($tx);
    }
}
