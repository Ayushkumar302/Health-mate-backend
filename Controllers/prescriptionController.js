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
      { $set: data, $unset: { explanation: 1 }, $setOnInsert: { booking: booking._id, doctor: booking.doctor, user: booking.user } },
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
      .select("-explanation")
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
      .select("-explanation")
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

// GET /prescriptions/patients/:userId/record  (doctor) health record of a patient who booked them
export const getPatientRecord = async (req, res) => {
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) {
    return res.status(404).json({ success: false, message: "Patient not found" });
  }
  try {
    // only doctors the patient actually booked may see the record
    const visits = await Booking.find({ doctor: req.userId, user: userId, isPaid: true, status: { $ne: "cancelled" } })
      .select("appointmentDate appointmentTime slotDuration extendedMinutes status")
      .sort({ appointmentDate: -1, appointmentTime: -1 });
    if (visits.length === 0) {
      return res.status(403).json({ success: false, message: "You can only see the records of your own patients" });
    }
    const [patient, prescriptions, reports, symptomChecks] = await Promise.all([
      User.findById(userId).select(RECORD_FIELDS),
      Prescription.find({ doctor: req.userId, user: userId }).select("-explanation").sort({ createdAt: -1 }).populate("booking", "appointmentDate appointmentTime"),
      documentsOf("patient", [userId]),
      symptomChecksOf(userId),
    ]);
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }
    res.status(200).json({ success: true, message: "Patient record", data: { patient, visits, prescriptions, reports, symptomChecks } });
  } catch (error) {
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
    // asked before and the doctor hasn't changed it since
    if (prescription.explanation) {
      return res.status(200).json({ success: true, data: { source: "ai", explanation: prescription.explanation } });
    }
    const quota = takeAiQuota(req);
    let note = quota === "limit" ? QUOTA_NOTES.limit : undefined;
    if (quota === "ok") {
      try {
        const explanation = await explainWithAI(prescription);
        // kept without touching updatedAt, which tells the patient when the doctor last edited it
        await Prescription.updateOne({ _id: prescription._id }, { $set: { explanation } }, { timestamps: false });
        return res.status(200).json({ success: true, data: { source: "ai", explanation } });
      } catch (error) {
        logger.error("Explain prescription AI error:", error.message);
        note = QUOTA_NOTES.busy;
      }
    }
    res.status(200).json({ success: true, data: { source: "rules", explanation: plainExplanation(prescription), note } });
  } catch (error) {
    logger.error("Explain prescription error:", error.message);
    res.status(500).json({ success: false, message: "Could not explain the prescription" });
  }
};

const ageOf = dateOfBirth => {
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

// POST /prescriptions/patients/:userId/summary  (doctor) the patient's record in 3 lines before the visit
export const getPatientSummary = async (req, res) => {
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) {
    return res.status(404).json({ success: false, message: "Patient not found" });
  }
  try {
    // the same rule as the record: only doctors the patient booked
    const visits = await Booking.find({ doctor: req.userId, user: userId, isPaid: true, status: { $ne: "cancelled" } })
      .select("appointmentDate appointmentTime consultationType")
      .sort({ appointmentDate: 1, appointmentTime: 1 });
    if (visits.length === 0) {
      return res.status(403).json({ success: false, message: "You can only see the records of your own patients" });
    }
    const [patient, prescriptions, checks, reports] = await Promise.all([
      User.findById(userId).select("gender bloodType dateOfBirth heightCm weightKg allergies conditions medications"),
      Prescription.find({ doctor: req.userId, user: userId }).select("diagnosis medicines createdAt").sort({ createdAt: -1 }).limit(3),
      SymptomCheck.find({ user: userId }).select("input result createdAt").sort({ createdAt: -1 }).limit(3),
      Document.find({ ownerRole: "patient", owner: userId }).select("category title reportDate createdAt").sort({ createdAt: -1 }).limit(5),
    ]);
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    const next = visits.find(visit => appointmentEpoch(visit.appointmentDate, visit.appointmentTime) > Date.now());
    const bmi = patient.heightCm && patient.weightKg ? (patient.weightKg / (patient.heightCm / 100) ** 2).toFixed(1) : null;
    // facts only: no name, email, phone or emergency contact
    const facts = {
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
    };

    const key = `${req.userId}:${userId}:${JSON.stringify(facts)}`;
    const cached = summaryCache.get(key);
    if (cached && Date.now() - cached.at < SUMMARY_MS) {
      return res.status(200).json({ success: true, data: cached.data });
    }

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
    res.status(200).json({ success: true, data });
  } catch (error) {
    logger.error("Patient summary error:", error.message);
    res.status(500).json({ success: false, message: "Could not summarise the record" });
  }
};
