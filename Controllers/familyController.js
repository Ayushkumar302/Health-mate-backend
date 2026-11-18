import mongoose from "mongoose";
import User from "../models/UserSchema.js";
import Booking from "../models/BookingSchema.js";
import { patientTier, patientTierOf } from "../utils/plus.js";
import { PATIENT_TIERS } from "../utils/tiers.js";
import { sanitizeFamilyMember } from "../utils/validate.js";
import { appointmentEpoch, clinicToday } from "../utils/slots.js";
import logger from "../utils/logger.js";

// Plus Family: the account holder adds up to 3 people (spouse, children, parents...), each with a small health
// record, and books visits for them. Members stay saved if the plan ends, but can only be booked for on it.

const familyTierLimit = () => Math.max(...Object.values(PATIENT_TIERS).map(tier => tier.familyMembers || 0));

const familyState = user => {
  const tier = patientTier(user);
  return {
    members: user.family || [],
    allowance: tier.familyMembers || 0,
    canBook: (tier.familyMembers || 0) > 0,
    discount: tier.consultDiscount || 0,
    tier: patientTierOf(user),
    // how many the family plan allows, for the upsell text
    familyPlanAllows: familyTierLimit(),
  };
};

// GET /users/family  (patient)
export const getFamily = async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("family plus");
    res.status(200).json({ success: true, data: familyState(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load your family" });
  }
};

// POST /users/family  (patient on Plus Family) body: { name, relation, gender, dateOfBirth, bloodType, allergies, conditions, medications }
export const addFamilyMember = async (req, res) => {
  const { member, error } = sanitizeFamilyMember(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const user = await User.findById(req.userId).select("family plus");
    const allowance = patientTier(user).familyMembers || 0;
    if (allowance === 0) {
      return res.status(403).json({ success: false, message: `Family profiles come with Plus Family: book for up to ${familyTierLimit()} family members with 5% off every visit` });
    }
    // the count is part of the filter, so two quick saves can't go past the limit
    const updated = await User.findOneAndUpdate(
      { _id: req.userId, [`family.${allowance - 1}`]: { $exists: false } },
      { $push: { family: member } },
      { new: true, runValidators: true }
    ).select("family plus");
    if (!updated) {
      return res.status(400).json({ success: false, message: `You can add up to ${allowance} family members` });
    }
    res.status(201).json({ success: true, message: `${member.name} added to your family`, data: familyState(updated) });
  } catch (err) {
    logger.error("Add family member error:", err.message);
    res.status(500).json({ success: false, message: "Could not add the family member" });
  }
};

// PUT /users/family/:memberId  (patient) their details can be kept up to date on any plan
export const updateFamilyMember = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.memberId)) {
    return res.status(404).json({ success: false, message: "Family member not found" });
  }
  const { member, error } = sanitizeFamilyMember(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  try {
    const set = Object.fromEntries(Object.entries(member).map(([key, value]) => [`family.$.${key}`, value]));
    const unset = Object.fromEntries(["gender", "dateOfBirth", "bloodType"].filter(key => !(key in member)).map(key => [`family.$.${key}`, 1]));
    const updated = await User.findOneAndUpdate(
      { _id: req.userId, "family._id": req.params.memberId },
      { $set: set, ...(Object.keys(unset).length && { $unset: unset }) },
      { new: true, runValidators: true }
    ).select("family plus");
    if (!updated) return res.status(404).json({ success: false, message: "Family member not found" });
    res.status(200).json({ success: true, message: "Saved", data: familyState(updated) });
  } catch (err) {
    logger.error("Update family member error:", err.message);
    res.status(500).json({ success: false, message: "Could not save the family member" });
  }
};

// DELETE /users/family/:memberId  (patient) not while they have an appointment coming up
export const removeFamilyMember = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.memberId)) {
    return res.status(404).json({ success: false, message: "Family member not found" });
  }
  try {
    const upcoming = await Booking.find({
      user: req.userId,
      "familyMember._id": req.params.memberId,
      isPaid: true,
      status: { $in: ["pending", "approved"] },
      appointmentDate: { $gte: clinicToday() },
    }).select("appointmentDate appointmentTime");
    if (upcoming.some(booking => appointmentEpoch(booking.appointmentDate, booking.appointmentTime) > Date.now())) {
      return res.status(400).json({ success: false, message: "They have an appointment coming up. Cancel it first, or remove them after the visit" });
    }
    const updated = await User.findOneAndUpdate(
      { _id: req.userId, "family._id": req.params.memberId },
      { $pull: { family: { _id: req.params.memberId } } },
      { new: true }
    ).select("family plus");
    if (!updated) return res.status(404).json({ success: false, message: "Family member not found" });
    res.status(200).json({ success: true, message: "Removed from your family", data: familyState(updated) });
  } catch (err) {
    logger.error("Remove family member error:", err.message);
    res.status(500).json({ success: false, message: "Could not remove the family member" });
  }
};
