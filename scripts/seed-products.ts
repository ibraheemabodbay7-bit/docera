import { getUncachableStripeClient } from "../server/stripeClient";

async function createProducts() {
  try {
    const stripe = await getUncachableStripeClient();

    console.log("Checking for existing Docera Pro product...");
    const existing = await stripe.products.search({
      query: "name:'Docera Pro' AND active:'true'",
    });

    if (existing.data.length > 0) {
      console.log("Docera Pro already exists:", existing.data[0].id);
      const prices = await stripe.prices.list({ product: existing.data[0].id, active: true });
      prices.data.forEach((p) => {
        const interval = (p.recurring?.interval ?? "one-time");
        const amount = ((p.unit_amount ?? 0) / 100).toFixed(2);
        console.log(`  Price: $${amount}/${interval} — ${p.id}`);
      });
      return;
    }

    console.log("Creating Docera Pro product...");
    const product = await stripe.products.create({
      name: "Docera Pro",
      description: "Unlimited document scanning, PDF export, and cloud storage.",
    });
    console.log("Created product:", product.id);

    const monthly = await stripe.prices.create({
      product: product.id,
      unit_amount: 999,
      currency: "usd",
      recurring: { interval: "month" },
    });
    console.log("Monthly price ($9.99/mo):", monthly.id);

    const yearly = await stripe.prices.create({
      product: product.id,
      unit_amount: 7999,
      currency: "usd",
      recurring: { interval: "year" },
    });
    console.log("Yearly price ($79.99/yr):", yearly.id);

    console.log("Done! Webhooks will sync data automatically.");
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error:", msg);
    process.exit(1);
  }
}

createProducts();
