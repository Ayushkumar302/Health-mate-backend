import Booking from "../models/BookingSchema.js";
import Review from "../models/ReviewSchema.js";
import Prescription from "../models/PrescriptionSchema.js";
import Doctor from "../models/DoctorSchema.js";
import { addNotification } from "./notifications.js";
import { addDays, appointmentEpoch, clinicToday } from "./slots.js";
import { ONLINE_TYPES, typeLabel } from "./consultation.js";
import logger from "./logger.js";

// "How was your visit?" goes out once, and only after a visit that really happened:
//  - confirmed, and nobody missed it
//  - a video call or quick call that both sides joined, or a clinic visit that ended a few hours ago
//    without the doctor marking the patient as missed (a prescription also proves it happened)
//  - the patient hasn't reviewed this doctor yet

const CLINIC_WAIT_MS = 3 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 14;

const endOf = booking =>
  appointmentEpoch(booking.appointmentDate, booking.appointmentTime) + ((booking.slotDuration || 30) + (booking.extendedMinutes || 0)) * 60000;

// did this visit happen? (hasPrescription: the doctor wrote one for it)
export const visitHappened = (booking, { hasPrescription = false, now = Date.now() } = {}) => {
  if (booking.status !== "approved" || booking.noShow || !booking.appointmentDate) return false;
  const end = endOf(booking);
  if (end > now) return false;
  if (hasPrescription) return true;
  if (ONLINE_TYPES.includes(booking.consultationType) && booking.joinsTracked) {
    return Boolean(booking.settledAt && booking.joinedAt?.patient && booking.joinedAt?.doctor);
  }
  return now - end >= CLINIC_WAIT_MS;
};

// a review is allowed once the patient has had a visit with the doctor that started and wasn't missed
export const hadVisitWith = (userId, doctorId) =>
  Booking.find({ user: userId, doctor: doctorId, isPaid: true, status: "approved", noShow: { $exists: false } })
    .select("appointmentDate appointmentTime")
    .then(visits => visits.some(visit => appointmentEpoch(visit.appointmentDate, visit.appointmentTime) <= Date.now()));

// runs with the 5-minute jobs (onlyBookings limits a run to those bookings, used by tests)
export const promptReviews = async (now = Date.now(), onlyBookings) => {
  const candidates = await Booking.find({
    ...(onlyBookings && { _id: { $in: onlyBookings } }),
    isPaid: true,
    status: "approved",
    reviewPromptedAt: { $exists: false },
    noShow: { $exists: false },
    appointmentDate: { $gte: addDays(clinicToday(), -LOOKBACK_DAYS), $lte: clinicToday() },
  }).limit(200);
  if (!candidates.length) return 0;
  const prescribed = new Set((await Prescription.find({ booking: { $in: candidates.map(b => b._id) } }).distinct("booking")).map(String));
  let sent = 0;
  for (const booking of candidates) {
    if (!visitHappened(booking, { hasPrescription: prescribed.has(String(booking._id)), now })) continue;
    try {
      const claimed = await Booking.updateOne({ _id: booking._id, reviewPromptedAt: { $exists: false } }, { $set: { reviewPromptedAt: new Date(now) } });
      if (!claimed.modifiedCount) continue;
      // one review per doctor: someone who already wrote one isn't asked again
      if (await Review.exists({ doctor: booking.doctor, user: booking.user })) continue;
      const doctor = await Doctor.findById(booking.doctor).select("name");
      if (!doctor) continue;
      const whose = booking.familyMember?.name ? `${booking.familyMember.name}'s` : "Your";
      await addNotification("patient", booking.user, {
        kind: "review",
        title: `How was your visit with ${doctor.name}?`,
        text: `${whose} ${typeLabel(booking.consultationType).toLowerCase()} on ${booking.appointmentDate}. A short review helps other patients choose, and helps the doctor improve.`,
        link: `/doctors/${booking.doctor}?tab=feedback`,
      });
      sent++;
    } catch (error) {
      logger.error("Review prompt failed", String(booking._id), error.message);
    }
  }
  return sent;
};
