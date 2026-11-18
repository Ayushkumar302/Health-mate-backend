import { DOCTOR_ORDER, DOCTOR_TIERS, FEATURED, tiersForJson } from "./tiers.js";
import { planActive } from "./subscriptions.js";

// The doctor's plan: Free, Pro Starter, Pro or Pro Clinic (see utils/tiers.js for what each gives).
// A plan that has run out counts as Free (a renewing plan stays on for a short grace while the renewal is read).

export const PAID_DOCTOR_TIERS = DOCTOR_ORDER.filter(id => id !== "free");

// "free" | "starter" | "pro" | "clinic"
export const doctorTierOf = doctor => {
  const name = doctor?.plan?.name;
  return name && DOCTOR_TIERS[name] && planActive(doctor.plan, name) ? name : "free";
};
export const doctorTier = doctor => DOCTOR_TIERS[doctorTierOf(doctor)];

// on any paid plan
export const isPro = doctor => doctorTierOf(doctor) !== "free";

export const commissionRateFor = doctor => doctorTier(doctor).commissionRate;
export const bookingWindowFor = doctor => doctorTier(doctor).bookingWindowDays;
export const timeOffLimitFor = doctor => doctorTier(doctor).timeOffEntries;
// new bookings are confirmed straight away, without the doctor accepting each one
export const confirmsInstantly = doctor => doctorTier(doctor).instantBooking && Boolean(doctor.instantBooking);
// the badge patients see: none for Free and Starter
export const planBadgeOf = doctor => ({ pro: "Pro", clinic: "Pro Clinic" })[doctorTierOf(doctor)] || null;

// what the plan page shows
export const planDetails = () => ({
  tiers: tiersForJson(DOCTOR_TIERS, DOCTOR_ORDER),
  featuredPerSpecialty: FEATURED.perSpecialty,
  maxCancellationRate: FEATURED.maxCancellationRate,
});
