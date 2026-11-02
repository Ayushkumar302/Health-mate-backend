import mongoose from "mongoose";

// a symptom check the patient chose to save to their health record (nothing is saved otherwise);
// doctors the patient booked can read it before the visit
const symptomCheckSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    input: {
      symptoms: { type: String, maxLength: 500 },
      chips: [{ type: String }],
      ageGroup: { type: String },
      duration: { type: String },
      severity: { type: String },
    },
    // "ai" (Gemini), "rules" (the built-in guide) or "emergency" (caught by the emergency rules)
    source: { type: String, enum: ["ai", "rules", "emergency"], required: true },
    result: {
      urgency: { type: String, enum: ["emergency", "soon", "routine", "self_care"] },
      specialty: { type: String },
      specialtyLabel: { type: String },
      alsoConsider: [{ type: String }],
      visitType: { type: String },
      summary: { type: String },
      reasons: [{ type: String }],
      possibleCauses: [{ type: String }],
      selfCare: [{ type: String }],
      warningSigns: [{ type: String }],
      emergency: {
        kind: { type: String },
        message: { type: String },
        actions: [{ type: String }],
      },
    },
  },
  { timestamps: true }
);

symptomCheckSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("SymptomCheck", symptomCheckSchema);
