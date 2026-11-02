import mongoose from "mongoose";
import multer from "multer";
import Booking from "../models/BookingSchema.js";
import Document, { DOCTOR_CATEGORIES, PATIENT_CATEGORIES } from "../models/DocumentSchema.js";
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import { MAX_FILE_BYTES, deleteFile, detectFileType, safeFileName, saveFile, streamFile } from "../utils/files.js";
import { isValidDate } from "../utils/slots.js";
import { cleanText } from "../utils/text.js";
import { isDemoMode } from "../utils/demo.js";
import logger from "../utils/logger.js"

// medical reports (patients) and verification documents (doctors)

const LIMITS = { patient: 30, doctor: 10 };
// shared demo accounts can keep only a few uploads of their own (the sample files don't count)
const DEMO_UPLOAD_LIMIT = 5;

const CATEGORY_TITLES = {
  lab: "Lab report",
  imaging: "Scan / imaging report",
  prescription: "Old prescription",
  other: "Medical document",
  registration: "Medical registration certificate",
  degree: "Degree certificate",
  "id-proof": "Government ID",
};

export const PUBLIC_FIELDS = "ownerRole category title reportDate fileName mimeType size locked createdAt";

// keep the file in memory (max 5 MB) and write it to GridFS after checking it
export const uploadFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
}).single("file");

const ownerRole = req => (req.role === "doctor" ? "doctor" : "patient");

// a doctor may see a patient's reports once the patient has a paid booking with them
const doctorTreats = (doctorId, userId) =>
  Booking.exists({ doctor: doctorId, user: userId, isPaid: true, status: { $ne: "cancelled" } });

// POST /documents  (multipart: file, category, title, reportDate)
export const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Choose a file to upload" });
    }
    const role = ownerRole(req);
    const allowed = role === "doctor" ? DOCTOR_CATEGORIES : PATIENT_CATEGORIES;
    const { category } = req.body;
    if (!allowed.includes(category)) {
      return res.status(400).json({ success: false, message: "Choose what kind of document this is" });
    }
    const type = detectFileType(req.file.buffer);
    if (!type) {
      return res.status(400).json({ success: false, message: "Only PDF, JPG and PNG files are allowed" });
    }
    const reportDate = req.body.reportDate || undefined;
    if (reportDate && (!isValidDate(reportDate) || reportDate > new Date().toLocaleDateString("en-CA"))) {
      return res.status(400).json({ success: false, message: "Please pick a valid report date" });
    }

    const mine = { ownerRole: role, owner: req.userId };
    const account = role === "doctor" ? await Doctor.findById(req.userId).select("isDemo") : await User.findById(req.userId).select("isDemo");
    const [total, ownUploads] = await Promise.all([Document.countDocuments(mine), Document.countDocuments({ ...mine, locked: false })]);
    if (total >= LIMITS[role]) {
      return res.status(400).json({ success: false, message: `You can keep up to ${LIMITS[role]} files, delete one to add another` });
    }
    if (isDemoMode() && account?.isDemo && ownUploads >= DEMO_UPLOAD_LIMIT) {
      return res.status(400).json({ success: false, message: `Demo accounts can keep ${DEMO_UPLOAD_LIMIT} uploads, delete one to try again` });
    }

    const title = cleanText(req.body.title).slice(0, 80) || CATEGORY_TITLES[category];
    const fileName = safeFileName(req.file.originalname, type.ext);
    const fileId = await saveFile(req.file.buffer, { filename: fileName, mime: type.mime });
    try {
      const document = await Document.create({
        ...mine,
        category,
        title,
        reportDate,
        file: fileId,
        fileName,
        mimeType: type.mime,
        size: req.file.size,
      });
      res.status(201).json({ success: true, message: "Uploaded", data: await Document.findById(document._id).select(PUBLIC_FIELDS) });
    } catch (error) {
      await deleteFile(fileId);
      throw error;
    }
  } catch (error) {
    logger.error("Upload error:", error.message);
    res.status(500).json({ success: false, message: "Could not upload the file" });
  }
};

// GET /documents/mine
export const getMyDocuments = async (req, res) => {
  try {
    const documents = await Document.find({ ownerRole: ownerRole(req), owner: req.userId })
      .select(PUBLIC_FIELDS)
      .sort({ reportDate: -1, createdAt: -1 });
    res.status(200).json({ success: true, message: "Documents", data: documents });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load documents" });
  }
};

// GET /documents/:id/file  stream the file to someone allowed to see it
export const downloadDocument = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: "File not found" });
  }
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ success: false, message: "File not found" });
    }
    const isOwner = document.ownerRole === ownerRole(req) && String(document.owner) === req.userId && req.role !== "admin";
    const allowed =
      isOwner ||
      // a patient's report: their doctors
      (document.ownerRole === "patient" && req.role === "doctor" && (await doctorTreats(req.userId, document.owner))) ||
      // a doctor's verification document: admins
      (document.ownerRole === "doctor" && req.role === "admin");
    if (!allowed) {
      return res.status(403).json({ success: false, message: "You don't have access to this file" });
    }

    res.set({
      "Content-Type": document.mimeType,
      "Content-Length": document.size,
      "Content-Disposition": `inline; filename="${document.fileName || "document"}"`,
      // medical files must not be stored by shared caches or proxies
      "Cache-Control": "private, no-store",
    });
    await streamFile(document.file, res);
  } catch (error) {
    logger.error("Download error:", error.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Could not open the file" });
  }
};

// DELETE /documents/:id  (owner only)
export const deleteDocument = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: "File not found" });
  }
  try {
    const document = await Document.findOne({ _id: req.params.id, ownerRole: ownerRole(req), owner: req.userId });
    if (!document) {
      return res.status(404).json({ success: false, message: "File not found" });
    }
    if (isDemoMode() && document.locked) {
      return res.status(403).json({ success: false, message: "Sample files stay in the demo, try deleting one you uploaded" });
    }
    await Document.deleteOne({ _id: document._id });
    await deleteFile(document.file);
    res.status(200).json({ success: true, message: "File deleted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not delete the file" });
  }
};

// documents of other accounts, used by the patient record (doctors) and the verification queue (admins)
export const documentsOf = (ownerRoleName, ownerIds) =>
  Document.find({ ownerRole: ownerRoleName, owner: { $in: ownerIds } })
    .select(`${PUBLIC_FIELDS} owner`)
    .sort({ reportDate: -1, createdAt: -1 });
