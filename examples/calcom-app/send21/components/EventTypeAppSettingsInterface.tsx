import { useEffect } from "react";

import type { EventTypeAppSettingsComponent } from "@calcom/app-store/types";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Alert } from "@calcom/ui/components/alert";
import { Select, TextField } from "@calcom/ui/components/form";

// Any of send21's 161 fiat currencies works; these are the common ones for bookings.
const currencyOptions = ["EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "CAD", "AUD", "JPY"].map((c) => ({
  label: c,
  value: c,
}));
const ZERO_DECIMAL = ["JPY"];
const toMinor = (amount: number, currency: string) =>
  ZERO_DECIMAL.includes(currency) ? Math.round(amount) : Math.round(amount * 100);
const fromMinor = (amount: number, currency: string) => (ZERO_DECIMAL.includes(currency) ? amount : amount / 100);

const EventTypeAppSettingsInterface: EventTypeAppSettingsComponent = ({ eventType, getAppData, setAppData }) => {
  const { t } = useLocale();
  const price = getAppData("price");
  const currency = getAppData("currency") || "EUR";
  const recurringEventDefined = eventType.recurringEvent?.count !== undefined;

  useEffect(() => {
    if (!getAppData("currency")) setAppData("currency", "EUR");
    if (!getAppData("paymentOption")) setAppData("paymentOption", "ON_BOOKING");
  }, [getAppData, setAppData]);

  if (recurringEventDefined) {
    return <Alert className="mt-2" severity="warning" title={t("warning_recurring_event_payment")} />;
  }

  return (
    <div className="mt-4 flex flex-wrap items-end gap-4">
      <TextField
        label={t("price")}
        type="number"
        min="1"
        step="0.01"
        required
        className="w-auto"
        value={price && price > 0 ? fromMinor(price, currency) : undefined}
        onChange={(e) => setAppData("price", toMinor(Number(e.target.value), currency))}
      />
      <div className="w-40">
        <label className="text-default mb-1 block text-sm font-medium">{t("currency")}</label>
        <Select
          variant="default"
          options={currencyOptions}
          value={currencyOptions.find((o) => o.value === currency)}
          onChange={(o) => o && setAppData("currency", o.value)}
        />
      </div>
      <p className="text-subtle w-full text-sm">
        The booker pays from their own wallet on the send21 pay page. The booking is confirmed when the payment
        confirms, and released if the pay link expires unpaid.
      </p>
    </div>
  );
};

export default EventTypeAppSettingsInterface;
