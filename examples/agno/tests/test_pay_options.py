import unittest

from pay_options import SYSTEM_PROMPT, check_options, pay_link, receive_options


class PayOptionsTests(unittest.TestCase):
    def test_supported_combination(self):
        check_options([{"currency": "Usdc", "network": "Solana", "address": "Abc"}])

    def test_rejects_unsupported_network(self):
        with self.assertRaises(ValueError):
            check_options([{"currency": "Usdt", "network": "Base", "address": "Abc"}])

    def test_lightning_only_for_btc(self):
        with self.assertRaises(ValueError):
            check_options(
                [{"currency": "Usdc", "network": "Solana", "address": "Abc", "method": "Lightning"}]
            )

    def test_pay_link(self):
        self.assertEqual(pay_link("/pay/abc"), "https://send21.io/pay/abc")
        self.assertIsNone(pay_link(None))

    def test_placeholder_options(self):
        opts = receive_options(allow_placeholder=True)
        self.assertEqual(opts[0]["address"], "<your-solana-address>")

    def test_prompt_frames_preparation_not_spend_control(self):
        self.assertIn("signs and sends the payment from their own wallet", SYSTEM_PROMPT)
        self.assertNotIn("spend control", SYSTEM_PROMPT.lower())
        self.assertNotIn("spend limit", SYSTEM_PROMPT.lower())
        self.assertNotIn("gateway", SYSTEM_PROMPT.lower())
        self.assertNotIn("processor", SYSTEM_PROMPT.lower())
        self.assertNotIn("x402", SYSTEM_PROMPT.lower())


if __name__ == "__main__":
    unittest.main()
