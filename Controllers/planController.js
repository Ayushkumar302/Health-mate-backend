import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import { doctorTier, doctorTierOf, planDetails } from "../utils/plans.js";
import { DOCTOR_ORDER, DOCTOR_TIERS, FEATURED } from "../utils/tiers.js";
import { cancellationRateOf, clearFeaturedCache, proVisibility } from "../utils/featured.js";
import { moneyOf } from "../utils/earnings.js";
import { isTestMode } from "../utils/subscriptions.js";
import { isAllowedPhoto } from "../utils/validate.js";
import { cleanText } from "../utils/text.js";
import { subscriptionHandlers } from "./subscriptionHandlers.js";
import logger from "../utils/logger.js";

// Doctors' paid plans: Pro Starter, Pro and Pro Clinic, billed monthly through Stripe (see utils/tiers.js).

const PLAN_LINK = "/plans";
const MAX_CLINIC_PHOTOS = 4;

const handlers = subscriptionHandlers({
  Model: Doctor,
  field: "plan",
  role: "doctor",
  kind: "pro",
  audience: "doctor",
  ownerKey: "doctorId",
  tiers: DOCTOR_TIERS,
  order: DOCTOR_ORDER,
  interval: "month",
  tierOf: doctorTierOf,
  link: PLAN_LINK,
  returnPath: "/plans",
  // back to free: no plan, no instant booking (the clinic details stay saved for a later upgrade)
  endPlan: doctorId => Doctor.updateOne({ _id: doctorId }, { $unset: { plan: 1 }, $set: { instantBooking: false } }),
  afterChange: clearFeaturedCache,
  remindDaysBefore: 3,
});

export const startProCheckout = handlers.startCheckout;
export const verifyProCheckout = handlers.verifyCheckout;
export const changePlan = handlers.changePlan;
export const setAutoRenew = handlers.setAutoRenew;
export const syncProPlans = handlers.syncPlans;
// demo reset
export const cancelProOf = handlers.cancelOf;

const monthKey = date => new Date(date).toISOString().slice(0, 7);

// basic (Starter): profile views and bookings; full (Pro, Clinic): also conversion and earnings per month
const analyticsFor = async (doctor, level) => {
  if (level === "none") return null;
  const bookings = await Booking.find({ doctor: doctor._id, isPaid: true }).select("ticketPrice listPrice familyDiscount isPaid refundId refundedAmount refundCovered commissionRate createdAt");
  const views = doctor.profileViews || 0;
  const basic = { level, profileViews: views, bookings: bookings.length };
  if (level === "basic") return basic;

  const months = [];
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 5);
  for (let i = 0; i < 6; i++) {
    const date = new Date(start);
    date.setUTCMonth(start.getUTCMonth() + i);
    months.push({ month: monthKey(date), earned: 0, bookings: 0 });
  }
  for (const booking of bookings) {
    const month = months.find(item => item.month === monthKey(booking.createdAt));
    if (!month) continue;
    month.earned += moneyOf(booking).doctor;
    month.bookings += 1;
  }
  return {
    ...basic,
    // share of profile visits that ended in a paid booking
    conversion: views ? Math.min(1, bookings.length / views) : 0,
    months: months.map(item => ({ ...item, earned: Math.round(item.earned * 100) / 100 })),
  };
};

// GET /doctors/plan  (doctor) the current plan, every plan on offer, and the plan's numbers
export const getPlan = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId).select("plan instantBooking profileViews isApproved isDemo clinic");
    const tierId = doctorTierOf(doctor);
    const tier = doctorTier(doctor);
    const featuredTier = tier.featured !== "none";
    const [rate, visibility] = await Promise.all([cancellationRateOf(doctor._id), featuredTier ? proVisibility() : null]);
    const isFeatured = featuredTier && visibility.featured.has(String(doctor._id));
    res.status(200).json({
      success: true,
      data: {
        tier: tierId,
        plan: tierId === "free" ? null : {
          since: doctor.plan.since,
          expiresAt: doctor.plan.expiresAt,
          autoRenew: Boolean(doctor.plan.autoRenew),
          price: doctor.plan.price || tier.price,
          // a cheaper plan that starts at the next renewal
          pendingTier: doctor.plan.pendingTier || null,
        },
        instantBooking: tier.instantBooking && Boolean(doctor.instantBooking),
        details: planDetails(),
        cancellation: rate,
        featured: isFeatured,
        // why a Pro or Clinic doctor is not featured right now
        featuredNote: !featuredTier ? null
          : doctor.isApproved !== "approved" ? "You'll be featured once your profile is verified."
          : rate.rate > FEATURED.maxCancellationRate ? `Featured placement is paused while you cancel more than ${Math.round(FEATURED.maxCancellationRate * 100)}% of confirmed appointments.`
          : isFeatured ? null
          : `Your specialty has more than ${FEATURED.perSpecialty} doctors on Pro plans, so the featured places take turns day by day (Pro Clinic doctors go first).`,
        analytics: await analyticsFor(doctor, tier.analytics),
        clinic: doctor.clinic?.name ? doctor.clinic : null,
        testMode: isTestMode(),
      },
    });
  } catch (error) {
    logger.error("Plan error:", error.message);
    res.status(500).json({ success: false, message: "Could not load your plan" });
  }
};

// PUT /doctors/plan/instant-booking  body: { on }  (paid plans) confirm new bookings without accepting each one
export const setInstantBooking = async (req, res) => {
  if (typeof req.body?.on !== "boolean") {
    return res.status(400).json({ success: false, message: "Choose on or off" });
  }
  try {
    const doctor = await Doctor.findById(req.userId).select("plan");
    if (!doctorTier(doctor).instantBooking) {
      return res.status(403).json({ success: false, message: "Instant booking comes with every Pro plan, from Pro Starter up" });
    }
    await Doctor.updateOne({ _id: req.userId }, { $set: { instantBooking: req.body.on } });
    res.status(200).json({
      success: true,
      message: req.body.on ? "Instant booking is on: new bookings are confirmed as soon as they're paid" : "Instant booking is off: you accept each request yourself",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update instant booking" });
  }
};

// PUT /doctors/plan/clinic  body: { name, logo, photos }  (Pro Clinic) the clinic shown on the public profile
export const updateClinicBranding = async (req, res) => {
  const name = cleanText(req.body?.name).replace(/\s+/g, " ").slice(0, 80);
  const logo = req.body?.logo || "";
  const photos = Array.isArray(req.body?.photos) ? req.body.photos.filter(Boolean) : [];
  if (!name) return res.status(400).json({ success: false, message: "Add your clinic's name" });
  if (photos.length > MAX_CLINIC_PHOTOS) return res.status(400).json({ success: false, message: `Add up to ${MAX_CLINIC_PHOTOS} photos` });
  // images only from Medora's own upload storage, like profile photos
  if (![logo, ...photos].every(url => typeof url === "string" && isAllowedPhoto(url))) {
    return res.status(400).json({ success: false, message: "Images must be uploaded through the site" });
  }
  try {
    const doctor = await Doctor.findById(req.userId).select("plan");
    if (!doctorTier(doctor).clinicBranding) {
      return res.status(403).json({ success: false, message: "Clinic branding is part of Pro Clinic" });
    }
    const clinic = { name, ...(logo && { logo }), photos };
    await Doctor.updateOne({ _id: req.userId }, { $set: { clinic } });
    res.status(200).json({ success: true, message: "Clinic details saved", data: clinic });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not save the clinic details" });
  }
};
