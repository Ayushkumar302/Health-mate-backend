import mongoose from "mongoose";

// Plus and Plus Family: a patient waiting for a free slot with a doctor on a fully booked day.
// When a slot opens up they get a notification and can book it (first come, first served).
const waitlistSchema = new mongoose.Schema(
  {
    doctor: { type: mongoose.Types.ObjectId, ref: "Doctor", required: true },
    user: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    // the kind of visit they want (only shifts that offer it count)
    consultationType: { type: String, enum: ["clinic", "video", "quick-call"] },
    // told that a slot opened (the entry then stays as "notified")
    notifiedAt: { type: Date },
  },
  { timestamps: true }
);

waitlistSchema.index({ doctor: 1, user: 1, date: 1 }, { unique: true });
waitlistSchema.index({ doctor: 1, date: 1, notifiedAt: 1 });

export default mongoose.model("Waitlist", waitlistSchema);
