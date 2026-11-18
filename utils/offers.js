import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import Notification from "../models/NotificationSchema.js";
import { addNotification } from "./notifications.js";
import { DOCTOR_ORDER, DOCTOR_TIERS, PATIENT_ORDER, PATIENT_TIERS } from "./tiers.js";
import { patientTierOf } from "./plus.js";
import { doctorTierOf } from "./plans.js";
import { formatRupees, moneyOf } from "./earnings.js";
import logger from "./logger.js";

// Upgrade suggestions in the notification centre (the bell only: no email, no pop-ups).
//  - at most one every 15 days, the first one a few days after the account was created
//  - written from the person's own numbers ("you paid ₹X in commission, on Pro Starter it would be ₹Y")
//  - after 3 in a row that were never opened they stop, until the person opens one of them
//  - "Offers and tips" in the settings turns them off for good
// Nobody on the top plan gets one.

export const OFFER_EVERY_DAYS = 15;
export const MAX_IGNORED = 3;
const FIRST_AFTER_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;
const BATCH = 100;

const pct = rate => `${Math.round(rate * 100)}%`;
const round = value => Math.round(value * 100) / 100;

const nextTier = (order, current) => order[order.indexOf(current) + 1] || null;

// ---- what each person is told

const patientStats = async userId => {
  const since = new Date(Date.now() - 180 * DAY);
  const bookings = await Booking.find({ user: userId, isPaid: true, createdAt: { $gte: since } })
    .select("ticketPrice listPrice refundedAmount refundId cancelledBy status rescheduleCount");
  const visits = bookings.filter(booking => booking.status !== "cancelled");
  const fees = bookings
    .filter(booking => booking.status === "cancelled" && booking.cancelledBy === "patient")
    .reduce((sum, booking) => sum + Math.max(0, booking.ticketPrice - (booking.refundedAmount ?? (booking.refundId ? booking.ticketPrice : 0))), 0);
  return {
    visits: visits.length,
    spent: visits.reduce((sum, booking) => sum + (booking.listPrice || booking.ticketPrice || 0), 0),
    fees: round(fees),
    movedToLimit: bookings.some(booking => (booking.rescheduleCount || 0) >= PATIENT_TIERS.free.reschedules),
  };
};

export const patientOffer = (tierId, stats) => {
  const target = nextTier(PATIENT_ORDER, tierId);
  if (!target || !PATIENT_TIERS[target].available) return null;
  const tier = PATIENT_TIERS[target];
  const price = `${formatRupees(tier.price)} a year`;
  const link = "/plans";
  if (tierId === "free") {
    if (stats.fees > 0) {
      return { title: `You paid ${formatRupees(stats.fees)} in cancellation fees`, text: `With ${tier.label} you get ${pct(tier.refund.early)} back when you cancel 2+ hours before, and ${tier.reschedules} free moves per appointment. ${price}.`, link, target };
    }
    if (stats.movedToLimit) {
      return { title: "Plans change. Move appointments more often", text: `${tier.label} lets you move each appointment ${tier.reschedules} times and gives ${pct(tier.refund.early)} refunds, for ${price}.`, link, target };
    }
    if (stats.visits >= 2) {
      return { title: `${stats.visits} visits in the last 6 months`, text: `${tier.label} gives you better refunds, more reschedules and ${tier.followUpDays} days of follow-up chat after every visit, for ${price}.`, link, target };
    }
    return { title: "Better refunds and follow-up chat", text: `${tier.label}: ${pct(tier.refund.early)} back when you cancel early, ${tier.followUpDays}-day follow-up chat with your doctor and more AI checks, for ${price}.`, link, target };
  }
  if (target === "plus") {
    return { title: "Move appointments as often as you need", text: `Plus has no reschedule limit, ${pct(tier.refund.early)} refunds up to 2 hours before and ${tier.followUpDays} days of follow-up chat. You only pay the difference for the rest of this year.`, link, target };
  }
  // Plus -> Plus Family
  const saved = round(stats.spent * tier.consultDiscount);
  return {
    title: "Book for your family too",
    text: `Plus Family adds ${tier.familyMembers} family members, each with their own record, and takes ${pct(tier.consultDiscount)} off every visit${saved > 0 ? ` (${formatRupees(saved)} on your visits in the last 6 months)` : ""}. You only pay the difference.`,
    link,
    target,
  };
};

const doctorStats = async doctorId => {
  const since = new Date(Date.now() - 30 * DAY);
  const bookings = await Booking.find({ doctor: doctorId, isPaid: true, createdAt: { $gte: since } })
    .select("ticketPrice listPrice familyDiscount isPaid refundId refundedAmount refundCovered commissionRate status");
  let gross = 0;
  let commission = 0;
  for (const booking of bookings) {
    const money = moneyOf(booking);
    if (money.kept + money.covered <= 0) continue;
    // the fee the doctor's share was worked out on, and the commission they paid on it
    const base = money.doctor / ((1 - money.rate) || 1);
    gross += base;
    commission += base - money.doctor;
  }
  return { bookings: bookings.length, gross: round(gross), commission: round(commission) };
};

export const doctorOffer = (tierId, stats, specialty = "") => {
  const target = nextTier(DOCTOR_ORDER, tierId);
  if (!target) return null;
  const tier = DOCTOR_TIERS[target];
  const price = `${formatRupees(tier.price)} a month`;
  const link = "/plans";
  const theirs = round(stats.gross * tier.commissionRate);
  const saving = round(stats.commission - theirs);
  const numbers = stats.gross > 0 && saving > 0
    ? `You paid ${formatRupees(stats.commission)} in commission in the last 30 days; on ${tier.label} it would have been ${formatRupees(theirs)}${saving >= tier.price ? ", more than the plan pays for itself" : ""}. `
    : "";
  if (target === "starter") {
    return {
      title: stats.gross > 0 ? `Keep ${formatRupees(saving)} more a month with Pro Starter` : "Fill your calendar further ahead",
      text: `${numbers}Pro Starter: ${pct(tier.commissionRate)} commission, patients book up to ${tier.bookingWindowDays} days ahead and you can confirm bookings instantly. ${price}.`,
      link,
      target,
    };
  }
  if (target === "pro") {
    return {
      title: `Get featured in ${specialty ? `${specialty} ` : ""}search`,
      text: `${numbers}Pro shares the featured places of your specialty, takes ${pct(tier.commissionRate)} commission and opens your calendar ${tier.bookingWindowDays} days ahead. You only pay the difference.`,
      link,
      target,
    };
  }
  return {
    title: "Put your clinic first",
    text: `${numbers}Pro Clinic gets the featured places before Pro doctors, shows your clinic's name, logo and photos, and takes ${pct(tier.commissionRate)} commission.`,
    link,
    target,
  };
};

// ---- sending

// people who are due: not opted out, not paused, last suggestion 15+ days ago (or a few days after joining)
const dueFilter = now => ({
  "offers.optOut": { $ne: true },
  $and: [
    { $or: [{ "offers.ignored": { $exists: false } }, { "offers.ignored": { $lt: MAX_IGNORED } }] },
    {
      $or: [
        { "offers.lastSentAt": { $lte: new Date(now - OFFER_EVERY_DAYS * DAY) } },
        // (accounts from before timestamps were saved count as old)
        { "offers.lastSentAt": { $exists: false }, createdAt: { $lte: new Date(now - FIRST_AFTER_DAYS * DAY) } },
        { "offers.lastSentAt": { $exists: false }, createdAt: { $exists: false } },
      ],
    },
  ],
});

const sendOne = async ({ Model, role, person, offer, now }) => {
  const claim = set => Model.updateOne({ _id: person._id, "offers.lastSentAt": person.offers?.lastSentAt ?? { $exists: false } }, { $set: set });
  // already on the top plan: nothing to suggest, checked again in 15 days
  if (!offer) {
    await claim({ "offers.lastSentAt": new Date(now) });
    return false;
  }
  // was the last suggestion opened? Three unopened in a row pause them
  const last = await Notification.findOne({ role, person: person._id, kind: "offer" }).sort({ createdAt: -1 }).select("readAt");
  const ignored = last && !last.readAt ? (person.offers?.ignored || 0) + 1 : 0;
  // claim the slot first, so two servers (or a slow run) can't both send
  const claimed = await claim({ "offers.lastSentAt": new Date(now), "offers.ignored": ignored });
  if (!claimed.modifiedCount || ignored >= MAX_IGNORED) return false;
  await addNotification(role, person._id, { kind: "offer", title: offer.title, text: offer.text, link: offer.link });
  return true;
};

// runs with the 5-minute jobs; returns how many suggestions were sent
// (only: { patients: [ids], doctors: [ids] } limits a run to those people, used by tests)
export const sendOffers = async (now = Date.now(), only) => {
  let sent = 0;
  const scope = ids => (only ? { _id: { $in: ids || [] } } : {});
  const patients = await User.find({ role: "patient", ...dueFilter(now), ...scope(only?.patients) }).select("plus offers").limit(BATCH);
  for (const person of patients) {
    try {
      const tierId = patientTierOf(person);
      const offer = nextTier(PATIENT_ORDER, tierId) ? patientOffer(tierId, await patientStats(person._id)) : null;
      if (await sendOne({ Model: User, role: "patient", person, offer, now })) sent++;
    } catch (error) {
      logger.error("Offer failed", String(person._id), error.message);
    }
  }
  const doctors = await Doctor.find({ isApproved: "approved", ...dueFilter(now), ...scope(only?.doctors) }).select("plan offers specialization").limit(BATCH);
  for (const person of doctors) {
    try {
      const tierId = doctorTierOf(person);
      const offer = nextTier(DOCTOR_ORDER, tierId) ? doctorOffer(tierId, await doctorStats(person._id), person.specialization) : null;
      if (await sendOne({ Model: Doctor, role: "doctor", person, offer, now })) sent++;
    } catch (error) {
      logger.error("Offer failed", String(person._id), error.message);
    }
  }
  return sent;
};

// opening a suggestion shows interest: they start again
export const resumeOffers = (role, personId) =>
  (role === "doctor" ? Doctor : User).updateOne({ _id: personId, "offers.ignored": { $gt: 0 } }, { $set: { "offers.ignored": 0 } }).catch(() => {});

export const offersOn = async (role, personId) => {
  const person = await (role === "doctor" ? Doctor : User).findById(personId).select("offers");
  return !person?.offers?.optOut;
};

export const setOffersOn = (role, personId, on) =>
  (role === "doctor" ? Doctor : User).updateOne({ _id: personId }, { $set: { "offers.optOut": !on, ...(on && { "offers.ignored": 0 }) } });
