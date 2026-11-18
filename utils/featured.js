import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import { PAID_DOCTOR_TIERS, doctorTier, doctorTierOf } from "./plans.js";
import { FEATURED } from "./tiers.js";
import { clinicToday, getSlotsForDate } from "./slots.js";
import { LISTED } from "./onboarding.js";

// How doctors on paid plans are shown in search: who is "Featured" right now (Pro and Pro Clinic) and who
// still has a free slot today (every paid plan). Worked out for the (few) paid doctors only and kept for a
// minute, so searching stays one cheap query.

const RATE_WINDOW_DAYS = 90;
const MIN_CONFIRMED = 5; // too few appointments say nothing about reliability

// share of confirmed appointments the doctor cancelled or missed in the last 90 days, per doctor id
export const cancellationRates = async doctorIds => {
  const since = new Date(Date.now() - RATE_WINDOW_DAYS * 86400000);
  const rows = await Booking.aggregate([
    {
      $match: {
        doctor: { $in: doctorIds },
        isPaid: true,
        createdAt: { $gte: since },
        // appointments the doctor had confirmed: still confirmed, cancelled by the patient afterwards, or dropped by the doctor
        $or: [{ status: "approved" }, { doctorFault: true }, { cancelledBy: "patient", respondedAt: { $exists: true } }],
      },
    },
    { $group: { _id: "$doctor", confirmed: { $sum: 1 }, cancelled: { $sum: { $cond: [{ $eq: ["$doctorFault", true] }, 1, 0] } } } },
  ]);
  return new Map(
    rows.map(row => [String(row._id), { confirmed: row.confirmed, cancelled: row.cancelled, rate: row.confirmed >= MIN_CONFIRMED ? row.cancelled / row.confirmed : 0 }])
  );
};

export const cancellationRateOf = async doctorId =>
  (await cancellationRates([doctorId])).get(String(doctorId)) || { confirmed: 0, cancelled: 0, rate: 0 };

let cache = { at: 0, value: null };
export const clearFeaturedCache = () => {
  cache = { at: 0, value: null };
};

// { pro, featured, availableToday }: sets of doctor ids (strings)
export const proVisibility = async () => {
  if (cache.value && Date.now() - cache.at < 60 * 1000) return cache.value;

  const doctors = (
    await Doctor.find({ ...LISTED, "plan.name": { $in: PAID_DOCTOR_TIERS } }).select("specialization plan timeSlots slotDuration bufferMinutes timeOff")
  ).filter(doctor => doctorTierOf(doctor) !== "free");
  const rates = await cancellationRates(doctors.map(doctor => doctor._id));

  // featured: reliable Pro Clinic and Pro doctors, a few per specialty. Clinic doctors get the places first;
  // whoever doesn't fit takes turns, a new set each day
  const bySpecialty = new Map();
  for (const doctor of doctors) {
    const placement = doctorTier(doctor).featured;
    if (placement === "none") continue;
    if ((rates.get(String(doctor._id))?.rate || 0) > FEATURED.maxCancellationRate) continue;
    const key = (doctor.specialization || "").toLowerCase();
    const group = bySpecialty.get(key) || { priority: [], rotate: [] };
    group[placement === "priority" ? "priority" : "rotate"].push(String(doctor._id));
    bySpecialty.set(key, group);
  }
  const day = Math.floor(Date.parse(`${clinicToday()}T00:00:00Z`) / 86400000);
  const featured = new Set();
  const takeTurns = (ids, places) => {
    ids.sort();
    for (let i = 0; i < Math.min(places, ids.length); i++) featured.add(ids[(day + i) % ids.length]);
  };
  for (const { priority, rotate } of bySpecialty.values()) {
    takeTurns(priority, FEATURED.perSpecialty);
    takeTurns(rotate, FEATURED.perSpecialty - Math.min(FEATURED.perSpecialty, priority.length));
  }

  const today = clinicToday();
  const availableToday = new Set();
  for (const doctor of doctors) {
    if (!doctorTier(doctor).availableToday) continue;
    if ((await getSlotsForDate(doctor, today)).some(slot => slot.available)) availableToday.add(String(doctor._id));
  }

  cache = { at: Date.now(), value: { pro: new Set(doctors.map(doctor => String(doctor._id))), featured, availableToday } };
  return cache.value;
};
