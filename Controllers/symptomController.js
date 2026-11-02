import crypto from "node:crypto";
import mongoose from "mongoose";
import Doctor from "../models/DoctorSchema.js";
import User from "../models/UserSchema.js";
import SymptomCheck from "../models/SymptomCheckSchema.js";
import { URGENCIES, VISIT_TYPES, askGemini } from "../utils/symptoms/gemini.js";
import { findEmergency, ruleGuide } from "../utils/symptoms/rules.js";
import { QUOTA_NOTES, takeAiQuota } from "../utils/ai/quota.js";
import { cleanText } from "../utils/text.js";
import logger from "../utils/logger.js";

// the form's choices (the website shows the same lists)
export const CHIPS = [
  "Fever", "Headache", "Cough", "Sore throat", "Stomach pain", "Rash or itching", "Toothache", "Chest pain",
  "Breathlessness", "Dizziness", "Joint or back pain", "Anxiety or low mood", "Trouble sleeping",
  "Period problems", "Ear or nose problem", "Tiredness",
];
const AGE_GROUPS = { child: "child (under 14)", adult: "adult", senior: "60 or older" };
const DURATIONS = { today: "today", few_days: "a few days ago", weeks: "weeks ago or longer" };
const SEVERITIES = { mild: "mild", moderate: "moderate", severe: "severe" };

const MAX_SAVED = 20;
// the shared demo patient keeps only a few saved checks
const DEMO_MAX_SAVED = 5;

// specialties that have approved doctors right now: the only ones the checker may suggest
let specialtyCache = { at: 0, list: [] };
const listedSpecialties = async () => {
  if (Date.now() - specialtyCache.at < 5 * 60 * 1000 && specialtyCache.list.length) return specialtyCache.list;
  const groups = await Doctor.aggregate([
    { $match: { isApproved: "approved", specialization: { $nin: [null, ""] } } },
    { $group: { _id: { $toLower: "$specialization" }, label: { $first: "$specialization" } } },
    { $sort: { _id: 1 } },
  ]);
  const list = groups.map(group => ({ key: group._id, label: group.label.charAt(0).toUpperCase() + group.label.slice(1) }));
  specialtyCache = { at: Date.now(), list };
  return list;
};

// results kept for 30 minutes so the patient can choose to save one (the browser only sends back its id);
// capped so a flood of checks can't fill the server's memory (the oldest are dropped first)
const recent = new Map();
const RECENT_MS = 30 * 60 * 1000;
const RECENT_MAX = 5000;
setInterval(() => {
  const cutoff = Date.now() - RECENT_MS;
  for (const [id, item] of recent) if (item.at < cutoff) recent.delete(id);
}, 5 * 60 * 1000).unref();

const textList = (value, max = 4, length = 160) =>
  (Array.isArray(value) ? value : [])
    .filter(item => typeof item === "string")
    .map(item => cleanText(item).slice(0, length))
    .filter(Boolean)
    .slice(0, max);

// whatever came back (from Gemini or the rules) reduced to known values and short, clean text
const checkAnswer = (answer, keys) => {
  const specialty = keys.includes(answer.specialty) ? answer.specialty : keys.includes("general physician") ? "general physician" : keys[0];
  return {
    urgency: URGENCIES.includes(answer.urgency) ? answer.urgency : "routine",
    specialty,
    alsoConsider: [...new Set(textList(answer.alsoConsider, 2))].filter(key => keys.includes(key) && key !== specialty),
    visitType: VISIT_TYPES.includes(answer.visitType) ? answer.visitType : "quick-call",
    summary: cleanText(answer.summary).slice(0, 400),
    reasons: textList(answer.reasons),
    possibleCauses: textList(answer.possibleCauses),
    selfCare: textList(answer.selfCare),
    warningSigns: textList(answer.warningSigns),
  };
};

const doctorsFor = specialty =>
  Doctor.find({ isApproved: "approved", specialization: { $regex: `^${specialty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })
    .select("name specialization photo averageRating totalRating ticketPrice quickCallFee")
    .sort({ averageRating: -1, totalRating: -1, _id: 1 })
    .limit(3);

const readInput = body => ({
  symptoms: cleanText(body.symptoms).replace(/\s+/g, " ").slice(0, 500),
  chips: [...new Set(Array.isArray(body.chips) ? body.chips : [])].filter(chip => CHIPS.includes(chip)),
  ageGroup: AGE_GROUPS[body.ageGroup] ? body.ageGroup : "adult",
  duration: DURATIONS[body.duration] ? body.duration : "today",
  severity: SEVERITIES[body.severity] ? body.severity : "moderate",
});

// POST /symptom-check  body: { symptoms, chips, ageGroup, duration, severity }
export const checkSymptoms = async (req, res) => {
  const input = readInput(req.body || {});
  if (input.symptoms.length < 3 && input.chips.length === 0) {
    return res.status(400).json({ success: false, message: "Describe how you feel or pick at least one symptom" });
  }
  try {
    const remember = (source, result, extra = {}) => {
      const checkId = crypto.randomUUID();
      if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value);
      recent.set(checkId, { at: Date.now(), user: req.userId, input, source, result });
      return { checkId, source, result, ...extra };
    };

    // 1. emergencies are answered by the fixed rules straight away, nothing goes to Gemini
    const emergency = findEmergency(`${input.symptoms} ${input.chips.join(" ")}`);
    if (emergency) {
      const result = { urgency: "emergency", summary: emergency.message, emergency };
      return res.status(200).json({ success: true, data: remember("emergency", result, { doctors: [] }) });
    }

    const specialties = await listedSpecialties();
    if (!specialties.length) {
      return res.status(503).json({ success: false, message: "No doctors are listed yet, please try again later" });
    }
    const keys = specialties.map(item => item.key);

    // 2. Gemini when it's set up and today's free quota allows, otherwise 3. the rules guide
    let source = "rules";
    let answer;
    let note;
    const quota = takeAiQuota(req);
    if (quota === "ok") {
      try {
        const words = { ...input, ageGroup: AGE_GROUPS[input.ageGroup], duration: DURATIONS[input.duration] };
        ({ answer } = await askGemini(words, keys));
        if (answer.notSymptoms === true) {
          return res.status(400).json({ success: false, message: "That doesn't look like a description of symptoms. Try something like \"headache and fever for 2 days\"" });
        }
        source = "ai";
      } catch (error) {
        logger.error("Symptom check AI error:", error.message);
        note = QUOTA_NOTES.busy;
      }
    } else if (quota === "limit") {
      note = QUOTA_NOTES.limit;
    }
    if (!answer || source === "rules") answer = ruleGuide(input, keys);

    const checked = checkAnswer(answer, keys);
    const labelOf = key => specialties.find(item => item.key === key)?.label || key;
    const result = {
      ...checked,
      specialtyLabel: labelOf(checked.specialty),
      alsoConsider: checked.alsoConsider.map(key => ({ key, label: labelOf(key) })),
      // the AI can also judge something an emergency the fixed rules didn't catch
      ...(checked.urgency === "emergency" && {
        emergency: { kind: "medical", message: checked.summary, actions: ["Call 112 for an ambulance now", "Or go to the nearest hospital emergency department"] },
      }),
    };
    const doctors = checked.urgency === "emergency" ? [] : await doctorsFor(checked.specialty);
    res.status(200).json({ success: true, data: remember(source, result, { doctors, note }) });
  } catch (error) {
    logger.error("Symptom check error:", error.message);
    res.status(500).json({ success: false, message: "Could not check your symptoms, please try again" });
  }
};

// POST /symptom-check/saved  body: { checkId }  save a result to the patient's health record
export const saveCheck = async (req, res) => {
  const item = recent.get(String(req.body?.checkId || ""));
  if (!item || item.user !== req.userId) {
    return res.status(404).json({ success: false, message: "This result has expired, please check your symptoms again" });
  }
  try {
    const user = await User.findById(req.userId).select("isDemo");
    const max = user?.isDemo ? DEMO_MAX_SAVED : MAX_SAVED;
    if ((await SymptomCheck.countDocuments({ user: req.userId })) >= max) {
      return res.status(400).json({ success: false, message: `You can keep up to ${max} saved checks, delete one to save another` });
    }
    const { emergency, alsoConsider, ...rest } = item.result;
    const saved = await SymptomCheck.create({
      user: req.userId,
      input: item.input,
      source: item.source,
      result: { ...rest, alsoConsider: (alsoConsider || []).map(entry => entry.label), ...(emergency && { emergency }) },
    });
    recent.delete(req.body.checkId);
    res.status(201).json({ success: true, message: "Saved to your health record", data: saved });
  } catch (error) {
    logger.error("Save symptom check error:", error.message);
    res.status(500).json({ success: false, message: "Could not save this result" });
  }
};

// GET /symptom-check/saved  the patient's saved checks, newest first
export const getSavedChecks = async (req, res) => {
  try {
    const checks = await SymptomCheck.find({ user: req.userId }).sort({ createdAt: -1 }).limit(MAX_SAVED);
    res.status(200).json({ success: true, data: checks });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load your saved checks" });
  }
};

// DELETE /symptom-check/saved/:id
export const deleteSavedCheck = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: "Saved check not found" });
  }
  try {
    const deleted = await SymptomCheck.findOneAndDelete({ _id: req.params.id, user: req.userId });
    if (!deleted) return res.status(404).json({ success: false, message: "Saved check not found" });
    res.status(200).json({ success: true, message: "Deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not delete it" });
  }
};

// the latest saved checks of a patient, for the doctors treating them (patient record)
export const symptomChecksOf = userId => SymptomCheck.find({ user: userId }).sort({ createdAt: -1 }).limit(5);
