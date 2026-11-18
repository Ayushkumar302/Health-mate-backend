import Setting from "../models/SettingSchema.js";
import { DOCTOR_TIERS, PATIENT_TIERS } from "./tiers.js";

// Money settings the admin can change: commissions, plan prices and refund rates. The values in .env (or the
// built-in ones in utils/tiers.js) are the defaults; a saved change lives in MongoDB and is loaded when the
// server starts. What changes, and what doesn't:
//  - a booking keeps the commission it was paid with, so a new rate only applies to new bookings
//  - members keep the price they subscribed at (Stripe bills it); a new price is for new members
//  - refund rates apply to cancellations from now on

const D = DOCTOR_TIERS;
const P = PATIENT_TIERS;
const round1 = value => Math.round(value * 10) / 10;
const pct = value => round1(value * 100);

// field -> [read the current value, write a new one]
const FIELDS = {
  commissionPercent: [() => pct(D.free.commissionRate), v => { D.free.commissionRate = v / 100; }],
  starterCommissionPercent: [() => pct(D.starter.commissionRate), v => { D.starter.commissionRate = v / 100; }],
  proCommissionPercent: [() => pct(D.pro.commissionRate), v => { D.pro.commissionRate = v / 100; }],
  clinicCommissionPercent: [() => pct(D.clinic.commissionRate), v => { D.clinic.commissionRate = v / 100; }],
  starterPrice: [() => D.starter.price, v => { D.starter.price = v; }],
  proPrice: [() => D.pro.price, v => { D.pro.price = v; }],
  clinicPrice: [() => D.clinic.price, v => { D.clinic.price = v; }],
  litePrice: [() => P.lite.price, v => { P.lite.price = v; }],
  plusPrice: [() => P.plus.price, v => { P.plus.price = v; }],
  familyPrice: [() => P.family.price, v => { P.family.price = v; }],
  refundEarlyPercent: [() => pct(P.free.refund.early), v => { P.free.refund.early = v / 100; }],
  refundLatePercent: [() => pct(P.free.refund.late), v => { P.free.refund.late = v / 100; }],
  liteRefundEarlyPercent: [() => pct(P.lite.refund.early), v => { P.lite.refund.early = v / 100; }],
  liteRefundLatePercent: [() => pct(P.lite.refund.late), v => { P.lite.refund.late = v / 100; }],
  // (Plus Family shares these refund rates)
  plusRefundEarlyPercent: [() => pct(P.plus.refund.early), v => { P.plus.refund.early = v / 100; }],
  plusRefundLatePercent: [() => pct(P.plus.refund.late), v => { P.plus.refund.late = v / 100; }],
};
const NAMES = Object.keys(FIELDS);

// the current values, in percent and rupees
export const moneySettings = () => Object.fromEntries(NAMES.map(name => [name, FIELDS[name][0]()]));

// what the server started with, before any saved change
const DEFAULTS = moneySettings();
export const defaultMoneySettings = () => ({ ...DEFAULTS });

const isPrice = value => Number.isInteger(value) && value >= 49 && value <= 9999;

// every rule a set of values must follow; returns the first problem, or null
const problemWith = v => {
  if (NAMES.some(name => typeof v[name] !== "number" || !Number.isFinite(v[name]))) return "Fill in every value with a number";
  if (v.commissionPercent < 0 || v.commissionPercent > 30) return "Commission must be between 0% and 30%";
  if (!(v.starterCommissionPercent <= v.commissionPercent && v.proCommissionPercent <= v.starterCommissionPercent && v.clinicCommissionPercent <= v.proCommissionPercent)) {
    return "Commissions must go down with each plan: Free ≥ Pro Starter ≥ Pro ≥ Pro Clinic";
  }
  // the Plus Family discount is paid out of the commission, so no plan's commission may be smaller than it
  const discount = round1(P.family.consultDiscount * 100);
  if (v.clinicCommissionPercent < discount) return `Every commission must be at least ${discount}%, the Plus Family discount it pays for`;
  if (![v.starterPrice, v.proPrice, v.clinicPrice, v.litePrice, v.plusPrice, v.familyPrice].every(isPrice)) {
    return "Prices must be whole rupees between ₹49 and ₹9,999";
  }
  if (!(v.starterPrice < v.proPrice && v.proPrice < v.clinicPrice)) return "Doctor plan prices must go up: Pro Starter < Pro < Pro Clinic";
  if (!(v.litePrice < v.plusPrice && v.plusPrice < v.familyPrice)) return "Patient plan prices must go up: Plus Lite < Plus < Plus Family";
  const refunds = [
    [v.refundEarlyPercent, v.refundLatePercent],
    [v.liteRefundEarlyPercent, v.liteRefundLatePercent],
    [v.plusRefundEarlyPercent, v.plusRefundLatePercent],
  ];
  if (refunds.flat().some(value => value < 0 || value > 100)) return "Refunds must be between 0% and 100%";
  if (refunds.some(([early, late]) => late > early)) return "A late cancellation can't refund more than an early one";
  for (let i = 1; i < refunds.length; i++) {
    if (refunds[i][0] < refunds[i - 1][0] || refunds[i][1] < refunds[i - 1][1]) return "Refunds can't get worse on a better plan: Free ≤ Plus Lite ≤ Plus";
  }
  return null;
};

const apply = v => NAMES.forEach(name => FIELDS[name][1](v[name]));

// only the known fields, as numbers
export const readMoneyInput = body =>
  Object.fromEntries(NAMES.map(name => [name, body?.[name] === "" || body?.[name] == null ? NaN : Number(body[name])]));

// at startup: a saved change replaces the defaults (anything invalid is ignored)
export const loadMoneySettings = async () => {
  const saved = await Setting.findOne({ key: "money" });
  if (!saved) return null;
  const values = { ...DEFAULTS, ...saved.value };
  if (problemWith(values)) return null;
  apply(values);
  return saved.updatedAt;
};

// save a change made in the admin panel; returns { error } or { values, updatedAt }
export const saveMoneySettings = async (input, adminId) => {
  const values = { ...moneySettings(), ...input };
  const error = problemWith(values);
  if (error) return { error };
  const saved = await Setting.findOneAndUpdate(
    { key: "money" },
    { $set: { value: values, updatedBy: adminId } },
    { new: true, upsert: true }
  );
  apply(values);
  return { values: moneySettings(), updatedAt: saved.updatedAt };
};

export const moneySettingsUpdatedAt = async () => (await Setting.findOne({ key: "money" }).select("updatedAt"))?.updatedAt || null;
