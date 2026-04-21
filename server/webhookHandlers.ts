import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { storage } from "./storage";
import type Stripe from "stripe";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
        "Ensure webhook route is registered BEFORE app.use(express.json())."
      );
    }

    // 1. Let stripe-replit-sync verify signature and sync stripe.* tables
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // 2. Parse the already-verified event for our own business logic
    let event: Stripe.Event;
    try {
      event = JSON.parse(payload.toString()) as Stripe.Event;
    } catch (err: unknown) {
      console.error("[webhook] Failed to parse event:", err instanceof Error ? err.message : err);
      return;
    }

    try {
      await WebhookHandlers.handleAppEvent(event);
    } catch (err: unknown) {
      // Log but don't rethrow — sync already succeeded; don't fail the webhook response
      console.error("[webhook] App handler error:", err instanceof Error ? err.message : err);
    }
  }

  private static async handleAppEvent(event: Stripe.Event): Promise<void> {
    console.log(`[webhook] ${event.type}`);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // ── One-time payment: handwriting credit top-up ──────────────────────
        if (session.mode === "payment" && session.metadata?.purpose === "hw_credit_topup") {
          const userId = session.metadata?.userId;
          if (userId) {
            const { credits } = await storage.addHwCredits(userId, 10);
            console.log(`[webhook] hw credit top-up: +10 → user ${userId}, total=${credits}`);
          }
          break;
        }

        // ── Subscription checkout ────────────────────────────────────────────
        if (session.mode !== "subscription") break;

        const customerId = typeof session.customer === "string"
          ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription : session.subscription?.id;
        if (!customerId || !subscriptionId) break;

        const user = await storage.getUserByStripeCustomerId(customerId);
        if (user) {
          await storage.updateUserStripeInfo(user.id, { stripeSubscriptionId: subscriptionId });
          await storage.setSubscribed(user.id, false); // real Stripe sub now owns access
          console.log(`[webhook] checkout complete: linked sub ${subscriptionId} → user ${user.id}`);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const user = await storage.getUserByStripeSubscriptionId(sub.id);
        if (!user) break;
        // Ensure simulated flag is cleared — real Stripe status controls access
        if (user.isSubscribed) await storage.setSubscribed(user.id, false);
        console.log(`[webhook] subscription updated: ${sub.id} status=${sub.status} user=${user.id}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const user = await storage.getUserByStripeSubscriptionId(sub.id);
        if (!user) break;
        await storage.setSubscribed(user.id, false);
        console.log(`[webhook] subscription deleted: ${sub.id} user=${user.id}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = typeof invoice.customer === "string"
          ? invoice.customer : invoice.customer?.id;
        if (customerId) {
          const user = await storage.getUserByStripeCustomerId(customerId);
          if (user) console.log(`[webhook] payment failed for user ${user.id}`);
        }
        break;
      }

      default:
        break;
    }
  }
}
