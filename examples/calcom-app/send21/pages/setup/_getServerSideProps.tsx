import type { GetServerSidePropsContext } from "next";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import prisma from "@calcom/prisma";

import appConfig from "../../config.json";
import { send21CredentialKeysSchema } from "../../lib/credentialKeysSchema";

// Only non-secret fields go to the browser: whether a key is saved, the receiving options
// and the decline note. The API key and signing secret stay on the server.
export const getServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const session = await getServerSession({ req: ctx.req });
  if (!session?.user?.id) return { redirect: { permanent: false, destination: "/auth/login" } };
  const credential = await prisma.credential.findFirst({ where: { userId: session.user.id, type: appConfig.type } });
  const parsed = send21CredentialKeysSchema.safeParse(credential?.key);
  return {
    props: parsed.success
      ? { configured: true, options: parsed.data.options, declineNote: parsed.data.declineNote ?? "", expiryHours: parsed.data.expiryHours ?? 24 }
      : { configured: false, options: [], declineNote: "", expiryHours: 24 },
  };
};
