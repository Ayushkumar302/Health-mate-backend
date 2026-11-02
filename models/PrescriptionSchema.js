import mongoose from "mongoose";

const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxLength: 80 },
    dosage: { type: String, trim: true, maxLength: 40 },       // "500 mg"
    frequency: { type: String, trim: true, maxLength: 40 },    // "1-0-1 after food"
    duration: { type: String, trim: true, maxLength: 40 },     // "5 days"
    instructions: { type: String, trim: true, maxLength: 120 },
  },
  { _id: false }
);

// one prescription per consultation, written (and later edited) by the doctor of that booking
const prescriptionSchema = new mongoose.Schema(
  {
    booking: { type: mongoose.Types.ObjectId, ref: "Booking", required: true, unique: true },
    doctor: { type: mongoose.Types.ObjectId, ref: "Doctor", required: true },
    user: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    diagnosis: { type: String, required: true, trim: true, maxLength: 200 },
    symptoms: { type: String, trim: true, maxLength: 500 },
    medicines: { type: [medicineSchema], default: [] },
    tests: [{ type: String, trim: true, maxLength: 80 }], // lab tests to get done
    advice: { type: String, trim: true, maxLength: 1000 },
    followUpDate: { type: String }, // "YYYY-MM-DD"
    // the patient's plain-words explanation from the AI, kept so it isn't asked again;
    // cleared whenever the doctor edits the prescription
    explanation: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

prescriptionSchema.index({ user: 1, createdAt: -1 });
prescriptionSchema.index({ doctor: 1, createdAt: -1 });

export default mongoose.model("Prescription", prescriptionSchema);
