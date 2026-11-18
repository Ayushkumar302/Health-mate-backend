import { BOOKING_WINDOW_DAYS } from "./slots.js";
import { AI_PER_PERSON_DAILY } from "./ai/quota.js";

// Every plan Medora sells, and what each one gives. The prices, commissions and refund rates are defaults: the
// admin can change them (utils/settings.js changes these objects in place, so everything reads the current value).

const percentEnv = (name, fallback) => Math.max(0, Number(process.env[name]) || fallback) / 100;
const rupeesEnv = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);

// Doctors pay monthly. Paid plans buy visibility and convenience, never trust: verification, reviews and the
// symptom checker's suggestions are the same for every doctor.
export const DOCTOR_TIERS = {
  free: {
    id: "free", label: "Free", price: 0,
    commissionRate: Math.min(0.3, percentEnv("COMMISSION_PERCENT", 15)),
    bookingWindowDays: BOOKING_WINDOW_DAYS, timeOffEntries: 2,
    instantBooking: false, availableToday: false, featured: "none", analytics: "none", aiTools: false, clinicBranding: false,
  },
  starter: {
    id: "starter", label: "Pro Starter", price: rupeesEnv("STARTER_PRICE", 249),
    commissionRate: percentEnv("STARTER_COMMISSION_PERCENT", 12),
    bookingWindowDays: 45, timeOffEntries: 50,
    instantBooking: true, availableToday: true, featured: "none", analytics: "basic", aiTools: false, clinicBranding: false,
  },
  pro: {
    id: "pro", label: "Pro", price: rupeesEnv("PRO_PRICE", 499),
    commissionRate: percentEnv("PRO_COMMISSION_PERCENT", 8),
    bookingWindowDays: 60, timeOffEntries: 50,
    // "rotate": shares the featured places of their specialty, day by day
    instantBooking: true, availableToday: true, featured: "rotate", analytics: "full", aiTools: true, clinicBranding: false,
  },
  clinic: {
    id: "clinic", label: "Pro Clinic", price: rupeesEnv("CLINIC_PRICE", 1499),
    commissionRate: percentEnv("CLINIC_COMMISSION_PERCENT", 6),
    bookingWindowDays: 90, timeOffEntries: 50,
    // "priority": gets a featured place before Pro doctors do
    instantBooking: true, availableToday: true, featured: "priority", analytics: "full", aiTools: true, clinicBranding: true,
  },
};
export const DOCTOR_ORDER = ["free", "starter", "pro", "clinic"];

// featured placement: at most this many per specialty; a doctor who cancels too often is left out
export const FEATURED = { perSpecialty: 3, maxCancellationRate: 0.1 };

// Patients pay yearly.
const PLUS_REFUND = { early: 1, late: 0.75 };
export const PATIENT_TIERS = {
  free: {
    id: "free", label: "Free", price: 0,
    refund: { early: 0.9, late: 0.5 }, // patient cancels 2h+ before / later, after the doctor confirmed
    reschedules: 1, followUpDays: 1, aiChecksPerDay: AI_PER_PERSON_DAILY, reportsPerMonth: 1,
    waitlist: false, familyMembers: 0, consultDiscount: 0, available: true,
  },
  lite: {
    id: "lite", label: "Plus Lite", price: rupeesEnv("LITE_PRICE", 199),
    refund: { early: 0.95, late: 0.6 },
    reschedules: 2, followUpDays: 3, aiChecksPerDay: 30, reportsPerMonth: 5,
    waitlist: false, familyMembers: 0, consultDiscount: 0, available: true,
  },
  plus: {
    id: "plus", label: "Plus", price: rupeesEnv("PLUS_PRICE", 499),
    refund: PLUS_REFUND,
    reschedules: Infinity, followUpDays: 7, aiChecksPerDay: 50, reportsPerMonth: Infinity,
    waitlist: true, familyMembers: 0, consultDiscount: 0, available: true,
  },
  family: {
    id: "family", label: "Plus Family", price: rupeesEnv("FAMILY_PRICE", 999),
    // the same refunds as Plus (one object, so a change to one is a change to both)
    refund: PLUS_REFUND,
    reschedules: Infinity, followUpDays: 7, aiChecksPerDay: 50, reportsPerMonth: Infinity,
    // up to 3 people besides the account holder, and a discount on every consultation (paid by Medora)
    waitlist: true, familyMembers: 3, consultDiscount: 0.05, available: true,
  },
};
export const PATIENT_ORDER = ["free", "lite", "plus", "family"];

// JSON has no Infinity: "no limit" is sent as null
const forJson = tier => Object.fromEntries(Object.entries(tier).map(([key, value]) => [key, value === Infinity ? null : value]));
export const tiersForJson = (tiers, order) => order.map(id => forJson(tiers[id]));

export const rankOf = (order, id) => order.indexOf(id);
