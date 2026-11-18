import Stripe from "stripe";
import Doctor from "../models/DoctorSchema.js";

// Stripe Connect payout accounts filled with Stripe's test data, so test bookings are split between doctor and
// platform without anyone going through Stripe's onboarding forms. Test keys only: never with real money.
export const isStripeTestMode = () => Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

// a verified test payout account for one doctor; returns true once Stripe has switched transfers on
export const createTestPayoutAccount = async doctor => {
  if (!isStripeTestMode()) throw new Error("Test payout accounts need Stripe test keys");
  const stripe = getStripe();
  const [firstName, ...rest] = doctor.name.replace(/^dr\.?\s*/i, "").split(" ");
  const account = await stripe.accounts.create({
    type: "custom",
    country: "US",
    email: doctor.email,
    business_type: "individual",
    capabilities: { transfers: { requested: true } },
    business_profile: { mcc: "8011", product_description: "Doctor consultations on Medora", url: "https://medora-health-care.vercel.app" },
    // Stripe's test values that pass verification straight away
    individual: {
      first_name: firstName,
      last_name: rest.join(" ") || "Doctor",
      email: doctor.email,
      phone: "0000000000",
      dob: { day: 1, month: 1, year: 1901 },
      ssn_last_4: "0000",
      address: { line1: "address_full_match", city: "Schenectady", state: "NY", postal_code: "12345", country: "US" },
    },
    external_account: "btok_us_verified",
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "8.8.8.8" },
    metadata: { doctorId: String(doctor._id), demo: "true" },
  });
  const enabled = account.capabilities?.transfers === "active"
    || (await stripe.accounts.retrieve(account.id)).capabilities?.transfers === "active";
  await Doctor.updateOne({ _id: doctor._id }, { $set: { stripeAccountId: account.id, payoutsEnabled: enabled } });
  return enabled;
};

// remove a test payout account again (demo reset of the sample applicants)
export const deleteTestPayoutAccount = async accountId => {
  if (!isStripeTestMode() || !accountId) return;
  await getStripe().accounts.del(accountId).catch(() => {});
};

// The listed demo doctors get test payout accounts, created once and kept across demo resets
// (the reset never touches these fields).
export const connectDemoDoctors = async () => {
  if (!isStripeTestMode()) return { connected: 0, skipped: "not a test key" };
  const stripe = getStripe();
  const doctors = await Doctor.find({ isDemo: true, isApproved: "approved", payoutsEnabled: { $ne: true } }).select("+stripeAccountId name email");

  let connected = 0;
  for (const doctor of doctors) {
    if (!doctor.stripeAccountId) {
      if (await createTestPayoutAccount(doctor)) connected++;
      continue;
    }
    const account = await stripe.accounts.retrieve(doctor.stripeAccountId);
    if (account.capabilities?.transfers === "active") {
      await Doctor.updateOne({ _id: doctor._id }, { $set: { payoutsEnabled: true } });
      connected++;
    }
  }
  return { connected, pending: doctors.length - connected };
};
