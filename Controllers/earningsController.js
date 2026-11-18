import Stripe from "stripe";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import { moneyOf } from "../utils/earnings.js";
import { appointmentEpoch, clinicToday } from "../utils/slots.js";
import { siteUrl } from "../utils/site.js";
import logger from "../utils/logger.js";
import { createTestPayoutAccount, isStripeTestMode } from "../demo/demoPayouts.js";
import { statementPdf } from "../utils/receipts.js";

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);
const round = value => Math.round(value * 100) / 100;

// where a booking's money stands from the doctor's side
const stateOf = (booking, money) => {
  if (booking.status === "cancelled") return money.kept > 0 ? "cancellation-fee" : "refunded";
  if (booking.noShow === "patient") return "missed";
  if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) > Date.now()) return "upcoming";
  return "completed";
};

// GET /doctors/earnings  (doctor) every paid booking with its split, and the totals
export const getEarnings = async (req, res) => {
  try {
    const [doctor, bookings] = await Promise.all([
      Doctor.findById(req.userId).select("+stripeAccountId payoutsEnabled isDemo"),
      Booking.find({ doctor: req.userId, isPaid: true })
        .sort({ appointmentDate: -1, appointmentTime: -1 })
        .limit(300)
        .populate("user", "name photo"),
    ]);
    const month = clinicToday().slice(0, 7);
    const totals = { earned: 0, upcoming: 0, commission: 0, refunded: 0, thisMonth: 0, held: 0 };
    const items = bookings.map(booking => {
      const money = moneyOf(booking);
      const state = stateOf(booking, money);
      if (state === "upcoming") {
        totals.upcoming += money.doctor;
      } else {
        totals.earned += money.doctor;
        totals.commission += money.platform;
        if (booking.appointmentDate?.startsWith(month)) totals.thisMonth += money.doctor;
        // paid before the doctor had a payout account: the platform still holds their share
        if (!booking.payoutAccount) totals.held += money.doctor;
      }
      totals.refunded += money.refunded;
      return {
        _id: booking._id,
        patient: booking.user ? { name: booking.user.name, photo: booking.user.photo } : null,
        appointmentDate: booking.appointmentDate,
        appointmentTime: booking.appointmentTime,
        consultationType: booking.consultationType,
        state,
        cancelledBy: booking.cancelledBy,
        viaStripeConnect: Boolean(booking.payoutAccount),
        ...money,
      };
    });
    res.status(200).json({
      success: true,
      data: {
        totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])),
        payouts: { connected: Boolean(doctor?.stripeAccountId), enabled: Boolean(doctor?.payoutsEnabled), demo: Boolean(doctor?.isDemo), testMode: isStripeTestMode() },
        items,
      },
    });
  } catch (error) {
    logger.error("Earnings error:", error.message);
    res.status(500).json({ success: false, message: "Could not load your earnings" });
  }
};

// GET /doctors/earnings/statement?month=YYYY-MM  (doctor) the month's payout statement as a PDF
// (bookings by appointment date; ones still to come that month are included)
export const getStatement = async (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "") ? req.query.month : clinicToday().slice(0, 7);
  try {
    const [doctor, bookings] = await Promise.all([
      Doctor.findById(req.userId).select("name payoutsEnabled"),
      Booking.find({ doctor: req.userId, isPaid: true, appointmentDate: { $regex: `^${month}-` } })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .limit(500)
        .populate("user", "name"),
    ]);
    const { buffer } = statementPdf({ doctor, month, bookings });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="medora-statement-${month}.pdf"`,
      "Cache-Control": "private, no-store",
    });
    res.send(buffer);
  } catch (error) {
    logger.error("Statement error:", error.message);
    res.status(500).json({ success: false, message: "Could not make the statement" });
  }
};

// POST /doctors/payouts/connect  (doctor) Stripe's own onboarding page, where the doctor adds their bank account;
// their bank details never pass through Medora
export const connectPayouts = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId).select("+stripeAccountId email");
    const stripe = getStripe();
    let accountId = doctor.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        // connected accounts are created in the platform's country (the test platform is US based)
        country: "US",
        email: doctor.email,
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        metadata: { doctorId: String(doctor._id) },
      });
      accountId = account.id;
      await Doctor.updateOne({ _id: doctor._id }, { $set: { stripeAccountId: accountId, payoutsEnabled: false } });
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: siteUrl("/doctors/profile/me?payouts=retry"),
      return_url: siteUrl("/doctors/profile/me?payouts=done"),
    });
    res.status(200).json({ success: true, data: { url: link.url } });
  } catch (error) {
    logger.error("Payout connect error:", error.message);
    res.status(500).json({ success: false, message: "Could not open the payout setup, please try again" });
  }
};

// POST /doctors/payouts/test-account  (doctor, Stripe test mode only) skip Stripe's forms: a payout account
// filled with Stripe's test data, ready at once. No real bank account is involved.
export const connectTestPayouts = async (req, res) => {
  if (!isStripeTestMode()) {
    return res.status(403).json({ success: false, message: "Test payout accounts are only available in test mode" });
  }
  try {
    const doctor = await Doctor.findById(req.userId).select("+stripeAccountId name email payoutsEnabled");
    if (doctor.payoutsEnabled) {
      return res.status(400).json({ success: false, message: "Your payout account is already connected" });
    }
    const enabled = await createTestPayoutAccount(doctor);
    res.status(200).json({
      success: true,
      message: enabled ? "Test payout account connected" : "Test payout account created, Stripe is still checking it. Try again in a minute",
      data: { connected: true, enabled },
    });
  } catch (error) {
    logger.error("Test payout error:", error.message);
    res.status(500).json({ success: false, message: "Could not create the test payout account" });
  }
};

// GET /doctors/payouts/status  (doctor) re-check with Stripe after the onboarding page
export const getPayoutStatus = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.userId).select("+stripeAccountId");
    if (!doctor.stripeAccountId) {
      return res.status(200).json({ success: true, data: { connected: false, enabled: false } });
    }
    const account = await getStripe().accounts.retrieve(doctor.stripeAccountId);
    const enabled = account.capabilities?.transfers === "active" && Boolean(account.payouts_enabled);
    if (enabled !== doctor.payoutsEnabled) await Doctor.updateOne({ _id: doctor._id }, { $set: { payoutsEnabled: enabled } });
    res.status(200).json({ success: true, data: { connected: true, enabled } });
  } catch (error) {
    logger.error("Payout status error:", error.message);
    res.status(500).json({ success: false, message: "Could not check the payout account" });
  }
};
