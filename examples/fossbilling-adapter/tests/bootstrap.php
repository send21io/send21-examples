<?php

declare(strict_types=1);
// Minimal stand-ins for the FOSSBilling classes the adapter touches, so the tests run with
// plain PHP 8.1+ and no FOSSBilling checkout.

namespace FOSSBilling {
    interface InjectionAwareInterface
    {
        public function setDi(\Pimple\Container $di): void;

        public function getDi(): ?\Pimple\Container;
    }
}

namespace Pimple {
    class Container implements \ArrayAccess
    {
        private array $values = [];

        public function offsetExists(mixed $k): bool { return isset($this->values[$k]); }
        public function offsetGet(mixed $k): mixed { return $this->values[$k]; }
        public function offsetSet(mixed $k, mixed $v): void { $this->values[$k] = $v; }
        public function offsetUnset(mixed $k): void { unset($this->values[$k]); }
    }
}

namespace {
    class Payment_Exception extends Exception
    {
        public function __construct(string $message, array $vars = [], int $code = 0)
        {
            parent::__construct(strtr($message, $vars), $code);
        }
    }

    /** Records every admin API call and serves invoices from memory. */
    class FakeApiAdmin
    {
        public array $calls = [];

        public function __construct(public array $invoices) {}

        public function __call(string $name, array $args): mixed
        {
            $this->calls[] = [$name, $args[0] ?? []];
            if ($name === 'invoice_get') {
                return $this->invoices[$args[0]['id']] ?? throw new Payment_Exception('Invoice not found');
            }
            if ($name === 'invoice_pay_with_credits') {
                $this->invoices[$args[0]['id']]['status'] = 'paid';
            }

            return true;
        }

        public function names(): array { return array_column($this->calls, 0); }
    }

    /** A tiny in-memory stand-in for FOSSBilling's RedBean database service. */
    class FakeDb
    {
        public array $rows = [];

        public function load(string $type, int|string $id): object
        {
            return $this->rows[(int) $id] ??= (object) ['id' => (int) $id, 'gateway_id' => 7, 'txn_status' => null, 'note' => null];
        }

        public function store(object $row): void { $this->rows[$row->id] = $row; }

        public function findOne(string $type, string $sql, array $p): ?object
        {
            foreach ($this->rows as $row) {
                if ($row->gateway_id == $p[':g'] && $row->note === $p[':n'] && $row->id != $p[':id']) {
                    return $row;
                }
            }

            return null;
        }
    }

    require __DIR__ . '/../src/library/Payment/Adapter/Send21.php';
}
