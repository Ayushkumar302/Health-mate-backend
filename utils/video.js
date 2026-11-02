import Booking from "../models/BookingSchema.js";
import { appointmentEpoch, isBlocking } from "./slots.js";

// Video consultations are peer-to-peer WebRTC calls between the patient's and the doctor's browser.
// The server only relays connection details (signaling) over Socket.io, see socket/callSocket.js.

export const JOIN_EARLY_MINUTES = 10;  // the call opens this long before the appointment
export const JOIN_GRACE_MINUTES = 15;  // and stays open this long after the slot ends
export const EXTEND_MINUTES = 10;      // one "Extend" click by the doctor
export const MAX_EXTENSION_MINUTES = 30;

const MINUTE = 60 * 1000;

// when the call can be joined, as epoch milliseconds
export const getCallWindow = booking => {
  // exact to the millisecond, so the join check and the scheduled hang-up always agree
  const startsAt = appointmentEpoch(booking.appointmentDate, booking.appointmentTime);
  // the doctor may have extended the consultation during the call
  const endsAt = startsAt + ((booking.slotDuration || 30) + (booking.extendedMinutes || 0)) * MINUTE;
  return {
    startsAt,
    endsAt,
    opensAt: startsAt - JOIN_EARLY_MINUTES * MINUTE,
    closesAt: endsAt + JOIN_GRACE_MINUTES * MINUTE,
  };
};

// checks that this user may join the call right now
// returns { booking, window } or { error: { status, code, message, data? } }
export const checkCallAccess = async ({ bookingId, userId, role }) => {
  const owner = role === "doctor" ? { doctor: userId } : { user: userId };
  let booking;
  try {
    booking = await Booking.findOne({ _id: bookingId, ...owner, isPaid: true });
  } catch {
    booking = null; // invalid id
  }
  if (!booking) {
    return { error: { status: 404, code: "NOT_FOUND", message: "Booking not found" } };
  }
  if (booking.status === "cancelled") {
    return { error: { status: 400, code: "CANCELLED", message: "This appointment was cancelled" } };
  }
  if (booking.consultationType === "clinic") {
    return { error: { status: 400, code: "IN_CLINIC", message: "This is a clinic visit, there is no video call for it" } };
  }
  if (booking.status !== "approved") {
    return { error: { status: 403, code: "NOT_CONFIRMED", message: "The doctor hasn't confirmed this appointment yet. The video room opens once they accept it" } };
  }
  if (!booking.appointmentDate || !booking.appointmentTime) {
    return { error: { status: 400, code: "NO_TIME", message: "This booking has no appointment time yet. Please reschedule it first" } };
  }

  const window = getCallWindow(booking);
  if (Date.now() < window.opensAt) {
    return { error: { status: 403, code: "TOO_EARLY", message: `The call opens ${JOIN_EARLY_MINUTES} minutes before your appointment`, data: window } };
  }
  if (Date.now() > window.closesAt) {
    return { error: { status: 410, code: "ENDED", message: "This consultation has ended", data: window } };
  }
  return { booking, window };
};

export const formatDoctorName = name => (name ? (/^dr\.?\s/i.test(name) ? name : `Dr. ${name}`) : "Doctor");

const to12Hour = time => {
  const [hours, minutes] = time.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
};

// doctor adds 10 minutes, only if that does not run into their next appointment
// returns { booking, window } or { error }
export const extendCall = async booking => {
  const extended = booking.extendedMinutes || 0;
  if (extended + EXTEND_MINUTES > MAX_EXTENSION_MINUTES) {
    return { error: `A consultation can be extended by at most ${MAX_EXTENSION_MINUTES} minutes` };
  }
  const window = getCallWindow(booking);
  const newEndsAt = window.endsAt + EXTEND_MINUTES * MINUTE;

  // the doctor's other live bookings that day (paid, or someone paying for it right now)
  const others = await Booking.find({
    doctor: booking.doctor,
    _id: { $ne: booking._id },
    appointmentDate: booking.appointmentDate,
    status: { $ne: "cancelled" },
    $or: [{ isPaid: true }, { slotKey: { $exists: true } }],
  });
  const clash = others
    .filter(isBlocking)
    .map(other => ({ other, start: appointmentEpoch(other.appointmentDate, other.appointmentTime) }))
    .filter(({ start }) => start >= window.startsAt && start < newEndsAt)
    .sort((a, b) => a.start - b.start)[0];
  if (clash) {
    return { error: `Can't extend: your next appointment starts at ${to12Hour(clash.other.appointmentTime)}` };
  }

  // only applies if nobody extended it in the meantime (double click, two tabs)
  const updated = await Booking.findOneAndUpdate(
    // older bookings may not have the field stored yet, null matches those
    { _id: booking._id, extendedMinutes: extended === 0 ? { $in: [0, null] } : extended },
    { $inc: { extendedMinutes: EXTEND_MINUTES } },
    { new: true }
  );
  if (!updated) return { error: "The consultation was just extended, please try again" };
  return { booking: updated, window: getCallWindow(updated) };
};
