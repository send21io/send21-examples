import type z from "zod";

import { ErrorCode } from "@calcom/lib/errorCodes";
import logger from "@calcom/lib/logger";
import type { IBookingPaymentRepository } from "@calcom/features/bookings/repositories/BookingPaymentRepository.interface";
import { PrismaBookingPaymentRepository } from "@calcom/features/bookings/repositories/PrismaBookingPaymentRepository";
import type { Booking, Payment, PaymentOption, Prisma } from "@calcom/prisma/client";
import type { CalendarEvent } from "@calcom/types/Calendar";
import type { IAbstractPaymentService } from "@calcom/types/PaymentService";

import appConfig from "../config.json";
import { send21CredentialKeysSchema } from "./credentialKeysSchema";
import { buildPaymentRequest, payLinkFromPath, SEND21_BASE_URL } from "./send21";

const log = logger.getSubLogger({ prefix: ["payment-service:send21"] });

class Send21PaymentService implements IAbstractPaymentService {
  private credentials: z.infer<typeof send21CredentialKeysSchema> | null;

  constructor(
    credentials: { key: Prisma.JsonValue },
    private bookingPaymentRepository: IBookingPaymentRepository = new PrismaBookingPaymentRepository()
  ) {
    const parsed = send21CredentialKeysSchema.safeParse(credentials.key);
    this.credentials = parsed.success ? parsed.data : null;
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"],
    _userId: Booking["userId"],
    _username: string | null,
    _bookerName: string,
    _paymentOption: PaymentOption,
    _bookerEmail: string,
    _bookerPhoneNumber?: string | null,
    eventTitle?: string,
    bookingTitle?: string
  ) {
    if (!this.credentials) throw new Error("send21: app is not set up");
    try {
      const { body, idempotencyKey } = buildPaymentRequest(
        {
          bookingId,
          amountMinor: payment.amount,
          currency: payment.currency,
          title: bookingTitle || eventTitle,
          declineNote: this.credentials.declineNote,
          expiryHours: this.credentials.expiryHours,
        },
        this.credentials.options
      );
      const response = await fetch(`${SEND21_BASE_URL}/api/v1/payment-requests`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`send21 API ${response.status}: ${await response.text()}`);
      const paymentRequest = await response.json();

      const paymentData = await this.bookingPaymentRepository.createPaymentRecord({
        uid: crypto.randomUUID(),
        app: { connect: { slug: appConfig.slug } },
        booking: { connect: { id: bookingId } },
        amount: payment.amount,
        currency: payment.currency,
        externalId: paymentRequest.id,
        fee: 0,
        success: false,
        refunded: false,
        data: {
          orderId: body.orderId,
          payLink: payLinkFromPath(paymentRequest.payPath),
          expiresAt: paymentRequest.expiresAt,
          handledDeliveries: [],
        },
      });
      if (!paymentData) throw new Error("Failed to store Payment data");
      return paymentData;
    } catch (error) {
      log.error("send21: pay link could not be created", bookingId, String(error));
      throw new Error(ErrorCode.PaymentCreationFailure);
    }
  }

  async update(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  // Crypto payments cannot be pulled back. send21 never holds funds, so a refund is a
  // new payment the owner sends from their own wallet. Mark it refunded in Cal.com after that.
  async refund(): Promise<Payment> {
    throw new Error("send21: refunds are manual, from your own wallet");
  }

  async collectCard(): Promise<Payment> {
    throw new Error("Method not implemented");
  }

  async chargeCard(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  async getPaymentPaidStatus(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async getPaymentDetails(): Promise<Payment> {
    throw new Error("Method not implemented.");
  }

  async afterPayment(_event: CalendarEvent, _booking: unknown, _paymentData: Payment): Promise<void> {
    return Promise.resolve();
  }

  deletePayment(_paymentId: number): Promise<boolean> {
    return Promise.resolve(false);
  }

  isSetupAlready(): boolean {
    return !!this.credentials;
  }
}

export function BuildPaymentService(credentials: { key: Prisma.JsonValue }): IAbstractPaymentService {
  return new Send21PaymentService(credentials);
}
