<?php

declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

$passed = 0;
$failed = 0;
function check(string $name, callable $fn): void
{
    global $passed, $failed;
    try {
        $fn();
        $passed++;
        echo "ok   {$name}\n";
    } catch (Throwable $e) {
        $failed++;
        echo "FAIL {$name}: {$e->getMessage()}\n";
    }
}
function same(mixed $expected, mixed $actual, string $msg = ''): void
{
    if ($expected !== $actual) {
        throw new Exception(($msg ? $msg . ': ' : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

const SECRET = 'whsec_test_only_not_a_real_secret';
$config = [
    'api_key' => 's21_test_only',
    'webhook_secret' => SECRET,
    'options' => '[{"currency":"Usdc","network":"Base","address":"0xReceiver"},{"currency":"Btc","network":"Mainnet","address":"you@wallet.com","method":"Lightning"}]',
    'decline_note' => '',
    'expiry_hours' => '48',
];
$invoice = ['id' => 1042, 'serie' => 'FOSS', 'nr' => '00042', 'currency' => 'EUR', 'total' => '46.00', 'status' => 'unpaid', 'client' => ['id' => 9]];

function adapter(array $config, FakeDb $db): Payment_Adapter_Send21
{
    $a = new Payment_Adapter_Send21($config);
    $di = new Pimple\Container();
    $di['db'] = $db;
    $a->setDi($di);

    return $a;
}

function delivery(array $body, string $deliveryId, ?int $t = null, string $secret = SECRET): array
{
    $raw = json_encode($body, JSON_UNESCAPED_SLASHES);
    $t ??= time();

    return [
        'http_raw_post_data' => $raw,
        'server' => [
            'HTTP_X_SEND21_DELIVERY' => $deliveryId,
            'HTTP_X_SEND21_EVENT' => $body['event'],
            'HTTP_X_SEND21_SIGNATURE_V2' => Payment_Adapter_Send21::signV2($raw, $deliveryId, $t, $secret),
        ],
    ];
}

$confirmed = ['event' => 'draft.confirmed', 'data' => [
    'draftId' => '3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c', 'quoteId' => '9b2e7c41-6a3d-4f8e-b1c5-0d9a8e7f6c2b', 'status' => 'Confirmed',
    'txId' => '5KqZ9bQ...', 'confirmations' => 1, 'sentCurrency' => 'USDC', 'network' => 'Solana', 'amountSats' => 50000000,
    'sentAmount' => '50.000000', 'fiatCurrency' => 'EUR', 'fiatAmount' => 46, 'conversionRate' => 0.92,
    'paymentRequestId' => '8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b', 'orderId' => 'fossbilling-invoice-1042',
    'confirmedAt' => '2026-10-06T08:22:21.000Z', 'occurredAt' => '2026-10-06T08:22:22.000Z',
]];

check('config needs key, secret and options', function () {
    try {
        new Payment_Adapter_Send21(['api_key' => 's21_x']);
        throw new Exception('no exception');
    } catch (Payment_Exception $e) {
        same(4001, $e->getCode());
    }
});

check('getConfig declares the admin form', function () {
    $c = Payment_Adapter_Send21::getConfig();
    same(true, $c['supports_one_time_payments']);
    same(['api_key', 'webhook_secret', 'options', 'decline_note', 'expiry_hours'], array_keys($c['form']));
});

check('payment request body matches the send21 API', function () use ($invoice, $config) {
    $r = Payment_Adapter_Send21::buildPaymentRequest($invoice, Payment_Adapter_Send21::parseOptions($config['options']), '', 48);
    same('fossbilling-invoice-1042-46.00', $r['idempotency_key']);
    same('EUR', $r['body']['fiatCurrency']);
    same(46.0, $r['body']['fiatAmount']);
    same('fossbilling-invoice-1042', $r['body']['orderId']);
    same('Invoice FOSS00042', $r['body']['memo']);
    same(48, $r['body']['expiryHours']);
    same(true, $r['body']['reuseOpenForOrder']);
    same(Payment_Adapter_Send21::DEFAULT_DECLINE_NOTE, $r['body']['declineNote']);
    same('Lightning', $r['body']['options'][1]['method']);
    same(720, Payment_Adapter_Send21::buildPaymentRequest($invoice, [], '', 5000)['body']['expiryHours']);
});

check('declineNote is plain text, max 200 characters', function () {
    same('Service paused', Payment_Adapter_Send21::cleanDeclineNote('<b>Service</b>   paused'));
    same(200, mb_strlen(Payment_Adapter_Send21::cleanDeclineNote(str_repeat('x', 400))));
});

check('bad receiving options are refused', function () {
    foreach (['[]', '[{"currency":"Doge","network":"Base","address":"0x1"}]', '[{"currency":"Usdc","network":"Base","address":""}]', 'nope'] as $bad) {
        try {
            Payment_Adapter_Send21::parseOptions($bad);
            throw new Exception('accepted ' . $bad);
        } catch (Payment_Exception) {
        }
    }
});

check('getHtml creates the pay link with Idempotency-Key and shows a light card', function () use ($config, $invoice) {
    $a = adapter($config, new FakeDb());
    $seen = [];
    $a->setHttpClient(function ($method, $url, $headers, $body) use (&$seen) {
        $seen = compact('method', 'url', 'headers', 'body');

        return ['status' => 201, 'body' => json_encode(['id' => 'pr_1', 'payPath' => '/pay/abc123'])];
    });
    $html = $a->getHtml(new FakeApiAdmin([1042 => $invoice]), 1042, false);
    same('POST', $seen['method']);
    same('https://send21.io/api/v1/payment-requests', $seen['url']);
    same(true, in_array('Idempotency-Key: fossbilling-invoice-1042-46.00', $seen['headers'], true));
    same(true, str_contains($html, 'href="https://send21.io/pay/abc123"'));
    same(true, str_contains($html, 'own wallet'));
    same(true, str_contains($html, '#FFFFFF'));
});

check('a paid invoice shows no pay link', function () use ($config, $invoice) {
    $a = adapter($config, new FakeDb());
    $a->setHttpClient(fn () => throw new Exception('should not call the API'));
    $html = $a->getHtml(new FakeApiAdmin([1042 => ['status' => 'paid'] + $invoice]), 1042, false);
    same(false, str_contains($html, 'href='));
});

check('signature V2: valid, too old, wrong delivery id, wrong body', function () {
    $raw = '{"event":"test"}';
    $now = 1790000000;
    $h = Payment_Adapter_Send21::signV2($raw, 'dlv_1', $now, SECRET);
    same(true, Payment_Adapter_Send21::verifySignatureV2($raw, $h, 'dlv_1', SECRET, $now + 299));
    same(false, Payment_Adapter_Send21::verifySignatureV2($raw, $h, 'dlv_1', SECRET, $now + 301));
    same(false, Payment_Adapter_Send21::verifySignatureV2($raw, $h, 'dlv_2', SECRET, $now));
    same(false, Payment_Adapter_Send21::verifySignatureV2($raw . ' ', $h, 'dlv_1', SECRET, $now));
    same(false, Payment_Adapter_Send21::verifySignatureV2($raw, null, 'dlv_1', SECRET, $now));
});

check('draft.confirmed pays the invoice once; a retry with the same delivery id is ignored', function () use ($config, $invoice, $confirmed) {
    $db = new FakeDb();
    $api = new FakeApiAdmin([1042 => $invoice]);
    $a = adapter($config, $db);
    $d = delivery($confirmed, 'dlv_1');
    $a->processTransaction($api, 1, $d, 7);
    same(['invoice_get', 'invoice_transaction_update', 'client_balance_add_funds', 'invoice_pay_with_credits'], $api->names());
    same(46, $api->calls[2][1]['amount']);
    same('5KqZ9bQ...', $api->calls[2][1]['rel_id']);
    same('send21-delivery:dlv_1', $db->rows[1]->note);

    $api->calls = [];
    $a->processTransaction($api, 2, $d, 7);
    same([], $api->names(), 'retry must not touch the invoice');
    same('duplicate', $db->rows[2]->txn_status);
});

check('another delivery for an already paid invoice does nothing', function () use ($config, $invoice, $confirmed) {
    $api = new FakeApiAdmin([1042 => ['status' => 'paid'] + $invoice]);
    adapter($config, new FakeDb())->processTransaction($api, 1, delivery($confirmed, 'dlv_9'), 7);
    same(['invoice_get'], $api->names());
});

check('bad or old signatures are refused before anything happens', function () use ($config, $invoice, $confirmed) {
    foreach ([delivery($confirmed, 'dlv_1', time() - 600), delivery($confirmed, 'dlv_1', null, 'wrong_secret')] as $d) {
        $api = new FakeApiAdmin([1042 => $invoice]);
        try {
            adapter($config, new FakeDb())->processTransaction($api, 1, $d, 7);
            throw new Exception('accepted');
        } catch (Payment_Exception $e) {
            same(401, $e->getCode());
        }
        same([], $api->names());
    }
});

check('a different amount or currency is not paid', function () use ($config, $invoice, $confirmed) {
    $c = $confirmed;
    $c['data']['fiatAmount'] = 40;
    $db = new FakeDb();
    $api = new FakeApiAdmin([1042 => $invoice]);
    adapter($config, $db)->processTransaction($api, 1, delivery($c, 'dlv_2'), 7);
    same(['invoice_get'], $api->names());
    same('send21: needs your decision', $db->rows[1]->error);
});

check('amount mismatch and expiry are logged, not paid', function () use ($config, $invoice) {
    foreach (['draft.amount_mismatch', 'payment_request.expired'] as $event) {
        $api = new FakeApiAdmin([1042 => $invoice]);
        adapter($config, new FakeDb())->processTransaction($api, 1, delivery(['event' => $event, 'data' => ['orderId' => 'fossbilling-invoice-1042', 'opened' => true]], 'dlv_' . $event), 7);
        same(['invoice_get'], $api->names());
    }
});

check('deliveries for other orders are ignored', function () use ($config, $invoice) {
    $api = new FakeApiAdmin([1042 => $invoice]);
    adapter($config, new FakeDb())->processTransaction($api, 1, delivery(['event' => 'draft.confirmed', 'data' => ['orderId' => 'shop-1']], 'dlv_x'), 7);
    same([], $api->names());
});

echo "\n{$passed} passed, {$failed} failed\n";
exit($failed === 0 ? 0 : 1);
