import Booking from "../models/BookingSchema.js";
import Message from "../models/MessageSchema.js";
import User from "../models/UserSchema.js";
import { appointmentEpoch } from "./slots.js";
import { followUpDaysFor, PLUS } from "./plus.js";

const DAY = 24 * 60 * 60 * 1000;
// a patient can always answer a doctor who wrote to them in the last 3 days
const REPLY_DAYS = 3;

const endOf = booking =>
  appointmentEpoch(booking.appointmentDate, booking.appointmentTime) +
  ((booking.slotDuration || 30) + (booking.extendedMinutes || 0)) * 60 * 1000;

// Can this patient write to this doctor right now? Doctors can always write to their patients.
// Open while a paid booking is waiting or coming up, then for a while after the visit:
// a day on a free account, a week with Medora Plus.
// Returns { open, until, followUpDays, plus, reason }.
export const chatAccess = async (userId, doctorId, conversationId) => {
  const [user, bookings] = await Promise.all([
    User.findById(userId).select("plus"),
    Booking.find({ user: userId, doctor: doctorId, isPaid: true, appointmentDate: { $exists: true } }).select(
      "status appointmentDate appointmentTime slotDuration extendedMinutes noShow"
    ),
  ]);
  // already on the longest follow-up a plan gives: no point suggesting an upgrade
  const plus = followUpDaysFor(user) >= PLUS.followUpDays;
  const followUpDays = followUpDaysFor(user);
  const now = Date.now();

  // a request or appointment that hasn't ended yet
  const active = bookings.some(booking => booking.status !== "cancelled" && endOf(booking) > now);
  if (active) return { open: true, until: null, followUpDays, plus };

  // the last visit that took place (not cancelled, not missed by the patient)
  const lastVisitEnd = Math.max(0, ...bookings.filter(booking => booking.status === "approved" && booking.noShow !== "patient").map(endOf));
  const followUpUntil = lastVisitEnd ? lastVisitEnd + followUpDays * DAY : 0;

  // a recent message from the doctor can always be answered
  const lastFromDoctor = conversationId
    ? await Message.findOne({ conversation: conversationId, senderRole: "doctor" }).sort({ createdAt: -1 }).select("createdAt")
    : null;
  const replyUntil = lastFromDoctor ? lastFromDoctor.createdAt.getTime() + REPLY_DAYS * DAY : 0;

  const until = Math.max(followUpUntil, replyUntil);
  if (until > now) return { open: true, until: new Date(until), followUpDays, plus };

  return {
    open: false,
    until: null,
    followUpDays,
    plus,
    reason: !lastVisitEnd
      ? "Messaging opens again when you book a new appointment with this doctor."
      : plus
        ? `Your ${followUpDays}-day follow-up chat after the last visit has ended. Book a new appointment to message this doctor again.`
        : `Follow-up chat closes ${followUpDays === 1 ? "a day" : `${followUpDays} days`} after a visit. Book a new appointment, or get ${PLUS.followUpDays} days of follow-up chat with Medora Plus.`,
  };
};
