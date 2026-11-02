import mongoose from "mongoose";

// what each kind of account may upload
export const PATIENT_CATEGORIES = ["lab", "imaging", "prescription", "other"];
export const DOCTOR_CATEGORIES = ["registration", "degree", "id-proof"];

// metadata of an uploaded file; the bytes themselves are in GridFS (see utils/files.js)
const documentSchema = new mongoose.Schema(
  {
    ownerRole: { type: String, enum: ["patient", "doctor"], required: true },
    owner: { type: mongoose.Types.ObjectId, required: true },
    category: { type: String, enum: [...PATIENT_CATEGORIES, ...DOCTOR_CATEGORIES], required: true },
    title: { type: String, required: true, trim: true, maxLength: 80 },
    reportDate: { type: String }, // "YYYY-MM-DD", for medical reports
    file: { type: mongoose.Types.ObjectId, required: true },
    fileName: { type: String },
    mimeType: { type: String, enum: ["application/pdf", "image/png", "image/jpeg"], required: true },
    size: { type: Number, required: true },
    // sample files from the seed script, kept in the portfolio demo
    locked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

documentSchema.index({ ownerRole: 1, owner: 1, createdAt: -1 });

export default mongoose.model("Document", documentSchema);
