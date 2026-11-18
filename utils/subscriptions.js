// Shared by Medora Pro (doctors, monthly) and Medora Plus (patients, yearly): both are Stripe subscriptions
// read from Stripe when the person comes back from the payment page and again around each renewal date.

// end of the period that is paid for (newer Stripe API versions keep it on the subscription's item)
export const periodEnd = subscription =>
  new Date((subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end) * 1000);

export const isRunning = subscription =>
  ["active", "trialing", "past_due"].includes(subscription.status) && periodEnd(subscription) > new Date();

// what is saved on the account
export const planFrom = (name, subscription, since) => ({
  name,
  since: since || new Date(subscription.start_date * 1000),
  expiresAt: periodEnd(subscription),
  autoRenew: !subscription.cancel_at_period_end,
  subscriptionId: subscription.id,
  // what this member pays per period (a later price change in the admin panel is for new members)
  ...(subscription.items?.data?.[0]?.price?.unit_amount && { price: subscription.items.data[0].price.unit_amount / 100 }),
});

// a renewing plan stays on for a short while past its date, until the renewal has been read from Stripe
const RENEWAL_GRACE_MS = 30 * 60 * 1000;
export const planActive = (plan, name) =>
  plan?.name === name && new Date(plan.expiresAt).getTime() + (plan.autoRenew ? RENEWAL_GRACE_MS : 0) > Date.now();

export const formatDay = date => new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export const isTestMode = () => Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));

export const TEST_CARD_TEXT = "Demo / test mode, no real money: use card 4242 4242 4242 4242, any future date (e.g. 12/34) and any CVC (e.g. 123).";
