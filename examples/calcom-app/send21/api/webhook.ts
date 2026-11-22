import type { NextApiRequest, NextApiResponse } from "next";
import getRawBody from "raw-body";

import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { PrismaBookingPaymentRepository as BookingPaymentRepository } from "@calcom/features/bookings/repositories/PrismaBookingPaymentRepository";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import prisma from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";

import appConfig from "../config.json";
import { send21CredentialKeysSchema } from "../lib/credentialKeysSchema";
import { alreadyHandled, decide, rememberDelivery, verifySignatureV2 } from "../lib/send21";

export const config = { api: { bodyParser: false } };

// Register https://<your-cal-domain>/api/integrations/send21/webhook in send21
// (POST /api/v1/webhooks, scope webhooks:manage) for draft.confirmed,
// draft.amount_mismatch and payment_request.expired.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });

  const rawBody = await getRawBody(req);
  const deliveryId = req.headers["x-send21-delivery"];
  const signature = req.headers["x-send21-signature-v2"];

  let body: { event?: string; data?: Record<string, unknown> };
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ message: "Invalid JSON" });
  }
  const data = body.data ?? {};
  // Parsed only to find which payment (and so which signing secret) this is. Nothing is
  // changed before the signature is checked.
  const paymentRequestId = typeof data.paymentRequestId === "string" ? data.paymentRequestId : null;
  if (!paymentRequestId) return res.status(200).json({ message: "Ignored: no pay link" });

  const repository = new BookingPaymentRepository();
  const payment = await repository.findByExternalIdIncludeBookingUserCredentials(paymentRequestId, appConfig.type);
  if (!payment) return res.status(404).json({ message: "Payment not found" });

  const key = send21CredentialKeysSchema.safeParse(payment.booking?.user?.credentials?.[0]?.key);
  if (!key.success) return res.status(400).json({ message: "send21 app is not set up" });

  if (!verifySignatureV2(rawBody, signature, deliveryId, key.data.webhookSecret)) {
    return res.status(401).json({ message: "Bad signature" });
  }

  const stored = (payment.data ?? {}) as { handledDeliveries?: string[] };
  if (alreadyHandled(stored.handledDeliveries, deliveryId as string)) {
    return res.status(200).json({ message: "Already handled" });
  }

  const decision = decide(String(body.event), data, {
    externalId: payment.externalId,
    success: payment.success,
    amountMinor: payment.amount,
    currency: payment.currency,
    bookingId: payment.bookingId,
  });

  // Act first, then record the delivery id. If acting fails we answer 500, send21 retries
  // with the same X-Send21-Delivery, and the retry is handled instead of skipped.
  if (decision.action === "confirm") {
    const traceContext = distributedTracing.createTrace("send21_webhook", {
      meta: { paymentId: payment.id, bookingId: payment.bookingId },
    });
    await handlePaymentSuccess({ paymentId: payment.id, bookingId: payment.bookingId, appSlug: appConfig.slug, traceContext });
  } else if (decision.action === "release") {
    await prisma.booking.update({
      where: { id: payment.bookingId },
      data: { status: BookingStatus.CANCELLED, cancellationReason: "Payment link expired unpaid" },
    });
  }

  const nextData = {
    ...stored,
    handledDeliveries: rememberDelivery(stored.handledDeliveries, deliveryId as string),
    lastEvent: { event: body.event, decision: decision.action, note: decision.note, txId: data.txId ?? null },
  };
  await prisma.payment.update({ where: { id: payment.id }, data: { data: nextData } });
  return res.status(200).json({ received: true, action: decision.action });
}
