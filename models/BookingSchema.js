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
    ticketPrice: { type: Number, required: true },
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
