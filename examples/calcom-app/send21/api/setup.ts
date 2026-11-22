import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import prisma from "@calcom/prisma";

import appConfig from "../config.json";
import { send21CredentialKeysSchema } from "../lib/credentialKeysSchema";

// Saves the setup form. The API key and signing secret are stored on the Cal.com
// credential and are never sent back to the browser.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ message: "Method Not Allowed" });
  const session = await getServerSession({ req });
  if (!session?.user?.id) return res.status(401).json({ message: "Sign in first" });

  const parsed = send21CredentialKeysSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid setup" });

  const credential = await prisma.credential.findFirst({ where: { userId: session.user.id, type: appConfig.type } });
  if (!credential) return res.status(404).json({ message: "Install the app first" });
  await prisma.credential.update({ where: { id: credential.id }, data: { key: parsed.data } });
  return res.status(200).json({ ok: true });
}
