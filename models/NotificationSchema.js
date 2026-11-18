import mongoose from "mongoose";

// one entry in a person's notification centre (the bell in the header)
const notificationSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["patient", "doctor"], required: true },
    person: { type: mongoose.Types.ObjectId, required: true }, // a User (patient) or a Doctor
    // "booking", "plan", "plus"
    kind: { type: String, required: true },
    title: { type: String, required: true, maxLength: 120 },
    text: { type: String, maxLength: 400 },
    // page of the website to open from it
    link: { type: String, maxLength: 200 },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ role: 1, person: 1, createdAt: -1 });
// old notifications are removed by MongoDB after 60 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export default mongoose.model("Notification", notificationSchema);
