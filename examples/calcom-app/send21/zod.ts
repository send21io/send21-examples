import { z } from "zod";

import { eventTypeAppCardZod } from "@calcom/app-store/eventTypeAppCardZod";

export const appDataSchema = eventTypeAppCardZod.merge(
  z.object({
    price: z.number(),
    currency: z.string(),
    paymentOption: z.string().optional(),
    enabled: z.boolean().optional(),
    credentialId: z.number().optional(),
  })
);

export const appKeysSchema = z.object({});
