import mongoose from "mongoose";

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
  // shared demo account
  isDemo: { type: Boolean, default: false },
  appointments: [{ type: mongoose.Types.ObjectId, ref: "Appointment" }],
}, { timestamps: true });

export default mongoose.model("User", UserSchema);
