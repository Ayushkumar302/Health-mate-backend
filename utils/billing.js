import Stripe from "stripe";
import Setting from "../models/SettingSchema.js";
import { TEST_CARD_TEXT, isTestMode, periodEnd } from "./subscriptions.js";
import { siteUrl } from "./site.js";

// Stripe subscriptions for every plan (doctors monthly, patients yearly). Each plan has its own Stripe product,
// created once and remembered, so invoices and the Stripe dashboard name the plan the person is on.

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

let products = null;
const productFor = async (audience, tier) => {
  const key = `${audience}:${tier.id}`;
  if (!products) products = (await Setting.findOne({ key: "stripe-products" }))?.value || {};
  if (products[key]) return products[key];
  const product = await getStripe().products.create({
    name: `Medora ${tier.label}`,
    metadata: { medoraPlan: key },
  });
  products[key] = product.id;
  await Setting.updateOne({ key: "stripe-products" }, { $set: { [`value.${key}`]: product.id } }, { upsert: true });
  return product.id;
};

const priceData = async (audience, tier, interval) => ({
  currency: "inr",
  product: await productFor(audience, tier),
  unit_amount: tier.price * 100,
  recurring: { interval },
});

// Stripe's payment page for a new subscription; `owner` is { key: "doctorId" | "userId", id }
export const startSubscriptionCheckout = async ({ audience, tier, interval, owner, email, kind, returnPath }) => {
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer_email: email,
    client_reference_id: owner.id,
    metadata: { [owner.key]: owner.id, kind, tier: tier.id },
    subscription_data: { metadata: { [owner.key]: owner.id, kind, tier: tier.id } },
    success_url: siteUrl(`${returnPath}?${kind}=done&session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: siteUrl(`${returnPath}?${kind}=cancelled`),
    ...(isTestMode() && { custom_text: { submit: { message: TEST_CARD_TEXT } } }),
    line_items: [{ quantity: 1, price_data: await priceData(audience, tier, interval) }],
  });
  return session.url;
};

// the subscription behind a finished payment page, if it belongs to this person and this kind of plan
export const subscriptionFromCheckout = async ({ sessionId, owner, kind }) => {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  if (session.metadata?.[owner.key] !== owner.id || session.metadata?.kind !== kind || session.mode !== "subscription") {
    return { error: { status: 404, message: "Payment not found" } };
  }
  if (session.payment_status !== "paid" || !session.subscription) {
    return { error: { status: 400, message: "Payment not completed" } };
  }
  return { subscription: session.subscription, tier: session.metadata.tier };
};

// Move a subscription to another plan.
// Upgrade: switched now, and Stripe charges the difference for the rest of the period straight away.
// Downgrade: the next renewal is charged at the lower price, nothing is refunded; the person keeps the higher
// plan until then (the caller saves the change as pending).
export const changeSubscriptionPlan = async ({ subscriptionId, audience, tier, interval, upgrade }) => {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: subscription.items.data[0].id, price_data: await priceData(audience, tier, interval) }],
    proration_behavior: upgrade ? "always_invoice" : "none",
    // an upgrade whose payment fails is not applied
    ...(upgrade && { payment_behavior: "error_if_incomplete" }),
    metadata: { ...subscription.metadata, tier: tier.id },
    expand: ["latest_invoice"],
  });
  // what the upgrade cost now (the invoice Stripe just made for the difference)
  const charged = upgrade && updated.latest_invoice?.amount_paid ? updated.latest_invoice.amount_paid / 100 : 0;
  return { subscription: updated, expiresAt: periodEnd(updated), charged };
};

export const setSubscriptionRenewal = (subscriptionId, on) =>
  getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: !on });

export const retrieveSubscription = subscriptionId => getStripe().subscriptions.retrieve(subscriptionId);

export const cancelSubscription = subscriptionId => getStripe().subscriptions.cancel(subscriptionId).catch(() => {});
