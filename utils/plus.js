import { CANCEL_CUTOFF_MINUTES } from "./slots.js";
import { PATIENT_ORDER, PATIENT_TIERS, tiersForJson } from "./tiers.js";
import { planActive } from "./subscriptions.js";

// The patient's membership: Free, Plus Lite, Plus or Plus Family (see utils/tiers.js). Better refunds are paid
// by the platform, never the doctor. A membership that has run out counts as Free.

export const PAID_PATIENT_TIERS = PATIENT_ORDER.filter(id => id !== "free");
// kept for older callers: the Plus tier itself
export const PLUS = PATIENT_TIERS.plus;

// "free" | "lite" | "plus" | "family"
export const patientTierOf = user => {
  const name = user?.plus?.name;
  return name && PATIENT_TIERS[name] && planActive(user.plus, name) ? name : "free";
};
export const patientTier = user => PATIENT_TIERS[patientTierOf(user)];

// on any paid membership
export const isPlus = user => patientTierOf(user) !== "free";

export const followUpDaysFor = user => patientTier(user).followUpDays;
export const aiChecksFor = user => patientTier(user).aiChecksPerDay;
export const maxReschedulesFor = user => patientTier(user).reschedules;

// what the membership page shows
export const plusDetails = () => ({
  tiers: tiersForJson(PATIENT_TIERS, PATIENT_ORDER),
  cutoffHours: CANCEL_CUTOFF_MINUTES / 60,
});
