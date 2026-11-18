import mongoose from "mongoose";

// a family member on a Plus Family membership: their own small health record, booked for by the account holder
const familyMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxLength: 60 },
    relation: { type: String, enum: ["spouse", "child", "parent", "sibling", "other"], required: true },
    gender: { type: String, enum: ["male", "female", "other"] },
    dateOfBirth: { type: String }, // "YYYY-MM-DD"
    bloodType: { type: String },
    allergies: [{ type: String, trim: true, maxLength: 80 }],
    conditions: [{ type: String, trim: true, maxLength: 80 }],
    medications: [{ type: String, trim: true, maxLength: 80 }],
  },
  { timestamps: true }
);

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String },
  photo: { type: String },
  role: {
    type: String,
    enum: ["patient", "admin"],
    default: "patient",
  },
  gender: { type: String, enum: ["male", "female", "other"] },
  bloodType: { type: String },
  // health record, shared with the doctors this patient has booked
  dateOfBirth: { type: String }, // "YYYY-MM-DD"
  heightCm: { type: Number, min: 30, max: 250 },
  weightKg: { type: Number, min: 1, max: 400 },
  allergies: [{ type: String, trim: true, maxLength: 60 }],
  conditions: [{ type: String, trim: true, maxLength: 60 }],
  medications: [{ type: String, trim: true, maxLength: 80 }],
  emergencyContact: { type: String, trim: true, maxLength: 80 },
  // email verification (only the hash of the emailed token is stored)
  emailVerified: { type: Boolean },
  emailVerifyTokenHash: { type: String, select: false },
  emailVerifyExpires: { type: Date, select: false },
  // Medora Plus membership (see utils/plus.js); none or an expired one means a free account
  plus: {
    name: { type: String, enum: ["lite", "plus", "family"] }, // Plus Lite, Plus, Plus Family (utils/tiers.js)
    since: { type: Date },
    expiresAt: { type: Date }, // end of the paid year; renewals move it forward
    price: { type: Number }, // rupees a year this patient pays
    autoRenew: { type: Boolean },
    // Stripe subscription behind it
    subscriptionId: { type: String, select: false },
    // the renewal date the patient was last reminded about (one reminder per renewal)
    remindedFor: { type: Date },
    // a cheaper plan chosen to start at the next renewal
    pendingTier: { type: String, enum: ["lite", "plus", "family"] },
  },
  // Plus Family: up to 3 people the account holder books for (kept if the plan ends, but only bookable on it)
  family: [familyMemberSchema],
  // upgrade suggestions in the notification centre (utils/offers.js)
  offers: {
    optOut: { type: Boolean, default: false },
    lastSentAt: { type: Date },
    // suggestions in a row that were never opened; after 3 they pause
    ignored: { type: Number, default: 0 },
  },
  // shared demo account
  isDemo: { type: Boolean, default: false },
  appointments: [{ type: mongoose.Types.ObjectId, ref: "Appointment" }],
}, { timestamps: true });

export default mongoose.model("User", UserSchema);
