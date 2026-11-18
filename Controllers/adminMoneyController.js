import mongoose from "mongoose";
import Stripe from "stripe";
import Doctor from "../models/DoctorSchema.js";
import User from "../models/UserSchema.js";
import { PAID_DOCTOR_TIERS, doctorTierOf } from "../utils/plans.js";
import { PAID_PATIENT_TIERS, patientTierOf } from "../utils/plus.js";
import { DOCTOR_TIERS, PATIENT_TIERS } from "../utils/tiers.js";
import { defaultMoneySettings, moneySettings, moneySettingsUpdatedAt, readMoneyInput, saveMoneySettings } from "../utils/settings.js";
import { isDemoMode } from "../utils/demo.js";
import { addNotification } from "../utils/notifications.js";
import { formatDay } from "../utils/subscriptions.js";
import logger from "../utils/logger.js";

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY);

// in the demo every visitor shares the admin account, so money and plans can be looked at but not changed
const DEMO_READ_ONLY = "Money settings and plans are view-only in the demo, so every visitor sees the same prices and rules.";

// GET /admin/settings/money
export const getMoneySettings = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: { values: moneySettings(), defaults: defaultMoneySettings(), editable: !isDemoMode(), updatedAt: await moneySettingsUpdatedAt() },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load the settings" });
  }
};

// PUT /admin/settings/money  body: the values in percent and rupees
export const updateMoneySettings = async (req, res) => {
  if (isDemoMode()) return res.status(403).json({ success: false, message: DEMO_READ_ONLY });
  try {
    const result = await saveMoneySettings(readMoneyInput(req.body), req.userId);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    res.status(200).json({
      success: true,
      message: "Saved. New rates apply to new bookings and new members; existing ones keep theirs",
      data: { values: result.values, defaults: defaultMoneySettings(), editable: true, updatedAt: result.updatedAt },
    });
  } catch (error) {
    logger.error("Money settings error:", error.message);
    res.status(500).json({ success: false, message: "Could not save the settings" });
  }
};

const memberOf = (person, plan, kind, tier) => ({
  _id: person._id,
  kind,
  tier: tier.id,
  tierLabel: tier.label,
  pendingTier: plan.pendingTier || null,
  name: person.name,
  email: person.email,
  since: plan.since,
  expiresAt: plan.expiresAt,
  autoRenew: Boolean(plan.autoRenew),
  price: plan.price || tier.price,
  // demo data gives some plans without a payment behind them
  paid: Boolean(plan.subscriptionId),
  demo: Boolean(person.isDemo),
});

// GET /admin/plans  Pro doctors and Plus members, with what they bring in
export const getSubscriptions = async (req, res) => {
  try {
    const [doctors, patients] = await Promise.all([
      Doctor.find({ "plan.name": { $in: PAID_DOCTOR_TIERS } }).select("+plan.subscriptionId"),
      User.find({ "plus.name": { $in: PAID_PATIENT_TIERS } }).select("+plus.subscriptionId"),
    ]);
    const pro = doctors.filter(doctor => doctorTierOf(doctor) !== "free").map(doctor => memberOf(doctor, doctor.plan, "pro", DOCTOR_TIERS[doctorTierOf(doctor)]));
    const plus = patients.filter(user => patientTierOf(user) !== "free").map(user => memberOf(user, user.plus, "plus", PATIENT_TIERS[patientTierOf(user)]));
    // members per tier
    const countTiers = (members, ids) => ids.map(id => ({ id, count: members.filter(member => member.tier === id).length }));
    const summarize = (members, months) => ({
      active: members.length,
      renewing: members.filter(member => member.autoRenew).length,
      // paid subscriptions only, as monthly revenue (Plus is billed yearly)
      monthlyRevenue: Math.round(members.filter(member => member.paid && member.autoRenew).reduce((sum, member) => sum + member.price / months, 0) * 100) / 100,
    });
    res.status(200).json({
      success: true,
      data: {
        pro: { ...summarize(pro, 1), tiers: countTiers(pro, PAID_DOCTOR_TIERS) },
        plus: { ...summarize(plus, 12), tiers: countTiers(plus, PAID_PATIENT_TIERS) },
        members: [...pro, ...plus].sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt)),
        editable: !isDemoMode(),
      },
    });
  } catch (error) {
    logger.error("Subscriptions error:", error.message);
    res.status(500).json({ success: false, message: "Could not load the plans" });
  }
};

// PUT /admin/plans/:kind/:id/stop-renewal  the plan runs to the end of its paid period and is not renewed
export const stopRenewal = async (req, res) => {
  if (isDemoMode()) return res.status(403).json({ success: false, message: DEMO_READ_ONLY });
  const { kind, id } = req.params;
  if (!["pro", "plus"].includes(kind) || !mongoose.isValidObjectId(id)) {
    return res.status(404).json({ success: false, message: "Plan not found" });
  }
  try {
    const [Model, field, role, tierOf, tiers] = kind === "pro"
      ? [Doctor, "plan", "doctor", doctorTierOf, DOCTOR_TIERS]
      : [User, "plus", "patient", patientTierOf, PATIENT_TIERS];
    const person = await Model.findById(id).select(`+${field}.subscriptionId`);
    const plan = person?.[field];
    const tierId = person ? tierOf(person) : "free";
    const label = `Medora ${tiers[tierId]?.label}`;
    if (!plan || tierId === "free") {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }
    if (!plan.autoRenew) return res.status(400).json({ success: false, message: "This plan is already set to end" });
    if (plan.subscriptionId) await getStripe().subscriptions.update(plan.subscriptionId, { cancel_at_period_end: true });
    await Model.updateOne({ _id: id }, { $set: { [`${field}.autoRenew`]: false } });
    await addNotification(role, id, {
      kind: field,
      title: `${label} won't renew`,
      text: `Medora stopped the renewal of your plan. You keep it until ${formatDay(plan.expiresAt)}, nothing more will be charged.`,
    });
    res.status(200).json({ success: true, message: `Renewal stopped, the plan ends on ${formatDay(plan.expiresAt)}` });
  } catch (error) {
    logger.error("Stop renewal error:", error.message);
    res.status(500).json({ success: false, message: "Could not update the plan" });
  }
};
