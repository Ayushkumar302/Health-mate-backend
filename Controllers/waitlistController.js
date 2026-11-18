import mongoose from "mongoose";
import Waitlist from "../models/WaitlistSchema.js";
import Doctor from "../models/DoctorSchema.js";
import User from "../models/UserSchema.js";
import { clinicToday, daysFromTo, getSlotsForDate, isValidDate } from "../utils/slots.js";
import { bookingWindowFor } from "../utils/plans.js";
import { patientTier } from "../utils/plus.js";
import { LISTED } from "../utils/onboarding.js";
import { CONSULTATION_TYPES, typeLabel } from "../utils/consultation.js";
import { addNotification } from "../utils/notifications.js";
import logger from "../utils/logger.js";

// The waitlist (Plus and Plus Family): wait for a slot on a day the doctor is fully booked.

const MAX_ACTIVE = 5;

const formatDay = date => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

// POST /bookings/waitlist  body: { doctorId, date, consultationType }  (patient on Plus or Plus Family)
export const joinWaitlist = async (req, res) => {
  const { doctorId, date } = req.body || {};
  const type = CONSULTATION_TYPES.includes(req.body?.consultationType) ? req.body.consultationType : undefined;
  if (!mongoose.isValidObjectId(doctorId) || !isValidDate(date)) {
    return res.status(400).json({ success: false, message: "Choose a doctor and a day" });
  }
  try {
    const user = await User.findById(req.userId).select("plus");
    if (!patientTier(user).waitlist) {
      return res.status(403).json({ success: false, code: "plan", message: "The waitlist comes with Plus and Plus Family: we tell you as soon as a slot opens up" });
    }
    const doctor = await Doctor.findOne({ _id: doctorId, ...LISTED }).select("name timeSlots slotDuration bufferMinutes timeOff plan");
    if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found" });
    const ahead = daysFromTo(clinicToday(), date);
    if (ahead < 0 || ahead > bookingWindowFor(doctor)) {
      return res.status(400).json({ success: false, message: `This doctor can be booked up to ${bookingWindowFor(doctor)} days ahead` });
    }
    const slots = await getSlotsForDate(doctor, date, type);
    if (slots.length === 0) return res.status(400).json({ success: false, message: "The doctor doesn't work on this day" });
    if (slots.some(slot => slot.available)) return res.status(400).json({ success: false, message: "There are free slots on this day, you can book one now" });
    const active = await Waitlist.countDocuments({ user: req.userId, date: { $gte: clinicToday() }, notifiedAt: { $exists: false } });
    if (active >= MAX_ACTIVE) return res.status(400).json({ success: false, message: `You can wait for up to ${MAX_ACTIVE} days at a time` });
    const entry = await Waitlist.findOneAndUpdate(
      { doctor: doctor._id, user: req.userId, date },
      { $set: { consultationType: type }, $unset: { notifiedAt: 1 } },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true, message: `You're on the waitlist for ${formatDay(date)}. We'll tell you as soon as a slot opens`, data: entry });
  } catch (error) {
    logger.error("Join waitlist error:", error.message);
    res.status(500).json({ success: false, message: "Could not join the waitlist" });
  }
};

// GET /bookings/waitlist/mine  (patient) days they are waiting for (and ones a slot opened on)
export const getMyWaitlist = async (req, res) => {
  try {
    const entries = await Waitlist.find({ user: req.userId, date: { $gte: clinicToday() } })
      .sort({ date: 1 })
      .populate("doctor", "name photo specialization");
    res.status(200).json({ success: true, data: entries.filter(entry => entry.doctor) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load your waitlist" });
  }
};

// DELETE /bookings/waitlist/:id  (patient)
export const leaveWaitlist = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Not on the waitlist" });
  try {
    const deleted = await Waitlist.findOneAndDelete({ _id: req.params.id, user: req.userId });
    if (!deleted) return res.status(404).json({ success: false, message: "Not on the waitlist" });
    res.status(200).json({ success: true, message: "Removed from the waitlist" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update the waitlist" });
  }
};

// a slot may have opened with this doctor on this day: tell everyone waiting (first to book gets it).
// Called right after cancellations, declines and moves, and by the 5-minute job. Never throws.
export const checkWaitlist = async (doctorId, date) => {
  try {
    if (!date || date < clinicToday()) return 0;
    const waiting = await Waitlist.find({ doctor: doctorId, date, notifiedAt: { $exists: false } });
    if (!waiting.length) return 0;
    const doctor = await Doctor.findById(doctorId).select("name timeSlots slotDuration bufferMinutes timeOff");
    if (!doctor) return 0;
    let told = 0;
    for (const entry of waiting) {
      const free = (await getSlotsForDate(doctor, date, entry.consultationType)).filter(slot => slot.available);
      if (!free.length) continue;
      const claimed = await Waitlist.updateOne({ _id: entry._id, notifiedAt: { $exists: false } }, { $set: { notifiedAt: new Date() } });
      if (!claimed.modifiedCount) continue;
      await addNotification("patient", entry.user, {
        kind: "waitlist",
        title: `A slot opened with ${doctor.name} on ${formatDay(date)}`,
        text: `${free.length === 1 ? "1 slot is" : `${free.length} slots are`} free now${entry.consultationType ? ` for a ${typeLabel(entry.consultationType).toLowerCase()}` : ""}. Book quickly, others on the waitlist were told too.`,
        link: `/doctors/${doctorId}`,
      });
      told++;
    }
    return told;
  } catch (error) {
    logger.error("Waitlist check failed", String(doctorId), date, error.message);
    return 0;
  }
};

// 5-minute job: days that have passed are cleared, and every waited-for day is checked again (holds that expired
// free slots too, without anyone cancelling)
export const sweepWaitlist = async () => {
  await Waitlist.deleteMany({ date: { $lt: clinicToday() } });
  const pairs = await Waitlist.aggregate([{ $match: { notifiedAt: { $exists: false } } }, { $group: { _id: { doctor: "$doctor", date: "$date" } } }, { $limit: 200 }]);
  for (const pair of pairs) await checkWaitlist(pair._id.doctor, pair._id.date);
};
