import User from "../models/UserSchema.js";
import Booking from "../models/BookingSchema.js";
import { patientTier, patientTierOf, plusDetails } from "../utils/plus.js";
import { PATIENT_ORDER, PATIENT_TIERS } from "../utils/tiers.js";
import { isTestMode } from "../utils/subscriptions.js";
import { subscriptionHandlers } from "./subscriptionHandlers.js";
import logger from "../utils/logger.js";

// Patients' memberships: Plus Lite, Plus and Plus Family, billed yearly through Stripe (see utils/tiers.js).

const handlers = subscriptionHandlers({
  Model: User,
  field: "plus",
  role: "patient",
  kind: "plus",
  audience: "patient",
  ownerKey: "userId",
  tiers: PATIENT_TIERS,
  order: PATIENT_ORDER,
  interval: "year",
  tierOf: patientTierOf,
  link: "/plans",
  returnPath: "/plans",
  endPlan: userId => User.updateOne({ _id: userId }, { $unset: { plus: 1 } }),
  remindDaysBefore: 7,
});

export const startPlusCheckout = handlers.startCheckout;
export const verifyPlusCheckout = handlers.verifyCheckout;
export const changePlus = handlers.changePlan;
export const setPlusAutoRenew = handlers.setAutoRenew;
export const syncPlusPlans = handlers.syncPlans;
// demo reset
export const cancelPlusOf = handlers.cancelOf;

// what the membership has given back so far: extra refund money, reschedules past the free one, and
// Plus Family discounts on visits that weren't refunded in full
const savingsOf = async userId => {
  const bookings = await Booking.find({ user: userId, isPaid: true }).select("refundCovered rescheduleCount familyDiscount ticketPrice refundedAmount");
  const round = value => Math.round(value * 100) / 100;
  return {
    refunds: round(bookings.reduce((sum, booking) => sum + (booking.refundCovered || 0), 0)),
    extraReschedules: bookings.reduce((sum, booking) => sum + Math.max(0, (booking.rescheduleCount || 0) - PATIENT_TIERS.free.reschedules), 0),
    discounts: round(bookings.filter(booking => (booking.refundedAmount || 0) < booking.ticketPrice).reduce((sum, booking) => sum + (booking.familyDiscount || 0), 0)),
  };
};

// GET /plus  (patient) the membership, every plan on offer, and what it has saved
export const getPlus = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("plus");
    const tierId = patientTierOf(user);
    res.status(200).json({
      success: true,
      data: {
        tier: tierId,
        plus: tierId !== "free",
        membership: tierId === "free" ? null : {
          since: user.plus.since,
          expiresAt: user.plus.expiresAt,
          autoRenew: Boolean(user.plus.autoRenew),
          price: user.plus.price || patientTier(user).price,
          pendingTier: user.plus.pendingTier || null,
        },
        details: plusDetails(),
        savings: tierId === "free" ? null : await savingsOf(req.userId),
        testMode: isTestMode(),
      },
    });
  } catch (error) {
    logger.error("Plus error:", error.message);
    res.status(500).json({ success: false, message: "Could not load your membership" });
  }
};
