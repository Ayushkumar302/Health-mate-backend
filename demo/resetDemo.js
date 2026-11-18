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
import { cancelProOf } from "../Controllers/planController.js";
import { cancelPlusOf } from "../Controllers/plusController.js";
import Notification from "../models/NotificationSchema.js";
import Waitlist from "../models/WaitlistSchema.js";
import { deleteTestPayoutAccount } from "./demoPayouts.js";
import { clearFeaturedCache } from "../utils/featured.js";

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
  // replies demo doctors wrote to other reviews
  await Review.updateMany({ doctor: { $in: doctorIds } }, { $unset: { reply: 1 } });
  await Waitlist.deleteMany(involved);
  await SymptomCheck.deleteMany({ user: { $in: userIds } });

  const uploads = await Document.find({ owner: { $in: [...doctorIds, ...userIds] }, locked: false });
  for (const upload of uploads) await deleteFile(upload.file);
  await Document.deleteMany({ _id: { $in: uploads.map(upload => upload._id) } });

  // profile fields the seed doesn't set itself
  await User.updateMany(
    { isDemo: true },
    { $unset: { photo: 1, dateOfBirth: 1, heightCm: 1, weightKg: 1, allergies: 1, conditions: 1, medications: 1, emergencyContact: 1, family: 1, offers: 1 } }
  );
  await Doctor.updateMany({ isDemo: true }, { $unset: { photo: 1, quickCallFee: 1, timeOff: 1, clinic: 1, offers: 1, bufferMinutes: 1, reviewSummary: 1 } });

  // Pro plans visitors bought with the test card: the test subscription is stopped and the plan taken off
  // (the seed puts the demo's own Pro doctor back)
  const subscribers = await Doctor.find({ isDemo: true, "plan.name": { $exists: true } }).select("+plan.subscriptionId");
  for (const subscriber of subscribers) await cancelProOf(subscriber);
  clearFeaturedCache();
  // the same for Medora Plus memberships of the demo patients
  const members = await User.find({ isDemo: true, "plus.name": { $exists: true } }).select("+plus.subscriptionId");
  for (const member of members) await cancelPlusOf(member);

  // sample applicants start their onboarding again: test payout accounts a visitor connected are removed
  // (the seed puts back their profile, empty weekly hours and "pending" verification)
  const applicants = await Doctor.find({ email: /@applicant\.test$/, stripeAccountId: { $exists: true } }).select("+stripeAccountId");
  for (const applicant of applicants) await deleteTestPayoutAccount(applicant.stripeAccountId);
  await Doctor.updateMany({ email: /@applicant\.test$/ }, { $unset: { stripeAccountId: 1 }, $set: { payoutsEnabled: false } });

  // notification centres start empty again
  await Notification.deleteMany({
    $or: [{ role: "doctor", person: { $in: doctorIds } }, { role: "patient", person: { $in: userIds } }],
  });
};

// back to the freshly seeded demo
export const resetDemoData = async () => {
  await clearVisitorData();
  return seedDemoData();
};

// the demo resets itself every DEMO_RESET_HOURS (default 6), at fixed times of the day
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
