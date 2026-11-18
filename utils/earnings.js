import { CANCEL_CUTOFF_MINUTES, minutesUntil } from "./slots.js";
import { DOCTOR_TIERS, PATIENT_TIERS } from "./tiers.js";

// Medora's business model: the platform keeps a commission on every consultation and the doctor gets the rest,
// split by Stripe Connect at payment time. The rate is saved on each booking, so a later change never
// touches bookings that were already paid. The standard rate is the Free plan's (utils/tiers.js); the admin
// can change it, and this object always holds the current one.
export const STANDARD = DOCTOR_TIERS.free;

// how much a patient on a free account gets back when they cancel a confirmed appointment themselves
export const PATIENT_REFUND = PATIENT_TIERS.free.refund; // 2h+ before / less than 2h before
export const MAX_RESCHEDULES = PATIENT_TIERS.free.reschedules;

const toPaise = rupees => Math.round(Number(rupees || 0) * 100);

// share of the price that goes back when this booking is cancelled now. Doctor or system: everything.
// Patient: everything while the doctor has never accepted it, then their plan's rate: 90% / 50% on a free
// account, more on a paid membership (the platform pays the difference, never the doctor).
export const refundShareFor = (booking, by, { tier = "free" } = {}) => {
  if (by !== "patient") return 1;
  if (booking.status === "pending" && !booking.respondedAt) return 1;
  const refund = (PATIENT_TIERS[tier] || PATIENT_TIERS.free).refund;
  return minutesUntil(booking.appointmentDate, booking.appointmentTime) >= CANCEL_CUTOFF_MINUTES ? refund.early : refund.late;
};

export const refundPaise = (booking, share) => Math.round(toPaise(booking.ticketPrice) * share);

// the platform's commission on a payment, in paise (Stripe's application_fee_amount)
export const commissionPaise = (rupees, rate = STANDARD.commissionRate) => Math.round(toPaise(rupees) * rate);

// the doctor's share of a payment, in paise (what Stripe transfers to their payout account). With a Plus Family
// discount the patient pays less but the doctor is still paid on their full fee: the discount comes out of
// Medora's commission.
export const doctorSharePaise = (listRupees, rate) => toPaise(listRupees) - commissionPaise(listRupees, rate);

// the money of one booking in rupees: paid, refunded, kept, and how the kept part is split
export const moneyOf = booking => {
  const paid = booking.isPaid ? toPaise(booking.ticketPrice) : 0;
  // refunds from before partial refunds existed only stored the refund id: those were full refunds
  const refunded = booking.refundedAmount != null ? toPaise(booking.refundedAmount) : booking.refundId ? paid : 0;
  const kept = Math.max(0, paid - refunded);
  const rate = booking.commissionRate ?? STANDARD.commissionRate;
  // a Plus member's extra refund came out of the platform's share: the doctor is paid as if it never happened
  const covered = Math.min(refunded, toPaise(booking.refundCovered));
  const split = kept + covered;
  // the doctor's part is worked out on the full fee (before a family discount), for the share of it that was kept
  const list = booking.listPrice ? toPaise(booking.listPrice) : paid;
  const base = paid > 0 ? Math.round((split * list) / paid) : 0;
  const commission = Math.round(base * rate);
  const doctor = base - commission;
  const platform = kept - doctor;
  const discount = booking.familyDiscount ? toPaise(booking.familyDiscount) : 0;
  return { paid: paid / 100, refunded: refunded / 100, kept: kept / 100, platform: platform / 100, doctor: doctor / 100, covered: covered / 100, discount: discount / 100, rate };
};

// ₹199 or ₹179.10 (never ₹179.1)
export const formatRupees = rupees => {
  const amount = Number(rupees);
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
