import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import Prescription from "../models/PrescriptionSchema.js";
import Conversation from "../models/ConversationSchema.js";
import Message from "../models/MessageSchema.js";
import Review from "../models/ReviewSchema.js";
import Document from "../models/DocumentSchema.js";
import SymptomCheck from "../models/SymptomCheckSchema.js";
import { deleteFile } from "../utils/files.js";
import { seedDemoData } from "./demoData.js";

// Everything visitors did with the shared demo accounts: their bookings, messages, prescriptions, reviews,
// saved symptom checks, uploads and profile changes. Data of other (real) accounts is never touched.
export const clearVisitorData = async () => {
  const [doctorIds, userIds] = await Promise.all([
    Doctor.find({ $or: [{ isDemo: true }, { email: /@applicant\.test$/ }] }).distinct("_id"),
    User.find({ isDemo: true }).distinct("_id"),
  ]);
  const involved = { $or: [{ doctor: { $in: doctorIds } }, { user: { $in: userIds } }] };

  // seeded bookings ("seed-..." sessions) are put back by the seed, the rest was made by visitors
  await Booking.deleteMany({ ...involved, session: { $not: /^seed-/ } });
  await Prescription.deleteMany(involved);
  const conversations = await Conversation.find(involved).distinct("_id");
  await Message.deleteMany({ conversation: { $in: conversations } });
  await Conversation.deleteMany({ _id: { $in: conversations } });
  await Review.deleteMany({ user: { $in: userIds } });
  await SymptomCheck.deleteMany({ user: { $in: userIds } });

  const uploads = await Document.find({ owner: { $in: [...doctorIds, ...userIds] }, locked: false });
  for (const upload of uploads) await deleteFile(upload.file);
  await Document.deleteMany({ _id: { $in: uploads.map(upload => upload._id) } });

  // profile fields the seed doesn't set itself
  await User.updateMany(
    { isDemo: true },
    { $unset: { photo: 1, dateOfBirth: 1, heightCm: 1, weightKg: 1, allergies: 1, conditions: 1, medications: 1, emergencyContact: 1 } }
  );
  await Doctor.updateMany({ isDemo: true }, { $unset: { photo: 1, quickCallFee: 1, timeOff: 1 } });
};

// back to the freshly seeded demo
export const resetDemoData = async () => {
  await clearVisitorData();
  return seedDemoData();
};

// the portfolio demo resets itself every DEMO_RESET_HOURS (default 6), at fixed times of the day
const resetHours = () => Math.min(24, Math.max(1, Number(process.env.DEMO_RESET_HOURS) || 6));

export const nextResetAt = (now = Date.now()) => {
  const period = resetHours() * 60 * 60 * 1000;
  return Math.floor(now / period) * period + period;
};

export const scheduleDemoReset = onError => {
  const run = () => {
    setTimeout(async () => {
      try {
        await resetDemoData();
      } catch (error) {
        onError?.(error);
      }
      run();
    }, Math.max(1000, nextResetAt() - Date.now()));
  };
  run();
};
