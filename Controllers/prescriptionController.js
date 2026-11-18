import mongoose from "mongoose";
import Booking from "../models/BookingSchema.js";
import Prescription from "../models/PrescriptionSchema.js";
import User from "../models/UserSchema.js";
import { appointmentEpoch, isValidDate } from "../utils/slots.js";
import { JOIN_EARLY_MINUTES } from "../utils/video.js";
import { cleanText } from "../utils/text.js";
import { documentsOf } from "./documentController.js";
import { symptomChecksOf } from "./symptomController.js";
import SymptomCheck from "../models/SymptomCheckSchema.js";
import Document from "../models/DocumentSchema.js";
import { explainWithAI, plainExplanation } from "../utils/ai/prescriptionExplainer.js";
import { plainSummary, summarizeWithAI } from "../utils/ai/patientSummary.js";
import { QUOTA_NOTES, takeAiQuota } from "../utils/ai/quota.js";
import { typeLabel } from "../utils/consultation.js";
import logger from "../utils/logger.js"
import { englishOnlyNote, readLang } from "../utils/ai/language.js";
import { draftPrescription } from "../utils/ai/prescriptionDraft.js";
import Doctor from "../models/DoctorSchema.js";
import { doctorTier } from "../utils/plans.js";

const MAX_MEDICINES = 15;
const MAX_TESTS = 10;

const DOCTOR_FIELDS = "name specialization photo registrationNumber qualifications experiences phone email";
const PATIENT_FIELDS = "name photo gender bloodType dateOfBirth email phone";
// what a treating doctor can see of a patient's health record
const RECORD_FIELDS = "name photo gender bloodType dateOfBirth heightCm weightKg allergies conditions medications emergencyContact";

const limit = (value, max) => cleanText(value).slice(0, max);

// turn the form into clean fields, or return an error message
const parsePrescription = body => {
  const diagnosis = limit(body.diagnosis, 200);
  if (!diagnosis) return { error: "Please add a diagnosis" };

  const medicines = (Array.isArray(body.medicines) ? body.medicines : [])
    .map(medicine => ({
      name: limit(medicine?.name, 80),
      dosage: limit(medicine?.dosage, 40),
      frequency: limit(medicine?.frequency, 40),
      duration: limit(medicine?.duration, 40),
      instructions: limit(medicine?.instructions, 120),
    }))
    .filter(medicine => medicine.name);
  if (medicines.length > MAX_MEDICINES) return { error: `At most ${MAX_MEDICINES} medicines per prescription` };

  const tests = (Array.isArray(body.tests) ? body.tests : []).map(test => limit(test, 80)).filter(Boolean);
  if (tests.length > MAX_TESTS) return { error: `At most ${MAX_TESTS} tests per prescription` };

  const followUpDate = body.followUpDate || undefined;
  if (followUpDate && !isValidDate(followUpDate)) return { error: "Please pick a valid follow-up date" };

  return {
    data: {
      diagnosis,
      symptoms: limit(body.symptoms, 500),
      medicines,
      tests,
      advice: limit(body.advice, 1000),
      followUpDate,
    },
  };
};

// the booking, if the logged-in doctor or patient is part of it
const findOwnBooking = (req, bookingId) => {
  if (!mongoose.isValidObjectId(bookingId)) return null;
  const owner = req.role === "doctor" ? { doctor: req.userId } : { user: req.userId };
  return Booking.findOne({ _id: bookingId, isPaid: true, ...owner });
};

// PUT /prescriptions/booking/:bookingId  (doctor) create or update the prescription of a consultation
export const savePrescription = async (req, res) => {
  try {
    const booking = await findOwnBooking(req, req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    if (booking.status === "cancelled") {
      return res.status(400).json({ success: false, message: "This appointment was cancelled" });
    }
    if (booking.status === "pending") {
      return res.status(400).json({ success: false, message: "Accept the booking request first" });
    }
    // can be written from the moment the call opens (during the consultation) onwards
    const opensAt = appointmentEpoch(booking.appointmentDate, booking.appointmentTime) - JOIN_EARLY_MINUTES * 60 * 1000;
    if (Date.now() < opensAt) {
      return res.status(400).json({ success: false, message: "You can write the prescription once the consultation starts" });
    }

    const { data, error } = parsePrescription(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }
    if (data.followUpDate && data.followUpDate <= booking.appointmentDate) {
      return res.status(400).json({ success: false, message: "The follow-up date must be after the appointment" });
    }

    const prescription = await Prescription.findOneAndUpdate(
      { booking: booking._id },
      {
        $set: data,
        $unset: { explanation: 1, explanations: 1 },
        $setOnInsert: { booking: booking._id, doctor: booking.doctor, user: booking.user, ...(booking.familyMember?._id && { familyMember: booking.familyMember }) },
      },
      { new: true, upsert: true, runValidators: true }
    );
    res.status(200).json({ success: true, message: "Prescription saved, your patient can see it now", data: prescription });
  } catch (error) {
    logger.error("Save prescription error:", error.message);
    res.status(500).json({ success: false, message: "Could not save the prescription" });
  }
};

// GET /prescriptions/booking/:bookingId  (doctor or patient of the booking)
export const getBookingPrescription = async (req, res) => {
  try {
    const booking = await findOwnBooking(req, req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }
    const prescription = await Prescription.findOne({ booking: booking._id })
      .select("-explanation -explanations")
      .populate("doctor", DOCTOR_FIELDS)
      .populate("user", PATIENT_FIELDS)
      .populate("booking", "appointmentDate appointmentTime slotDuration");
    res.status(200).json({ success: true, message: prescription ? "Prescription found" : "No prescription yet", data: prescription });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load the prescription" });
  }
};

// GET /prescriptions/mine  patient: everything written for them, doctor: everything they wrote
export const getMyPrescriptions = async (req, res) => {
  try {
    const filter = req.role === "doctor" ? { doctor: req.userId } : { user: req.userId };
    const prescriptions = await Prescription.find(filter)
      .select("-explanation -explanations")
      .sort({ createdAt: -1 })
      .populate("doctor", DOCTOR_FIELDS)
      .populate("user", PATIENT_FIELDS)
      .populate("booking", "appointmentDate appointmentTime slotDuration");
    res.status(200).json({
      success: true,
      message: "Prescriptions found",
      // newest visit first
      data: prescriptions
        .filter(item => item.doctor && item.user && item.booking)
        .sort((a, b) => `${b.booking.appointmentDate} ${b.booking.appointmentTime}`.localeCompare(`${a.booking.appointmentDate} ${a.booking.appointmentTime}`)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load prescriptions" });
  }
};

// Whose record a doctor is looking at: the account holder, or one of their family members (?member=<id>,
// Plus Family). Each person's visits, prescriptions and reports are kept apart.
export const personFilters = (userId, memberId) => {
  if (memberId) {
    return {
      booking: { "familyMember._id": memberId },
      prescription: { "familyMember._id": memberId },
      document: { member: memberId },
    };
  }
  return {
    booking: { "familyMember._id": { $exists: false } },
    prescription: { "familyMember._id": { $exists: false } },
    document: { member: { $exists: false } },
  };
};

// the family member as a patient record (their own small record, plus the account holder as contact)
export const memberRecord = (holder, memberId) => {
  const member = (holder?.family || []).find(item => String(item._id) === String(memberId));
  if (!member) return null;
  return {
    _id: member._id,
    name: member.name,
    relation: member.relation,
    gender: member.gender,
    bloodType: member.bloodType,
    dateOfBirth: member.dateOfBirth,
    allergies: member.allergies,
    conditions: member.conditions,
    medications: member.medications,
    // the person who books and pays for them
    bookedBy: holder.name,
    emergencyContact: [holder.name, holder.phone].filter(Boolean).join(", "),
  };
};

const readMember = req => {
  const memberId = req.query.member || undefined;
  if (memberId && !mongoose.isValidObjectId(memberId)) return { error: true };
  return { memberId };
};

// GET /prescriptions/patients/:userId/record?member=  (doctor) health record of a patient who booked them
export const getPatientRecord = async (req, res) => {
  const { userId } = req.params;
  const { memberId, error } = readMember(req);
  if (!mongoose.isValidObjectId(userId) || error) {
    return res.status(404).json({ success: false, message: "Patient not found" });
  }
  try {
    const filters = personFilters(userId, memberId);
    // only doctors this person was actually booked with may see the record
    const visits = await Booking.find({ doctor: req.userId, user: userId, isPaid: true, status: { $ne: "cancelled" }, ...filters.booking })
      .select("appointmentDate appointmentTime slotDuration extendedMinutes status intake.summary")
      .sort({ appointmentDate: -1, appointmentTime: -1 });
    if (visits.length === 0) {
      return res.status(403).json({ success: false, message: "You can only see the records of your own patients" });
    }
    const [holder, prescriptions, reports, symptomChecks] = await Promise.all([
      User.findById(userId).select(`${RECORD_FIELDS} family`),
      Prescription.find({ doctor: req.userId, user: userId, ...filters.prescription }).select("-explanation -explanations").sort({ createdAt: -1 }).populate("booking", "appointmentDate appointmentTime"),
      documentsOf("patient", [userId], filters.document),
      // saved symptom checks are the account holder's own
      memberId ? [] : symptomChecksOf(userId),
    ]);
    const ownRecord = () => {
      const { family, ...rest } = holder.toObject();
      return rest;
    };
    const patient = !holder ? null : memberId ? memberRecord(holder, memberId) : ownRecord();
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }
    res.status(200).json({ success: true, message: "Patient record", data: { patient, visits, prescriptions, reports, symptomChecks } });
  } catch (error) {
    logger.error("Patient record error:", error.message);
    res.status(500).json({ success: false, message: "Could not load the patient record" });
  }
};

// POST /prescriptions/booking/:bookingId/explain  (patient) the prescription in plain words
export const explainPrescription = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.bookingId)) {
    return res.status(404).json({ success: false, message: "Prescription not found" });
  }
  try {
    const prescription = await Prescription.findOne({ booking: req.params.bookingId, user: req.userId });
    if (!prescription) {
      return res.status(404).json({ success: false, message: "Prescription not found" });
    }
    const lang = readLang(req.body?.lang);
    // asked before (in this language) and the doctor hasn't changed it since
    const cached = lang === "en" ? prescription.explanation : prescription.explanations?.[lang];
    if (cached) {
      return res.status(200).json({ success: true, data: { source: "ai", lang, explanation: cached } });
    }
    const quota = takeAiQuota(req);
    let note = quota === "limit" ? QUOTA_NOTES.limit : undefined;
    if (quota === "ok") {
      try {
        const explanation = await explainWithAI(prescription, lang);
        // kept without touching updatedAt, which tells the patient when the doctor last edited it
        await Prescription.updateOne({ _id: prescription._id }, { $set: { [lang === "en" ? "explanation" : `explanations.${lang}`]: explanation } }, { timestamps: false });
        return res.status(200).json({ success: true, data: { source: "ai", lang, explanation } });
      } catch (error) {
        logger.error("Explain prescription AI error:", error.message);
        note = QUOTA_NOTES.busy;
      }
    }
    note = [note, englishOnlyNote(lang)].filter(Boolean).join(" ") || undefined;
    res.status(200).json({ success: true, data: { source: "rules", lang: "en", explanation: plainExplanation(prescription), note } });
  } catch (error) {
    logger.error("Explain prescription error:", error.message);
    res.status(500).json({ success: false, message: "Could not explain the prescription" });
  }
};

export const ageOf = dateOfBirth => {
  if (!isValidDate(dateOfBirth)) return null;
  const birth = new Date(`${dateOfBirth}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  if (now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
};
const shortDate = date => new Date(date).toLocaleDateString("en-CA");

// summaries kept for 30 minutes, until the record they were made from changes
const summaryCache = new Map();
const SUMMARY_MS = 30 * 60 * 1000;

// The facts the pre-visit summary is made from: { facts } or { status, message } when this doctor may not see
// the patient. Facts only: no name, email, phone or emergency contact. Also used by the report assistant.
export const summaryFacts = async (doctorId, userId, memberId) => {
  const filters = personFilters(userId, memberId);
  // the same rule as the record: only doctors this person was booked with
  const visits = await Booking.find({ doctor: doctorId, user: userId, isPaid: true, status: { $ne: "cancelled" }, ...filters.booking })
    .select("appointmentDate appointmentTime consultationType intake.summary")
    .sort({ appointmentDate: 1, appointmentTime: 1 });
  if (visits.length === 0) return { status: 403, message: "You can only see the records of your own patients" };
  const [holder, prescriptions, checks, reports] = await Promise.all([
    User.findById(userId).select("name phone gender bloodType dateOfBirth heightCm weightKg allergies conditions medications family"),
    Prescription.find({ doctor: doctorId, user: userId, ...filters.prescription }).select("diagnosis medicines createdAt").sort({ createdAt: -1 }).limit(3),
    memberId ? [] : SymptomCheck.find({ user: userId }).select("input result createdAt").sort({ createdAt: -1 }).limit(3),
    Document.find({ ownerRole: "patient", owner: userId, ...filters.document }).select("category title reportDate createdAt").sort({ createdAt: -1 }).limit(5),
  ]);
  const patient = !holder ? null : memberId ? memberRecord(holder, memberId) : holder;
  if (!patient) return { status: 404, message: "Patient not found" };

  const next = visits.find(visit => appointmentEpoch(visit.appointmentDate, visit.appointmentTime) > Date.now());
  const bmi = patient.heightCm && patient.weightKg ? (patient.weightKg / (patient.heightCm / 100) ** 2).toFixed(1) : null;
  return {
    facts: {
      age: ageOf(patient.dateOfBirth),
      gender: patient.gender,
      bloodType: patient.bloodType,
      bmi,
      allergies: patient.allergies,
      conditions: patient.conditions,
      medications: patient.medications,
      visits: visits.length,
      nextVisit: next && `${typeLabel(next.consultationType).toLowerCase()} on ${next.appointmentDate} at ${next.appointmentTime}`,
      prescriptions: prescriptions.map(item => ({ date: shortDate(item.createdAt), diagnosis: item.diagnosis, medicines: item.medicines.map(medicine => medicine.name) })),
      symptomChecks: checks.map(item => ({
        date: shortDate(item.createdAt),
        described: [item.input?.symptoms, ...(item.input?.chips || [])].filter(Boolean).join(", ").slice(0, 200),
        urgency: item.result?.urgency,
        specialty: item.result?.specialtyLabel,
      })),
      reports: reports.map(item => ({ date: item.reportDate, category: item.category, title: item.title })),
      // what the patient told us before the upcoming visit (pre-visit intake)
      ...(next?.intake?.summary?.complaint && { intake: next.intake.summary }),
    },
  };
};

// { source, summary, note? }: a summary made in the last 30 minutes from the same facts is reused; otherwise a new
// AI one (when `useAI` and the quota allows) or the plain one built from the record
export const summaryFor = async (req, { userId, memberId, facts, useAI = true }) => {
  const key = `${req.userId}:${userId}:${memberId || ""}:${JSON.stringify(facts)}`;
  const cached = summaryCache.get(key);
  if (cached && Date.now() - cached.at < SUMMARY_MS) return cached.data;
  if (!useAI) return { source: "rules", summary: plainSummary(facts) };

  const quota = takeAiQuota(req);
  let data = { source: "rules", summary: plainSummary(facts), note: quota === "limit" ? QUOTA_NOTES.limit : undefined };
  if (quota === "ok") {
    try {
      data = { source: "ai", summary: await summarizeWithAI(facts) };
      if (summaryCache.size >= 500) summaryCache.delete(summaryCache.keys().next().value);
      summaryCache.set(key, { at: Date.now(), data });
    } catch (error) {
      logger.error("Patient summary AI error:", error.message);
      data.note = QUOTA_NOTES.busy;
    }
  }
  return data;
};

// POST /prescriptions/patients/:userId/summary  (doctor) the patient's record in 3 lines before the visit
export const getPatientSummary = async (req, res) => {
  const { userId } = req.params;
  const { memberId, error: memberError } = readMember(req);
  if (!mongoose.isValidObjectId(userId) || memberError) {
    return res.status(404).json({ success: false, message: "Patient not found" });
  }
  try {
    const { facts, status, message } = await summaryFacts(req.userId, userId, memberId);
    if (!facts) return res.status(status).json({ success: false, message });
    res.status(200).json({ success: true, data: await summaryFor(req, { userId, memberId, facts }) });
  } catch (error) {
    logger.error("Patient summary error:", error.message);
    res.status(500).json({ success: false, message: "Could not summarise the record" });
  }
};

// POST /prescriptions/booking/:bookingId/draft  body: { notes }  (doctor on Pro or Pro Clinic) the AI fills in the
// prescription form from rough notes. Nothing is saved: the doctor checks every field and saves it themselves.
export const draftFromNotes = async (req, res) => {
  const notes = cleanText(req.body?.notes).slice(0, 2000);
  if (notes.length < 5) return res.status(400).json({ success: false, message: "Write a few notes first, e.g. \"fever 3 days, throat red, azithromycin 500 od x3d, cbc\"" });
  try {
    const [booking, doctor] = await Promise.all([findOwnBooking(req, req.params.bookingId), Doctor.findById(req.userId).select("plan")]);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });
    if (booking.status === "cancelled") return res.status(400).json({ success: false, message: "This appointment was cancelled" });
    if (!doctorTier(doctor).aiTools) {
      return res.status(403).json({ success: false, code: "plan", message: "Prescription drafts from your notes come with Pro and Pro Clinic" });
    }
    // the person the visit is for: their allergies, conditions and medicines are checked against the draft
    const holder = await User.findById(booking.user).select("name phone gender dateOfBirth allergies conditions medications family");
    const person = booking.familyMember?._id ? memberRecord(holder, booking.familyMember._id) : holder;
    const quota = takeAiQuota(req, 40);
    if (quota !== "ok") {
      return res.status(quota === "off" ? 503 : 429).json({ success: false, message: quota === "off" ? "Drafts need the AI, which isn't available right now" : QUOTA_NOTES.limit });
    }
    try {
      const draft = await draftPrescription(notes, {
        age: ageOf(person?.dateOfBirth),
        gender: person?.gender,
        allergies: person?.allergies,
        conditions: person?.conditions,
        medications: person?.medications,
      });
      if (!draft.diagnosis && !draft.medicines.length) {
        return res.status(422).json({ success: false, message: "Couldn't find a diagnosis or medicines in those notes, add a little more detail" });
      }
      res.status(200).json({ success: true, message: "Draft ready, check every field before saving", data: draft });
    } catch (error) {
      logger.error("Prescription draft AI error:", error.message);
      res.status(503).json({ success: false, message: "The AI is busy, please try again in a minute" });
    }
  } catch (error) {
    logger.error("Prescription draft error:", error.message);
    res.status(500).json({ success: false, message: "Could not make the draft" });
  }
};
