import mongoose from "mongoose";

// what each kind of account may upload
export const PATIENT_CATEGORIES = ["lab", "imaging", "prescription", "other"];
export const DOCTOR_CATEGORIES = ["registration", "degree", "id-proof"];

// metadata of an uploaded file; the bytes themselves are in GridFS (see utils/files.js)
const documentSchema = new mongoose.Schema(
  {
    ownerRole: { type: String, enum: ["patient", "doctor"], required: true },
    owner: { type: mongoose.Types.ObjectId, required: true },
    // a patient's report about one of their family members (Plus Family); none = the account holder's own
    member: { type: mongoose.Types.ObjectId },
    category: { type: String, enum: [...PATIENT_CATEGORIES, ...DOCTOR_CATEGORIES], required: true },
    title: { type: String, required: true, trim: true, maxLength: 80 },
    reportDate: { type: String }, // "YYYY-MM-DD", for medical reports
    file: { type: mongoose.Types.ObjectId, required: true },
    fileName: { type: String },
    mimeType: { type: String, enum: ["application/pdf", "image/png", "image/jpeg"], required: true },
    size: { type: Number, required: true },
    // sample files from the seed script, kept in the demo
    locked: { type: Boolean, default: false },
    // the AI's explanation for the patient, per language ({ en: {...}, hi: {...} }), and when it was first made
    // (the first explanation of a report counts toward the patient's monthly allowance)
    explanations: { type: mongoose.Schema.Types.Mixed, select: false },
    explainedAt: { type: Date },
  },
  { timestamps: true }
);

documentSchema.index({ ownerRole: 1, owner: 1, createdAt: -1 });

export default mongoose.model("Document", documentSchema);
