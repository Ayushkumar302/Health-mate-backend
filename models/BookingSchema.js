import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    doctor: {
      type: mongoose.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    user: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // what the patient paid
    ticketPrice: { type: Number, required: true },
    // the doctor's fee before the Plus Family discount (only set when there was one); the doctor is paid on this
    listPrice: { type: Number },
    // rupees off for a Plus Family member, paid out of Medora's commission
    familyDiscount: { type: Number },
    // the visit is for a family member of the account holder (copied, so later edits don't change old visits)
    familyMember: {
      _id: { type: mongoose.Types.ObjectId },
      name: { type: String },
      relation: { type: String },
    },
    // appointment slot, in the clinic's timezone
    appointmentDate: { type: String }, // "YYYY-MM-DD"
    appointmentTime: { type: String }, // "HH:mm"
    // "clinic" (in person), "video" (full online consultation) or "quick-call" (short call to check if a visit is needed)
    consultationType: { type: String, enum: ["clinic", "video", "quick-call"] },
    slotDuration: { type: Number, default: 30 }, // minutes, copied from the doctor when booking
    extendedMinutes: { type: Number, default: 0 }, // extra time the doctor added during the video call
    // "<doctorId>_<date>_<time>", only set while the booking occupies the slot
    slotKey: { type: String },
    // who took the payment (Stripe Checkout)
    paymentProvider: { type: String, default: "stripe" },
    // Stripe checkout session id, used to verify the payment
    session: { type: String },
    // Stripe payment intent, used for refunds
    paymentIntent: { type: String },
    paymentMethod: { type: String }, // "card"
    refundId: { type: String },
    // rupees given back (a patient who cancels late gets part of it back)
    refundedAmount: { type: Number },
    // rupees of that refund the platform paid on top of the normal rules (Medora Plus), not taken from the doctor
    refundCovered: { type: Number },
    // the platform's share of the fee, saved when the booking is made (0.15 = 15%)
    commissionRate: { type: Number },
    // the doctor's Stripe Connect account the payment was split to (none: the platform holds the doctor's share)
    payoutAccount: { type: String },
    // video calls: when each side first joined, used to settle missed calls
    joinsTracked: { type: Boolean },
    joinedAt: {
      patient: { type: Date },
      doctor: { type: Date },
    },
    // who missed the appointment; set once it has been settled
    noShow: { type: String, enum: ["patient", "doctor"] },
    settledAt: { type: Date },
    rescheduleCount: { type: Number, default: 0 },
    // pre-visit intake: what the patient told the doctor before the visit, and the summary the doctor reads
    intake: {
      reason: { type: String, maxLength: 500 },
      since: { type: String },
      severity: { type: String },
      answers: [{ _id: false, question: { type: String, maxLength: 200 }, answer: { type: String, maxLength: 500 } }],
      lang: { type: String },
      summary: {
        complaint: { type: String },
        details: [{ type: String }],
        redFlags: [{ type: String }],
        askAbout: [{ type: String }],
        source: { type: String }, // "ai" or "rules"
      },
      submittedAt: { type: Date },
    },
    // reminders already sent: "24h" (patient, the day before) and "1h" (patient and doctor)
    remindersSent: [{ type: String }],
    // the patient was asked to review the doctor after this visit (once, and only after a visit that happened)
    reviewPromptedAt: { type: Date },
    // booked with a doctor who confirms instantly: no accept step
    instant: { type: Boolean },
    // the doctor cancelled or missed an appointment they had confirmed (counts toward their cancellation rate)
    doctorFault: { type: Boolean },
    // "system" = the doctor never answered the request, so it was cancelled and refunded automatically
    cancelledBy: { type: String, enum: ["patient", "doctor", "system"] },
    declineReason: { type: String, maxLength: 300 },
    respondedAt: { type: Date },

    // pending: paid and waiting for the doctor to accept, approved: confirmed by the doctor, cancelled
    status: {
      type: String,
      enum: ["pending", "approved", "cancelled"],
      default: "pending",
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// a slot can only be held by one booking at a time, this is what prevents double booking
bookingSchema.index(
  { slotKey: 1 },
  { unique: true, partialFilterExpression: { slotKey: { $exists: true } } }
);

export default mongoose.model("Booking", bookingSchema);
