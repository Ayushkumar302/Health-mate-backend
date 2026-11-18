import mongoose from "mongoose";
import Booking from "../models/BookingSchema.js";
import User from "../models/UserSchema.js";
import { appointmentEpoch } from "../utils/slots.js";
import { cleanText } from "../utils/text.js";
import { typeLabel } from "../utils/consultation.js";
import { aiChecksFor } from "../utils/plus.js";
import { QUOTA_NOTES, takeAiQuota } from "../utils/ai/quota.js";
import { englishOnlyNote, readLang } from "../utils/ai/language.js";
import { DEFAULT_QUESTIONS, SEVERITY, SINCE, askFollowUps, plainIntakeSummary, summarizeWithAI } from "../utils/ai/intake.js";
import { addNotification } from "../utils/notifications.js";
import logger from "../utils/logger.js";

// The pre-visit form: open from booking until the appointment starts, on a booking that is still on.

const readForm = body => ({
  reason: cleanText(body?.reason).replace(/\s+/g, " ").slice(0, 500),
  since: SINCE[body?.since] ? body.since : undefined,
  severity: SEVERITY[body?.severity] ? body.severity : undefined,
  lang: readLang(body?.lang),
});

const openBooking = async req => {
  if (!mongoose.isValidObjectId(req.params.id)) return { status: 404, message: "Booking not found" };
  const booking = await Booking.findOne({ _id: req.params.id, user: req.userId, isPaid: true });
  if (!booking) return { status: 404, message: "Booking not found" };
  if (booking.status === "cancelled") return { status: 400, message: "This appointment was cancelled" };
  if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) <= Date.now()) {
    return { status: 400, message: "The appointment has started, tell the doctor in the consultation" };
  }
  return { booking };
};

// POST /bookings/:id/intake/questions  body: { reason, since, severity, lang }  (patient) up to 3 follow-up questions
export const getIntakeQuestions = async (req, res) => {
  const form = readForm(req.body);
  if (form.reason.length < 3) return res.status(400).json({ success: false, message: "Tell the doctor in a few words why you're coming" });
  try {
    const { booking, status, message } = await openBooking(req);
    if (!booking) return res.status(status).json({ success: false, message });
    const user = await User.findById(req.userId).select("plus");
    const quota = takeAiQuota(req, aiChecksFor(user));
    if (quota === "ok") {
      try {
        const questions = await askFollowUps({ ...form, visit: typeLabel(booking.consultationType) }, form.lang);
        return res.status(200).json({ success: true, data: { questions, source: "ai" } });
      } catch (error) {
        logger.error("Intake questions AI error:", error.message);
      }
    }
    const note = [quota === "limit" ? QUOTA_NOTES.limit : quota === "ok" ? QUOTA_NOTES.busy : undefined, englishOnlyNote(form.lang)].filter(Boolean).join(" ") || undefined;
    res.status(200).json({ success: true, data: { questions: DEFAULT_QUESTIONS, source: "rules", note } });
  } catch (error) {
    logger.error("Intake questions error:", error.message);
    res.status(500).json({ success: false, message: "Could not prepare the questions" });
  }
};

// PUT /bookings/:id/intake  body: { reason, since, severity, answers: [{ question, answer }], lang }  (patient)
// saves the form and the doctor's summary (in English); can be updated until the visit starts
export const saveIntake = async (req, res) => {
  const form = readForm(req.body);
  if (form.reason.length < 3) return res.status(400).json({ success: false, message: "Tell the doctor in a few words why you're coming" });
  const answers = (Array.isArray(req.body?.answers) ? req.body.answers : [])
    .slice(0, 3)
    .map(item => ({ question: cleanText(item?.question).slice(0, 200), answer: cleanText(item?.answer).replace(/\s+/g, " ").slice(0, 500) }))
    .filter(item => item.question);
  try {
    const { booking, status, message } = await openBooking(req);
    if (!booking) return res.status(status).json({ success: false, message });
    const intake = { ...form, answers, visit: typeLabel(booking.consultationType) };
    const user = await User.findById(req.userId).select("plus name");
    let summary = { ...plainIntakeSummary(intake), source: "rules" };
    if (takeAiQuota(req, aiChecksFor(user)) === "ok") {
      try {
        summary = { ...(await summarizeWithAI(intake)), source: "ai" };
      } catch (error) {
        logger.error("Intake summary AI error:", error.message);
      }
    }
    const first = !booking.intake?.submittedAt;
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { intake: { reason: form.reason, since: form.since, severity: form.severity, answers, lang: form.lang, summary, submittedAt: new Date() } } }
    );
    const who = booking.familyMember?.name || user.name;
    addNotification("doctor", booking.doctor, {
      kind: "booking",
      title: `${first ? "Pre-visit notes" : "Updated pre-visit notes"} from ${who}`,
      text: `${summary.complaint}${summary.redFlags.length ? ` · Watch out: ${summary.redFlags[0]}` : ""} (${booking.appointmentDate} at ${booking.appointmentTime})`,
      link: "/doctors/profile/me?appointments",
    });
    res.status(200).json({ success: true, message: "Sent to your doctor, they'll read it before the visit", data: { summary } });
  } catch (error) {
    logger.error("Save intake error:", error.message);
    res.status(500).json({ success: false, message: "Could not save your answers" });
  }
};
