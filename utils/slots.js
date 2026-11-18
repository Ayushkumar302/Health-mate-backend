import Booking from "../models/BookingSchema.js";

// all appointment dates/times are stored as "YYYY-MM-DD" and "HH:mm" in the clinic's timezone
const TIME_ZONE = process.env.CLINIC_TIMEZONE || "Asia/Kolkata";

export const BOOKING_WINDOW_DAYS = 30;      // how far ahead a patient can book
export const CANCEL_CUTOFF_MINUTES = 120;   // patients get a refund only if they cancel 2h+ before
export const STRIPE_SESSION_MINUTES = 31;   // Stripe needs at least 30 minutes
export const HOLD_MINUTES = 35;             // unpaid bookings hold the slot a bit longer than the Stripe session lives

const WEEK_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const toMinutes = time => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

const toTime = minutes =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export const isValidDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || "") && !isNaN(Date.parse(`${date}T00:00:00Z`));
const isValidTime = time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || "");

// current date and minutes-since-midnight in the clinic's timezone
const clinicNow = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map(part => [part.type, part.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

const daysBetween = (fromDate, toDate) =>
  Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000);

// today in the clinic's timezone, "YYYY-MM-DD"
export const clinicToday = () => clinicNow().date;

// "YYYY-MM-DD" a number of days after a date
export const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export const daysFromTo = (fromDate, toDate) => daysBetween(fromDate, toDate);

// the doctor's time off covering this date, if any
export const leaveOn = (doctor, date) => (doctor.timeOff || []).find(entry => entry.from <= date && date <= entry.to) || null;

// minutes from now until the appointment starts (negative when it is in the past)
export const minutesUntil = (date, time) => {
  const now = clinicNow();
  return daysBetween(now.date, date) * 1440 + toMinutes(time) - now.minutes;
};

// how far the clinic's clock is ahead of UTC right now, in ms (e.g. +5:30 for India)
const clinicOffsetMs = () => {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    })
      .formatToParts(now)
      .map(part => [part.type, Number(part.value)])
  );
  const clinicWallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // round to whole minutes, timezone offsets are never smaller than that
  return Math.round((clinicWallClockAsUtc - now.getTime()) / 60000) * 60000;
};

// exact moment (epoch ms) of an appointment given in clinic time, same result whenever it is called
export const appointmentEpoch = (date, time) => Date.parse(`${date}T${time}:00Z`) - clinicOffsetMs();

export const makeSlotKey = (doctorId, date, time) => `${doctorId}_${date}_${time}`;

// A shift of the weekly routine says how patients can see the doctor then: "both" (default), "clinic" (in person
// only) or "online" (video consultations and quick calls only)
export const SHIFT_MODES = ["both", "clinic", "online"];
const shiftAllows = (slot, type) => {
  const mode = slot.mode || "both";
  if (!type || mode === "both") return true;
  return mode === "clinic" ? type === "clinic" : type !== "clinic";
};

// every slot start time the doctor offers on that date, based on their weekly routine. With a consultation
// type only the shifts that offer it count. Appointments follow each other with the doctor's break in between.
export const generateSlotTimes = (doctor, date, type) => {
  // on leave: nothing to offer (this also blocks booking and rescheduling onto that day)
  if (leaveOn(doctor, date)) return [];
  const day = WEEK_DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const duration = doctor.slotDuration || 30;
  const step = duration + (doctor.bufferMinutes || 0);
  const times = new Set();

  (doctor.timeSlots || [])
    .filter(slot => slot.day?.toLowerCase() === day && isValidTime(slot.startingTime) && isValidTime(slot.EndingTime) && shiftAllows(slot, type))
    .forEach(slot => {
      const end = toMinutes(slot.EndingTime);
      for (let start = toMinutes(slot.startingTime); start + duration <= end; start += step) {
        times.add(toTime(start));
      }
    });

  return [...times].sort();
};

const holdExpiry = () => new Date(Date.now() - HOLD_MINUTES * 60 * 1000);

// a booking blocks its slot when it is paid, or unpaid but still inside the payment hold
export const isBlocking = booking => booking.isPaid || booking.createdAt > holdExpiry();

// free up a slot whose unpaid hold has expired (its Stripe session can no longer be paid)
export const releaseExpiredHold = slotKey =>
  Booking.updateMany(
    { slotKey, isPaid: false, createdAt: { $lt: holdExpiry() } },
    { $unset: { slotKey: 1 }, $set: { status: "cancelled" } }
  );

// returns an error message if the doctor does not offer this date/time, otherwise null
// (windowDays: how far ahead this doctor can be booked, longer on the Pro plan)
export const validateSlot = (doctor, date, time, windowDays = BOOKING_WINDOW_DAYS, type) => {
  if (!isValidDate(date) || !isValidTime(time)) {
    return "Please choose a valid date and time";
  }
  const daysAhead = daysBetween(clinicNow().date, date);
  if (daysAhead < 0 || daysAhead > windowDays) {
    return `Appointments can be booked up to ${windowDays} days ahead`;
  }
  if (!generateSlotTimes(doctor, date, type).includes(time)) {
    // the doctor works then, but not for this kind of visit
    if (type && generateSlotTimes(doctor, date).includes(time)) {
      return type === "clinic" ? "The doctor only does video consultations at this time" : "The doctor only sees patients at the clinic at this time";
    }
    return "The doctor is not available at this time";
  }
  if (minutesUntil(date, time) <= 0) {
    return "This time has already passed";
  }
  return null;
};

// all slots of a day with their availability, past slots are left out
export const getSlotsForDate = async (doctor, date, type) => {
  const times = generateSlotTimes(doctor, date, type).filter(time => minutesUntil(date, time) > 0);
  if (times.length === 0) return [];

  const bookings = await Booking.find({ doctor: doctor._id, appointmentDate: date, slotKey: { $exists: true } });
  const blocking = bookings.filter(isBlocking);
  const takenTimes = new Set(blocking.map(booking => booking.appointmentTime));
  // a consultation the doctor extended runs into the following slot(s)
  blocking
    .filter(booking => booking.extendedMinutes > 0)
    .forEach(booking => {
      const from = toMinutes(booking.appointmentTime);
      const to = from + (booking.slotDuration || 30) + booking.extendedMinutes;
      times.forEach(time => {
        if (toMinutes(time) >= from && toMinutes(time) < to) takenTimes.add(time);
      });
    });

  return times.map(time => ({ time, available: !takenTimes.has(time) }));
};

// MongoDB duplicate key error = someone else got the slot first
export const isSlotTakenError = error => error?.code === 11000;
