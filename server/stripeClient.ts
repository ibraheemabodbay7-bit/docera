import { StripeSync, runMigrations } from "stripe-replit-sync";

let stripeSyncInstance: StripeSync | null = null;

async function getStripeCredentials(): Promise<{ secret: string; accountId?: string }> {
  const envSecret = process.env.STRIPE_SECRET_KEY;
  if (envSecret) return { secret: envSecret };

  const connectorsHost = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (connectorsHost) {
    try {
      const connectionId = "conn_stripe_01KJ2JBWAKZ4AYZGSBNPS877DN";
      const url = `http://${connectorsHost}/v1/connections/${connectionId}/credentials`;
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as {
          secret?: string;
          account_id?: string;
          [key: string]: unknown;
        };
        const secret = data.secret ?? (data as Record<string, unknown>)["STRIPE_SECRET_KEY"] as string | undefined;
        if (secret) return { secret, accountId: data.account_id };
      }
    } catch {
    }
  }

  throw new Error("Stripe credentials unavailable — set STRIPE_SECRET_KEY or connect via Replit Stripe integration");
}

export async function getStripeSync(): Promise<StripeSync> {
  if (stripeSyncInstance) return stripeSyncInstance;

  const { secret, accountId } = await getStripeCredentials();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");

  stripeSyncInstance = new StripeSync({
    stripeSecretKey: secret,
    stripeAccountId: accountId,
    databaseUrl,
  });

  return stripeSyncInstance;
}

export async function getUncachableStripeClient() {
  const sync = await getStripeSync();
  return sync.stripe;
}

export { runMigrations };
