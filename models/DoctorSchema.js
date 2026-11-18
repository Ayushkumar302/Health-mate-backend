import mongoose from "mongoose";

const DoctorSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String },
  photo: { type: String },
  ticketPrice: { type: Number, min: 0 },
  // fee for a short "do I need a visit?" call; when empty it is worked out from ticketPrice
  quickCallFee: { type: Number, min: 0 },
  // where clinic visits happen
  clinicAddress: { type: String, trim: true, maxLength: 200 },
  role: {
    type: String,
  },
  gender: { type: String, enum: ["male", "female", "other"] },

  // Fields for doctors only
  // medical council registration number, checked before the doctor is approved
  registrationNumber: { type: String, trim: true },
  specialization: { type: String },
  qualifications: {
    type: Array,
  },

  experiences: {
    type: Array,
  },

  bio: { type: String, maxLength: 200 },
  about: { type: String },
  timeSlots: { type: Array },
  // length of one appointment in minutes, the weekly time slots are split into slots of this size
  slotDuration: { type: Number, enum: [15, 20, 30, 45, 60], default: 30 },
  // minutes kept free after each appointment (notes, a short break)
  bufferMinutes: { type: Number, enum: [0, 5, 10, 15], default: 0 },
  // leave days and holidays ("YYYY-MM-DD", both days included): no slots are offered on them
  timeOff: [
    {
      from: { type: String, required: true },
      to: { type: String, required: true },
      reason: { type: String, trim: true, maxLength: 100 },
    },
  ],
  reviews: [{ type: mongoose.Types.ObjectId, ref: "Review" }],
  averageRating: {
    type: Number,
    default: 0,
  },
  totalRating: {
    type: Number,
    default: 0,
  },
  isApproved: {
    type: String,
    // pending: waiting for an admin, approved: listed, rejected: application turned down,
    // suspended: was listed and has been taken down ("cancelled" is the old name for suspended)
    enum: ["pending", "approved", "rejected", "suspended", "cancelled"],
    // new doctors are hidden until an admin verifies them (admin panel or npm run approve-doctor)
    default: "pending",
  },
  // admin's decision on the application, shown to the admin team
  reviewNote: { type: String, maxLength: 300 },
  reviewedAt: { type: Date },
  // email verification (only the hash of the emailed token is stored)
  emailVerified: { type: Boolean },
  emailVerifyTokenHash: { type: String, select: false },
  emailVerifyExpires: { type: Date, select: false },
  // Medora Pro subscription (see utils/plans.js); no plan or an expired one means the free plan
  plan: {
    name: { type: String, enum: ["starter", "pro", "clinic"] }, // Pro Starter, Pro, Pro Clinic (utils/tiers.js)
    since: { type: Date },
    expiresAt: { type: Date }, // end of the paid month; renewals move it forward
    price: { type: Number }, // rupees a month this doctor pays
    autoRenew: { type: Boolean },
    // Stripe subscription behind it (none for a plan given by the demo data)
    subscriptionId: { type: String, select: false },
    // the renewal date the doctor was last reminded about (one reminder per renewal)
    remindedFor: { type: Date },
    // a cheaper plan chosen to start at the next renewal
    pendingTier: { type: String, enum: ["starter", "pro", "clinic"] },
  },
  // Pro Clinic: the clinic shown on the public profile
  clinic: {
    name: { type: String, trim: true, maxLength: 80 },
    logo: { type: String },
    photos: [{ type: String }],
  },
  // upgrade suggestions in the notification centre (utils/offers.js)
  offers: {
    optOut: { type: Boolean, default: false },
    lastSentAt: { type: Date },
    ignored: { type: Number, default: 0 },
  },
  // "What patients say": the AI's summary of the reviews (Pro and Pro Clinic), made again when reviews change
  reviewSummary: {
    summary: { type: String },
    praised: [{ type: String }],
    improve: [{ type: String }],
    count: { type: Number }, // how many reviews it was made from
    generatedAt: { type: Date },
  },
  // Pro: bookings are confirmed as soon as they are paid
  instantBooking: { type: Boolean, default: false },
  // how often the public profile was opened (Pro analytics)
  profileViews: { type: Number, default: 0 },
  // Stripe Connect account that receives the doctor's share of each payment
  stripeAccountId: { type: String, select: false },
  payoutsEnabled: { type: Boolean, default: false },
  // shared demo account, protected from admin changes while the demo is running
  isDemo: { type: Boolean, default: false },
  appointments: [{ type: mongoose.Types.ObjectId, ref: "Appointment" }],
}, { timestamps: true });

export default mongoose.model("Doctor", DoctorSchema);
