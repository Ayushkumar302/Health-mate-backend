// Report assistant (doctors): ask for a patient's report in plain words, see it, and download it as a PDF.
// Only the doctor's own patients (people who booked them) can be reported on, like the patient record.
import mongoose from "mongoose";
import Booking from "../models/BookingSchema.js";
import Prescription from "../models/PrescriptionSchema.js";
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Document from "../models/DocumentSchema.js";
import SymptomCheck from "../models/SymptomCheckSchema.js";
import { addDays, appointmentEpoch, clinicToday } from "../utils/slots.js";
import { typeLabel } from "../utils/consultation.js";
import { createDailyAllowance, takeAiQuota } from "../utils/ai/quota.js";
import { SECTIONS, askReportWithAI, askReportWithRules, checkReportRequest, periodLabel } from "../utils/ai/reportRequest.js";
import { patientReportPdf } from "../utils/patientReportPdf.js";
import { cleanText } from "../utils/text.js";
import logger from "../utils/logger.js";
import { ageOf, memberRecord, personFilters, summaryFacts, summaryFor } from "./prescriptionController.js";

export const REPORT_CHAT_DAILY = Number(process.env.REPORT_CHAT_DAILY) || 10;
const allowance = createDailyAllowance(REPORT_CHAT_DAILY);

const NOTES = {
  busy: "The AI is busy right now, so I read your message with simple rules.",
  limit: "Today's AI limit is reached, so I read your message with simple rules.",
};

const shortDate = date => new Date(date).toLocaleDateString("en-CA");
const isId = value => typeof value === "string" && mongoose.isValidObjectId(value);
const samePerson = (a, b) => a && b && a.userId === b.userId && (a.memberId || "") === (b.memberId || "");

// everyone who booked this doctor (paid), most recent first; family members are their own patients
const patientsOf = async doctorId => {
  const bookings = await Booking.find({ doctor: doctorId, isPaid: true, status: { $ne: "cancelled" } })
    .select("user familyMember appointmentDate")
    .sort({ appointmentDate: -1 })
    .limit(1000)
    .populate("user", "name");
  const people = new Map();
  for (const booking of bookings) {
    if (!booking.user) continue;
    const memberId = booking.familyMember?._id ? String(booking.familyMember._id) : "";
    const key = `${booking.user._id}|${memberId}`;
    if (people.has(key)) continue;
    people.set(key, {
      userId: String(booking.user._id),
      ...(memberId && { memberId, relation: booking.familyMember.relation, bookedBy: booking.user.name }),
      name: booking.familyMember?.name || booking.user.name,
      lastVisit: booking.appointmentDate,
    });
  }
  return [...people.values()];
};

const words = text => String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2);
// words of a request that are never a name ("full report for my latest patient")
const NOT_NAMES = new Set(
  "a an the my me i of for and or to on in from with all any full complete whole report reports summary history record records patient patients latest last recent past this month months week weeks year years day days only just their his her prescription prescriptions visit visits lab labs scan scans test tests symptom symptoms check checks health details pdf please give show make get send need want".split(" ")
);

// the patients whose name is in the text; a full name beats part of one
const matchPatients = (patients, text) => {
  const query = new Set(words(text).filter(word => !NOT_NAMES.has(word)));
  const scored = patients
    .map(person => {
      const parts = words(person.name);
      const hits = parts.filter(part => query.has(part)).length;
      return { person, hits, full: hits > 0 && hits === parts.length };
    })
    .filter(item => item.hits > 0);
  const pool = scored.some(item => item.full) ? scored.filter(item => item.full) : scored;
  const best = Math.max(0, ...pool.map(item => item.hits));
  return pool.filter(item => item.hits === best).map(item => item.person);
};

const choiceOf = person => ({
  label: `${person.name}${person.relation ? ` (${person.relation} of ${person.bookedBy})` : ""}`,
  hint: `last visit ${person.lastVisit}`,
  patient: { userId: person.userId, ...(person.memberId && { memberId: person.memberId }) },
});

const readPerson = value =>
  value && typeof value === "object" && isId(value.userId) && (!value.memberId || isId(value.memberId))
    ? { userId: value.userId, ...(value.memberId && { memberId: value.memberId }) }
    : null;

const visitStatus = visit => {
  if (visit.status === "cancelled") return "Cancelled";
  if (visit.status === "pending") return "Request";
  return appointmentEpoch(visit.appointmentDate, visit.appointmentTime) > Date.now() ? "Upcoming" : "Done";
};

// the parts of the record in the period (days: 0 = everything); null when the patient isn't found
export const reportData = async (doctorId, { userId, memberId }, days) => {
  const filters = personFilters(userId, memberId);
  const sinceDay = days ? addDays(clinicToday(), -days) : null;
  const since = days ? { $gte: new Date(Date.now() - days * 86400000) } : null;
  const [holder, visits, prescriptions, reports, checks] = await Promise.all([
    User.findById(userId).select("name phone gender bloodType dateOfBirth heightCm weightKg allergies conditions medications family"),
    Booking.find({ doctor: doctorId, user: userId, isPaid: true, ...filters.booking, ...(sinceDay && { appointmentDate: { $gte: sinceDay } }) })
      .select("appointmentDate appointmentTime consultationType status intake.summary")
      .sort({ appointmentDate: -1, appointmentTime: -1 })
      .limit(100),
    Prescription.find({ doctor: doctorId, user: userId, ...filters.prescription, ...(since && { createdAt: since }) })
      .select("diagnosis symptoms medicines tests advice followUpDate createdAt booking")
      .populate("booking", "appointmentDate")
      .sort({ createdAt: -1 })
      .limit(50),
    Document.find({ ownerRole: "patient", owner: userId, ...filters.document, ...(since && { createdAt: since }) })
      .select("category title reportDate createdAt")
      .sort({ reportDate: -1, createdAt: -1 })
      .limit(50),
    // saved symptom checks are the account holder's own
    memberId ? [] : SymptomCheck.find({ user: userId, ...(since && { createdAt: since }) }).select("input result createdAt").sort({ createdAt: -1 }).limit(20),
  ]);
  const person = !holder ? null : memberId ? memberRecord(holder, memberId) : holder;
  if (!person) return null;
  return {
    patient: {
      name: person.name,
      ...(person.relation && { relation: person.relation, bookedBy: person.bookedBy }),
      age: ageOf(person.dateOfBirth),
      gender: person.gender,
      bloodType: person.bloodType,
      bmi: person.heightCm && person.weightKg ? (person.weightKg / (person.heightCm / 100) ** 2).toFixed(1) : null,
      allergies: person.allergies || [],
      conditions: person.conditions || [],
      medications: person.medications || [],
    },
    visits: visits.map(visit => ({
      date: visit.appointmentDate,
      time: visit.appointmentTime,
      type: typeLabel(visit.consultationType),
      status: visitStatus(visit),
      complaint: visit.intake?.summary?.complaint || "",
    })),
    prescriptions: prescriptions.map(item => ({
      date: item.booking?.appointmentDate || shortDate(item.createdAt),
      diagnosis: item.diagnosis,
      symptoms: item.symptoms || "",
      medicines: item.medicines.map(({ name, dosage, frequency, duration, instructions }) => ({ name, dosage, frequency, duration, instructions })),
      tests: item.tests || [],
      advice: item.advice || "",
      followUpDate: item.followUpDate || "",
    })),
    reports: reports.map(item => ({ date: item.reportDate || shortDate(item.createdAt), category: item.category, title: item.title })),
    symptomChecks: checks.map(item => ({
      date: shortDate(item.createdAt),
      described: [item.input?.symptoms, ...(item.input?.chips || [])].filter(Boolean).join(", ").slice(0, 200),
      urgency: item.result?.urgency,
      specialty: item.result?.specialtyLabel,
    })),
  };
};

const pdfPath = (person, days, sections) => {
  const query = new URLSearchParams({ days: String(days), sections: sections.join(",") });
  if (person.memberId) query.set("member", person.memberId);
  return `/prescriptions/patients/${person.userId}/report/pdf?${query}`;
};

// POST /prescriptions/report-assistant  (doctor)
// body: { message?, patient?: { userId, memberId? } (picked from a list), current?: { patient, days, sections } }
export const reportAssistant = async (req, res) => {
  const message = cleanText(req.body?.message).replace(/\s+/g, " ").slice(0, 200);
  const picked = readPerson(req.body?.patient);
  if (message.length < 2 && !picked) {
    return res.status(400).json({ success: false, message: "Ask for a report, e.g. \"Rahul's prescriptions from the last 3 months\"" });
  }
  try {
    const turn = allowance(`${req.userId}|${req.ip}`);
    if (!turn.ok) {
      return res.status(429).json({
        success: false,
        code: "chat-limit",
        message: `You've used today's ${REPORT_CHAT_DAILY} messages to the report assistant. Patient records are still in your dashboard.`,
      });
    }
    let source = "rules";
    let note;
    const reply = data => res.status(200).json({ success: true, data: { source, left: turn.left, ...(note && { note }), ...data } });

    const patients = await patientsOf(req.userId);
    if (!patients.length) {
      return reply({ kind: "none", text: "You don't have any patients yet. Reports are ready once patients book you." });
    }
    const current = req.body?.current && typeof req.body.current === "object" ? req.body.current : null;
    const currentPerson = readPerson(current?.patient);
    const today = clinicToday();

    // a patient picked from the list needs no AI
    let parsed = { notReport: false, request: checkReportRequest({ periodDays: -1 }) };
    if (message && !picked) {
      const quota = takeAiQuota(req);
      if (quota === "ok") {
        try {
          parsed = await askReportWithAI(message, today);
          source = "ai";
        } catch (error) {
          logger.error("Report assistant AI error:", error.message);
          note = NOTES.busy;
          parsed = askReportWithRules(message, today);
        }
      } else {
        if (quota === "limit") note = NOTES.limit;
        parsed = askReportWithRules(message, today);
      }
    }
    if (parsed.notReport) {
      return reply({ kind: "help", text: "I make reports on your patients. Try \"full report for Rahul\" or \"Priya's prescriptions, last 3 months\"." });
    }

    // which patient: picked from the list, named in the message, or the one we were talking about
    let person = picked ? patients.find(item => samePerson(item, picked)) : null;
    if (!person && message) {
      let matches = matchPatients(patients, parsed.request.patientName);
      if (!matches.length) matches = matchPatients(patients, message);
      if (matches.length > 1) {
        return reply({ kind: "choose", text: "More than one of your patients matches. Which one?", choices: matches.slice(0, 6).map(choiceOf) });
      }
      person = matches[0] || null;
    }
    if (!person && currentPerson) person = patients.find(item => samePerson(item, currentPerson)) || null;
    if (!person) {
      return reply({
        kind: "choose",
        text: parsed.request.patientName
          ? `None of your patients is called "${parsed.request.patientName}". Here are your most recent ones.`
          : "Which patient? Pick one of your most recent, or type a name.",
        choices: patients.slice(0, 6).map(choiceOf),
      });
    }

    const sameAsBefore = samePerson(person, currentPerson);
    const days = parsed.request.days >= 0 ? parsed.request.days : sameAsBefore && Number.isInteger(current?.days) ? current.days : 0;
    const keptSections = sameAsBefore && Array.isArray(current?.sections) ? current.sections.filter(item => SECTIONS.includes(item)) : [];
    const sections = parsed.request.sections.length ? parsed.request.sections : keptSections.length ? keptSections : SECTIONS;

    const { facts, status, message: denied } = await summaryFacts(req.userId, person.userId, person.memberId);
    if (!facts) return res.status(status).json({ success: false, message: denied });
    const [data, summary] = await Promise.all([reportData(req.userId, person, days), summaryFor(req, { userId: person.userId, memberId: person.memberId, facts })]);
    if (!data) return res.status(404).json({ success: false, message: "Patient not found" });
    if (summary.note && !note) note = summary.note;

    return reply({
      kind: "report",
      text: `Here is ${person.name}'s report: ${periodLabel(days).toLowerCase()}.`,
      request: { patient: { userId: person.userId, ...(person.memberId && { memberId: person.memberId }) }, days, sections },
      report: { ...data, period: periodLabel(days), sections, summary: summary.summary, summarySource: summary.source },
      pdf: { path: pdfPath(person, days, sections), fileName: `medora-report-${slug(person.name)}-${today}.pdf` },
    });
  } catch (error) {
    logger.error("Report assistant error:", error.message);
    res.status(500).json({ success: false, message: "The report assistant couldn't answer, please try again" });
  }
};

const slug = name => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patient";

// GET /prescriptions/patients/:userId/report/pdf?member=&days=&sections=  (doctor) the report as a PDF.
// Uses the summary already made in the last 30 minutes, otherwise the plain one: no new AI request.
export const getPatientReportPdf = async (req, res) => {
  const { userId } = req.params;
  const memberId = req.query.member || undefined;
  if (!isId(userId) || (memberId && !isId(memberId))) {
    return res.status(404).json({ success: false, message: "Patient not found" });
  }
  const daysNumber = Number(req.query.days);
  const days = Number.isInteger(daysNumber) && daysNumber > 0 ? Math.min(daysNumber, 3650) : 0;
  const asked = String(req.query.sections || "").split(",").filter(item => SECTIONS.includes(item));
  const sections = asked.length ? [...new Set(asked)] : SECTIONS;
  try {
    const { facts, status, message } = await summaryFacts(req.userId, userId, memberId);
    if (!facts) return res.status(status).json({ success: false, message });
    const person = { userId, memberId };
    const [doctor, data, summary] = await Promise.all([
      Doctor.findById(req.userId).select("name specialization"),
      reportData(req.userId, person, days),
      summaryFor(req, { userId, memberId, facts, useAI: false }),
    ]);
    if (!data) return res.status(404).json({ success: false, message: "Patient not found" });
    const buffer = patientReportPdf({
      doctor,
      report: { ...data, period: periodLabel(days), sections, summary: summary.summary, summarySource: summary.source },
    });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="medora-report-${slug(data.patient.name)}-${clinicToday()}.pdf"`,
      "Cache-Control": "private, no-store",
    });
    res.send(buffer);
  } catch (error) {
    logger.error("Patient report PDF error:", error.message);
    res.status(500).json({ success: false, message: "Could not make the report" });
  }
};
