import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { draftFromNotes, explainPrescription, getBookingPrescription, getMyPrescriptions, getPatientRecord, getPatientSummary, savePrescription } from "../Controllers/prescriptionController.js";
import { aiLimiter } from "../middleware/security.js";
import { getPatientReportPdf, reportAssistant } from "../Controllers/reportAssistantController.js";

const router = express.Router();

router.get("/mine", authenticate, restrict(["patient", "doctor"]), getMyPrescriptions);
router.get("/booking/:bookingId", authenticate, restrict(["patient", "doctor"]), getBookingPrescription);
router.put("/booking/:bookingId", authenticate, restrict(["doctor"]), savePrescription);
router.get("/patients/:userId/record", authenticate, restrict(["doctor"]), getPatientRecord);
router.post("/booking/:bookingId/explain", authenticate, restrict(["patient"]), aiLimiter, explainPrescription);
router.post("/patients/:userId/summary", authenticate, restrict(["doctor"]), aiLimiter, getPatientSummary);
// report assistant: a patient's report from a message, and the same report as a PDF
router.post("/report-assistant", authenticate, restrict(["doctor"]), aiLimiter, reportAssistant);
router.get("/patients/:userId/report/pdf", authenticate, restrict(["doctor"]), getPatientReportPdf);
router.post("/booking/:bookingId/draft", authenticate, restrict(["doctor"]), aiLimiter, draftFromNotes);

export default router;
