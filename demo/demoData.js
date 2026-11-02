// The demo's data: demo accounts (patients, doctors, admin), sample applications, past visits,
// prescriptions, reviews, a conversation, sample files and booking requests. seedDemoData() creates it or
// puts it back the way it was; it is used by `npm run seed` and by the automatic demo reset.
import bcrypt from "bcryptjs";
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import Prescription from "../models/PrescriptionSchema.js";
import Conversation from "../models/ConversationSchema.js";
import Message from "../models/MessageSchema.js";
import Review from "../models/ReviewSchema.js";
import Document from "../models/DocumentSchema.js";
import { deleteFile, saveFile } from "../utils/files.js";
import { makeSamplePdf } from "./samplePdf.js";


// unique to this project, so browsers don't flag it as a breached password (they did with "Test@1234")
export const PASSWORD = "Medora#Demo26";

const patientData = {
  email: "patient@healthmate.test",
  name: "Test Patient",
  role: "patient",
  gender: "male",
  bloodType: "B+",
  phone: "9876543210",
  // health record the patient's doctors can see
  dateOfBirth: "1996-04-12",
  heightCm: 175,
  weightKg: 72,
  allergies: ["Penicillin"],
  conditions: ["Mild hypertension"],
  medications: ["Amlodipine 5 mg"],
  emergencyContact: "Sunita Kumar (mother), 9876500011",
};

const doctorData = {
  email: "doctor@healthmate.test",
  name: "Dr. Test Doctor",
  role: "doctor",
  gender: "female",
  phone: "9876543211",
  registrationNumber: "TEST-REG-0001",
  specialization: "cardiologist",
  ticketPrice: 500,
  slotDuration: 30,
  bio: "Cardiologist with 8 years of experience in heart care.",
  about: "I help patients prevent and manage heart disease with clear, practical treatment plans.",
  isApproved: "approved",
  qualifications: [
    { startingDate: "2010-07-01", endingDate: "2015-06-30", degree: "MBBS", university: "AIIMS Delhi" },
  ],
  experiences: [
    { startingDate: "2016-01-01", endingDate: "2024-12-31", position: "Senior Cardiologist", hospital: "City Heart Hospital" },
  ],
  timeSlots: [
    { day: "monday", startingTime: "10:00", EndingTime: "13:00" },
    { day: "tuesday", startingTime: "16:00", EndingTime: "19:00" },
    { day: "wednesday", startingTime: "14:00", EndingTime: "17:00" },
    { day: "friday", startingTime: "10:00", EndingTime: "13:00" },
    { day: "saturday", startingTime: "11:00", EndingTime: "14:00" },
  ],
};

// extra demo doctors (they can log in too, same password) so the listing has variety
const everyDay = (from, to) =>
  ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => ({ day, startingTime: from, EndingTime: to }));

const moreDoctors = [
  {
    email: "ananya.rao@healthmate.test",
    name: "Dr. Ananya Rao",
    gender: "female",
    registrationNumber: "DEMO-KMC-20411",
    specialization: "neurologist",
    ticketPrice: 900,
    slotDuration: 45,
    bio: "Neurologist focused on migraines, epilepsy and sleep disorders.",
    about: "I believe every headache has a story. I take time to understand your symptoms and build a plan you can follow.",
    qualifications: [
      { startingDate: "2008-08-01", endingDate: "2013-06-30", degree: "MBBS", university: "Bangalore Medical College" },
      { startingDate: "2014-07-01", endingDate: "2017-06-30", degree: "DM Neurology", university: "NIMHANS" },
    ],
    experiences: [{ startingDate: "2017-08-01", endingDate: "", position: "Consultant Neurologist", hospital: "Manipal Hospital, Bengaluru" }],
    timeSlots: everyDay("09:00", "12:00"),
  },
  {
    email: "vikram.mehta@healthmate.test",
    name: "Dr. Vikram Mehta",
    gender: "male",
    registrationNumber: "DEMO-DCI-77812",
    specialization: "dentist",
    ticketPrice: 400,
    slotDuration: 30,
    bio: "Painless dentistry, root canals and smile makeovers.",
    about: "Gentle care for nervous patients. I explain every step and the cost before we start.",
    qualifications: [{ startingDate: "2011-08-01", endingDate: "2016-06-30", degree: "BDS", university: "Government Dental College, Mumbai" }],
    experiences: [{ startingDate: "2016-09-01", endingDate: "", position: "Dental Surgeon", hospital: "SmileCare Clinic, Mumbai" }],
    timeSlots: everyDay("10:00", "14:00"),
  },
  {
    email: "sara.thomas@healthmate.test",
    name: "Dr. Sara Thomas",
    gender: "female",
    registrationNumber: "DEMO-TCMC-31902",
    specialization: "pediatrician",
    ticketPrice: 600,
    slotDuration: 30,
    bio: "Child specialist for newborns to teens, vaccinations and growth.",
    about: "Kids are not small adults. I make visits calm and friendly, and give parents clear advice for home care.",
    qualifications: [
      { startingDate: "2009-08-01", endingDate: "2014-06-30", degree: "MBBS", university: "Government Medical College, Kochi" },
      { startingDate: "2015-07-01", endingDate: "2018-06-30", degree: "MD Pediatrics", university: "AIIMS Delhi" },
    ],
    experiences: [{ startingDate: "2018-08-01", endingDate: "", position: "Pediatric Consultant", hospital: "Rainbow Children's Hospital, Kochi" }],
    timeSlots: everyDay("15:00", "19:00"),
  },
  {
    email: "arjun.iyer@healthmate.test",
    name: "Dr. Arjun Iyer",
    gender: "male",
    registrationNumber: "DEMO-TNMC-55120",
    specialization: "psychiatrist",
    ticketPrice: 1200,
    slotDuration: 60,
    bio: "Psychiatrist for anxiety, depression, stress and sleep problems.",
    about: "A private, judgement-free space. We work together on therapy and, only if needed, medication.",
    qualifications: [
      { startingDate: "2007-08-01", endingDate: "2012-06-30", degree: "MBBS", university: "Madras Medical College" },
      { startingDate: "2013-07-01", endingDate: "2016-06-30", degree: "MD Psychiatry", university: "CMC Vellore" },
    ],
    experiences: [{ startingDate: "2016-08-01", endingDate: "", position: "Consultant Psychiatrist", hospital: "MindWell Clinic, Chennai" }],
    timeSlots: everyDay("17:00", "21:00"),
  },
  {
    email: "neha.kapoor@healthmate.test",
    name: "Dr. Neha Kapoor",
    gender: "female",
    registrationNumber: "DEMO-DMC-90233",
    specialization: "dermatologist",
    ticketPrice: 700,
    slotDuration: 20,
    bio: "Skin, hair and nail care, acne and allergy treatment.",
    about: "Healthy skin starts with the right routine. I keep treatments simple, effective and budget friendly.",
    qualifications: [
      { startingDate: "2010-08-01", endingDate: "2015-06-30", degree: "MBBS", university: "Maulana Azad Medical College" },
      { startingDate: "2016-07-01", endingDate: "2019-06-30", degree: "MD Dermatology", university: "PGIMER Chandigarh" },
    ],
    experiences: [{ startingDate: "2019-08-01", endingDate: "", position: "Dermatologist", hospital: "SkinFirst Clinic, Delhi" }],
    timeSlots: everyDay("11:00", "15:00"),
  },
  {
    email: "rohan.desai@healthmate.test",
    name: "Dr. Rohan Desai",
    gender: "male",
    registrationNumber: "DEMO-MMC-61207",
    specialization: "orthopedist",
    ticketPrice: 800,
    slotDuration: 30,
    bio: "Knee, back and sports injuries, from first pain to full recovery.",
    about: "Most joint problems get better without surgery. I start with movement, physiotherapy and simple changes at work.",
    qualifications: [
      { startingDate: "2008-08-01", endingDate: "2013-06-30", degree: "MBBS", university: "Seth GS Medical College, Mumbai" },
      { startingDate: "2014-07-01", endingDate: "2017-06-30", degree: "MS Orthopaedics", university: "KEM Hospital, Mumbai" },
    ],
    experiences: [{ startingDate: "2017-08-01", endingDate: "", position: "Consultant Orthopedic Surgeon", hospital: "Kokilaben Hospital, Mumbai" }],
    timeSlots: everyDay("08:00", "11:00"),
  },
  {
    email: "kavya.menon@healthmate.test",
    name: "Dr. Kavya Menon",
    gender: "female",
    registrationNumber: "DEMO-KMC-44718",
    specialization: "ENT specialist",
    ticketPrice: 500,
    slotDuration: 20,
    bio: "Ear, nose and throat care: sinusitis, allergies, hearing problems.",
    about: "Blocked nose for weeks? Ear pain that keeps coming back? Let's find the cause instead of treating the symptoms again and again.",
    qualifications: [
      { startingDate: "2010-08-01", endingDate: "2015-06-30", degree: "MBBS", university: "Kasturba Medical College, Manipal" },
      { startingDate: "2016-07-01", endingDate: "2019-06-30", degree: "MS ENT", university: "JIPMER Puducherry" },
    ],
    experiences: [{ startingDate: "2019-08-01", endingDate: "", position: "ENT Consultant", hospital: "Apollo Hospital, Bengaluru" }],
    timeSlots: everyDay("16:00", "20:00"),
  },
  {
    email: "imran.shaikh@healthmate.test",
    name: "Dr. Imran Shaikh",
    gender: "male",
    registrationNumber: "DEMO-GMC-23590",
    specialization: "general physician",
    ticketPrice: 300,
    slotDuration: 15,
    bio: "Family doctor for fever, infections, diabetes and BP check-ups.",
    about: "Your first stop for any health worry. I keep things simple, explain the why, and refer you to a specialist only when needed.",
    qualifications: [{ startingDate: "2012-08-01", endingDate: "2017-06-30", degree: "MBBS", university: "BJ Medical College, Ahmedabad" }],
    experiences: [{ startingDate: "2018-01-01", endingDate: "", position: "General Physician", hospital: "CarePlus Clinic, Ahmedabad" }],
    timeSlots: everyDay("09:00", "13:00"),
  },
  // testing doctors: open all day, every day, in 15 minute slots, so a visitor can book a slot that starts
  // in a few minutes and try the whole flow (book, doctor accepts, video call) right away
  {
    email: "riya.sen@healthmate.test",
    name: "Dr. Riya Sen",
    gender: "female",
    registrationNumber: "DEMO-WBMC-70815",
    specialization: "general physician",
    ticketPrice: 199,
    quickCallFee: 99,
    slotDuration: 15,
    bio: "Demo doctor for testing: open around the clock in 15 minute slots.",
    about: "Book the next free slot, log in as me in another browser to accept it, and join the video call a few minutes later.",
    qualifications: [{ startingDate: "2011-08-01", endingDate: "2016-06-30", degree: "MBBS", university: "Calcutta Medical College" }],
    experiences: [{ startingDate: "2017-01-01", endingDate: "", position: "General Physician", hospital: "Medora Demo Clinic, Kolkata" }],
    timeSlots: everyDay("00:00", "23:59"),
  },
  {
    email: "kabir.anand@healthmate.test",
    name: "Dr. Kabir Anand",
    gender: "male",
    registrationNumber: "DEMO-PMC-81442",
    specialization: "endocrinologist",
    ticketPrice: 249,
    quickCallFee: 99,
    slotDuration: 15,
    bio: "Demo doctor for testing: diabetes and thyroid care, open around the clock.",
    about: "Book the next free slot, log in as me in another browser to accept it, and join the video call a few minutes later.",
    qualifications: [
      { startingDate: "2009-08-01", endingDate: "2014-06-30", degree: "MBBS", university: "Government Medical College, Chandigarh" },
      { startingDate: "2015-07-01", endingDate: "2018-06-30", degree: "DM Endocrinology", university: "PGIMER Chandigarh" },
    ],
    experiences: [{ startingDate: "2018-08-01", endingDate: "", position: "Endocrinologist", hospital: "Medora Demo Clinic, Chandigarh" }],
    timeSlots: everyDay("00:00", "23:59"),
  },
  {
    email: "zoya.khan@healthmate.test",
    name: "Dr. Zoya Khan",
    gender: "female",
    registrationNumber: "DEMO-UPMC-93306",
    specialization: "gynecologist",
    ticketPrice: 299,
    quickCallFee: 99,
    slotDuration: 15,
    bio: "Demo doctor for testing: women's health, open around the clock.",
    about: "Book the next free slot, log in as me in another browser to accept it, and join the video call a few minutes later.",
    qualifications: [
      { startingDate: "2010-08-01", endingDate: "2015-06-30", degree: "MBBS", university: "King George's Medical University, Lucknow" },
      { startingDate: "2016-07-01", endingDate: "2019-06-30", degree: "MS Obstetrics & Gynaecology", university: "AIIMS Delhi" },
    ],
    experiences: [{ startingDate: "2019-08-01", endingDate: "", position: "Consultant Gynecologist", hospital: "Medora Demo Clinic, Lucknow" }],
    timeSlots: everyDay("00:00", "23:59"),
  },
];

const adminData = { email: "admin@healthmate.test", name: "Medora Admin", role: "admin", phone: "9876543200" };

// more patients so the admin panel and the doctor's patient list have some history
const morePatients = [
  { email: "priya.sharma@healthmate.test", name: "Priya Sharma", gender: "female", bloodType: "O+", phone: "9811122233" },
  { email: "rahul.verma@healthmate.test", name: "Rahul Verma", gender: "male", bloodType: "A+", phone: "9822233344" },
];

// doctor applications waiting in the admin's verification queue (reset to pending by every seed)
const applicants = [
  {
    email: "karan.malhotra@applicant.test",
    name: "Dr. Karan Malhotra",
    gender: "male",
    phone: "9833344455",
    registrationNumber: "DMC/R/2019/48213",
    specialization: "orthopedist",
    ticketPrice: 800,
    bio: "Orthopedic surgeon for sports injuries, joint pain and fractures.",
    qualifications: [
      { startingDate: "2009-08-01", endingDate: "2014-06-30", degree: "MBBS", university: "Lady Hardinge Medical College" },
      { startingDate: "2015-07-01", endingDate: "2018-06-30", degree: "MS Orthopaedics", university: "KGMU Lucknow" },
    ],
    experiences: [{ startingDate: "2018-08-01", endingDate: "", position: "Orthopedic Surgeon", hospital: "Fortis Hospital, Noida" }],
  },
  {
    email: "meera.nair@applicant.test",
    name: "Dr. Meera Nair",
    gender: "female",
    phone: "9844455566",
    registrationNumber: "TCMC/2016/77031",
    specialization: "gynecologist",
    ticketPrice: 750,
    bio: "Gynecologist for women's health, pregnancy care and PCOS.",
    qualifications: [
      { startingDate: "2006-08-01", endingDate: "2011-06-30", degree: "MBBS", university: "Government Medical College, Thrissur" },
      { startingDate: "2012-07-01", endingDate: "2015-06-30", degree: "MS Obstetrics & Gynaecology", university: "JIPMER Puducherry" },
    ],
    experiences: [{ startingDate: "2015-08-01", endingDate: "", position: "Consultant Gynecologist", hospital: "Aster Medcity, Kochi" }],
  },
  {
    email: "sameer.khan@applicant.test",
    name: "Sameer Khan",
    gender: "male",
    phone: "9855566677",
    registrationNumber: "12345",
    specialization: "general physician",
    ticketPrice: 300,
    bio: "",
    qualifications: [],
    experiences: [],
  },
];

// "YYYY-MM-DD" n days from today in clinic time (negative = in the past)
// "/doctors/ananya-rao.svg" for ananya.rao@healthmate.test
const portraitFor = email => `/doctors/${email.split("@")[0].replace(/\./g, "-")}.svg`;

const clinicDate = days =>
  new Date(Date.now() + days * 86400000).toLocaleDateString("en-CA", { timeZone: process.env.CLINIC_TIMEZONE || "Asia/Kolkata" });
const daysAgo = days => new Date(Date.now() - days * 86400000);

export const seedDemoData = async () => {
  const password = await bcrypt.hash(PASSWORD, 10);

  const patient = await User.findOneAndUpdate(
    { email: patientData.email },
    { $set: { ...patientData, password, isDemo: true } },
    { new: true, upsert: true }
  );
  const doctor = await Doctor.findOneAndUpdate(
    { email: doctorData.email },
    { $set: { ...doctorData, password, isDemo: true } },
    { new: true, upsert: true }
  );
  const doctorsByEmail = { [doctor.email]: doctor };
  for (const extra of moreDoctors) {
    doctorsByEmail[extra.email] = await Doctor.findOneAndUpdate(
      { email: extra.email },
      { $set: { ...extra, role: "doctor", isApproved: "approved", isDemo: true, password } },
      { new: true, upsert: true }
    );
  }
  await User.findOneAndUpdate({ email: adminData.email }, { $set: { ...adminData, password, isDemo: true } }, { upsert: true });
  const patientsByEmail = { [patient.email]: patient };
  for (const extra of morePatients) {
    patientsByEmail[extra.email] = await User.findOneAndUpdate(
      { email: extra.email },
      { $set: { ...extra, role: "patient", isDemo: true, password } },
      { new: true, upsert: true }
    );
  }
  for (const applicant of applicants) {
    await Doctor.findOneAndUpdate(
      { email: applicant.email },
      {
        $set: { ...applicant, role: "doctor", isApproved: "pending", password, timeSlots: [] },
        $unset: { reviewNote: 1, reviewedAt: 1 },
      },
      { upsert: true }
    );
  }
  // clinic visits happen at the hospital the doctor works at; illustrated portraits from frontend/public/doctors
  for (const listed of Object.values(doctorsByEmail)) {
    const hospital = listed.experiences?.[0]?.hospital || "Medora Clinic";
    await Doctor.updateOne(
      { _id: listed._id },
      { $set: { clinicAddress: hospital.includes(",") ? hospital : `${hospital}, Bengaluru`, photo: portraitFor(listed.email) } }
    );
  }
  // two sample applicants have a photo, the third one is missing it (shows up in the admin checklist)
  for (const email of ["karan.malhotra@applicant.test", "meera.nair@applicant.test"]) {
    await Doctor.updateOne({ email }, { $set: { photo: portraitFor(email) } });
  }

  // demo accounts and sample applicants count as having verified their email
  await User.updateMany({ isDemo: true }, { $set: { emailVerified: true } });
  await Doctor.updateMany({ $or: [{ isDemo: true }, { email: /@applicant\.test$/ }] }, { $set: { emailVerified: true } });
  // "cancelled" was the old name for a suspended doctor
  await Doctor.updateMany({ isApproved: "cancelled" }, { $set: { isApproved: "suspended" } });

  // upcoming bookings with the demo doctor: two requests waiting for an answer and one confirmed clinic visit.
  // There is no "live right now" call: a video room only exists once a doctor accepts a video booking.
  await Booking.deleteMany({ session: { $in: ["seed-video-booking", "seed-demo-booking"] } });
  const nextWeekday = weekday => {
    const date = new Date();
    date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7 || 7));
    return date.toLocaleDateString("en-CA");
  };
  const upcoming = [
    { session: "seed-upcoming-1", patient: patient.email, date: nextWeekday(1), time: "10:00", type: "video", status: "pending" },
    { session: "seed-upcoming-2", patient: "rahul.verma@healthmate.test", date: nextWeekday(3), time: "14:30", type: "quick-call", status: "pending" },
    { session: "seed-upcoming-3", patient: "priya.sharma@healthmate.test", date: nextWeekday(2), time: "16:30", type: "clinic", status: "approved" },
  ];
  for (const visit of upcoming) {
    const quick = visit.type === "quick-call";
    try {
      await Booking.findOneAndUpdate(
        { session: visit.session },
        {
          $set: {
            doctor: doctor._id,
            user: patientsByEmail[visit.patient]._id,
            ticketPrice: quick ? 200 : doctor.ticketPrice,
            isPaid: true,
            paymentProvider: "stripe",
            paymentMethod: "card",
            consultationType: visit.type,
            status: visit.status,
            appointmentDate: visit.date,
            appointmentTime: visit.time,
            slotDuration: quick ? 10 : 30,
            extendedMinutes: 0,
            slotKey: `${doctor._id}_${visit.date}_${visit.time}`,
          },
          $unset: { refundId: 1, cancelledBy: 1, declineReason: 1, respondedAt: 1 },
        },
        { upsert: true }
      );
    } catch (error) {
      // someone really booked that slot while testing: keep their booking
      if (error.code !== 11000) throw error;
    }
  }

  // past visits across the demo doctors: completed consultations, revenue for the admin chart, a refund
  const history = [
    { key: 1, patient: patient.email, doctor: doctorData.email, days: -3, time: "10:00" },
    { key: 2, patient: patient.email, doctor: "ananya.rao@healthmate.test", days: -40, time: "09:00" },
    { key: 3, patient: patient.email, doctor: "neha.kapoor@healthmate.test", days: -75, time: "11:20", refunded: true },
    { key: 4, patient: "priya.sharma@healthmate.test", doctor: "vikram.mehta@healthmate.test", days: -20, time: "12:00" },
    { key: 5, patient: "priya.sharma@healthmate.test", doctor: "sara.thomas@healthmate.test", days: -100, time: "16:00" },
    { key: 6, patient: "priya.sharma@healthmate.test", doctor: doctorData.email, days: -130, time: "11:00" },
    { key: 7, patient: "rahul.verma@healthmate.test", doctor: "arjun.iyer@healthmate.test", days: -10, time: "18:00" },
    { key: 8, patient: "rahul.verma@healthmate.test", doctor: doctorData.email, days: -55, time: "14:30" },
    { key: 9, patient: "rahul.verma@healthmate.test", doctor: "neha.kapoor@healthmate.test", days: -150, time: "13:00", refunded: true },
    { key: 10, patient: "rahul.verma@healthmate.test", doctor: "ananya.rao@healthmate.test", days: -160, time: "10:30" },
  ];
  const historyBookings = {};
  for (const visit of history) {
    const visitDoctor = doctorsByEmail[visit.doctor];
    const paidAt = daysAgo(-visit.days + 2); // booked two days before the visit
    historyBookings[visit.key] = await Booking.findOneAndUpdate(
      { session: `seed-history-${visit.key}` },
      {
        $set: {
          doctor: visitDoctor._id,
          user: patientsByEmail[visit.patient]._id,
          ticketPrice: visitDoctor.ticketPrice,
          isPaid: true,
          paymentProvider: "stripe",
          paymentMethod: "card",
          appointmentDate: clinicDate(visit.days),
          appointmentTime: visit.time,
          consultationType: visit.key % 2 === 0 ? "clinic" : "video",
          slotDuration: visitDoctor.slotDuration || 30,
          status: visit.refunded ? "cancelled" : "approved",
          ...(visit.refunded && { refundId: `seed-refund-${visit.key}`, cancelledBy: "patient" }),
          createdAt: paidAt,
          updatedAt: paidAt,
        },
        $unset: { slotKey: 1, ...(!visit.refunded && { refundId: 1, cancelledBy: 1 }) },
      },
      { new: true, upsert: true, timestamps: false }
    );
  }

  // the demo patient's prescriptions from their completed visits
  const prescriptions = [
    {
      booking: historyBookings[1],
      diagnosis: "Stage 1 hypertension",
      symptoms: "Occasional morning headaches, BP readings around 142/92 at home for two weeks",
      medicines: [
        { name: "Amlodipine", dosage: "5 mg", frequency: "0-0-1 after dinner", duration: "30 days", instructions: "Take at the same time every day" },
        { name: "Pantoprazole", dosage: "40 mg", frequency: "1-0-0 before breakfast", duration: "14 days" },
      ],
      tests: ["Lipid profile (fasting)", "ECG", "Serum creatinine"],
      advice: "Keep salt under 5 g a day, walk briskly for 30 minutes daily and check your BP twice a week. Bring the readings and test reports to the follow-up.",
      followUpDate: clinicDate(25),
    },
    {
      booking: historyBookings[2],
      diagnosis: "Migraine without aura",
      symptoms: "One-sided throbbing headache 3-4 times a month with light sensitivity",
      medicines: [
        { name: "Naproxen", dosage: "250 mg", frequency: "SOS, at the start of a headache", duration: "As needed", instructions: "Not more than 2 tablets a day" },
        { name: "Propranolol", dosage: "20 mg", frequency: "1-0-1", duration: "8 weeks" },
      ],
      tests: [],
      advice: "Keep a headache diary, sleep at fixed times and avoid skipping meals. Limit screen time late at night.",
    },
  ];
  for (const { booking, ...rest } of prescriptions) {
    await Prescription.findOneAndUpdate(
      { booking: booking._id },
      { $set: { ...rest, doctor: booking.doctor, user: booking.user } },
      { upsert: true }
    );
  }

  // a short conversation between the demo patient and the demo doctor (the last reply is unread)
  const conversation = await Conversation.findOneAndUpdate(
    { user: patient._id, doctor: doctor._id },
    { $setOnInsert: { user: patient._id, doctor: doctor._id } },
    { new: true, upsert: true }
  );
  await Message.deleteMany({ conversation: conversation._id });
  const thread = [
    ["patient", 50, "Hi doctor, I started the Amlodipine two days ago. Is mild dizziness in the morning normal?"],
    ["doctor", 46, "Hi! A little dizziness can happen in the first week. Get up slowly from bed and drink enough water. If it lasts more than a week, tell me."],
    ["patient", 30, "Okay, thank you. Should the lipid profile be done fasting?"],
    ["doctor", 26, "Yes, 10-12 hours fasting, water is fine. Upload or bring the report to your follow-up."],
  ];
  let last;
  for (const [senderRole, hours, text] of thread) {
    const at = new Date(Date.now() - hours * 3600000);
    last = { text, senderRole, at };
    await Message.collection.insertOne({
      conversation: conversation._id,
      senderRole,
      text,
      createdAt: at,
      updatedAt: at,
      // everything is read except the doctor's last reply
      ...(hours > 26 && { readAt: new Date(at.getTime() + 60000) }),
    });
  }
  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { lastMessage: last, unreadForUser: 1, unreadForDoctor: 0, updatedAt: last.at } },
    { timestamps: false }
  );

  // reviews, so ratings and the rating filter have something to show
  const reviews = [
    [patient.email, "ananya.rao@healthmate.test", 5, "Dr. Rao listened to everything and explained my migraine triggers clearly. The headaches are much less frequent now."],
    ["priya.sharma@healthmate.test", "vikram.mehta@healthmate.test", 4, "Painless root canal, he explained every step. The clinic was running 10 minutes late."],
    ["priya.sharma@healthmate.test", "sara.thomas@healthmate.test", 5, "Wonderful with my daughter, calm and patient. Clear advice for home care."],
    ["priya.sharma@healthmate.test", doctorData.email, 5, "Very thorough heart check-up and a practical diet plan."],
    ["rahul.verma@healthmate.test", "arjun.iyer@healthmate.test", 5, "Felt heard from the first minute. The sleep plan is already helping."],
    ["rahul.verma@healthmate.test", doctorData.email, 4, "Good consultation, the video call was smooth. Would have liked a written diet chart."],
    ["rahul.verma@healthmate.test", "neha.kapoor@healthmate.test", 4, "Simple skincare routine that actually works. Affordable medicines."],
    ["rahul.verma@healthmate.test", "ananya.rao@healthmate.test", 4, "Knowledgeable and kind. Follow-up was easy to book."],
  ];
  for (const [patientEmail, doctorEmail, rating, reviewText] of reviews) {
    const reviewer = patientsByEmail[patientEmail];
    const reviewed = doctorsByEmail[doctorEmail];
    await Review.findOneAndUpdate({ doctor: reviewed._id, user: reviewer._id }, { $set: { rating, reviewText } }, { upsert: true });
  }
  // keep each doctor's review list and average in step with the reviews
  for (const listed of Object.values(doctorsByEmail)) {
    const theirs = await Review.find({ doctor: listed._id }).select("rating");
    const average = theirs.length ? theirs.reduce((sum, review) => sum + review.rating, 0) / theirs.length : 0;
    await Doctor.updateOne(
      { _id: listed._id },
      { $set: { reviews: theirs.map(review => review._id), totalRating: theirs.length, averageRating: Math.round(average * 10) / 10 } }
    );
  }

  // sample files: the patient's lab reports and the doctors' verification documents
  const oldSamples = await Document.find({ locked: true });
  for (const sample of oldSamples) await deleteFile(sample.file);
  await Document.deleteMany({ locked: true });
  const addSample = async (ownerRole, owner, category, title, lines, reportDate) => {
    const buffer = makeSamplePdf(title, lines);
    const fileName = `${title.replace(/[^\w ]+/g, "").trim()}.pdf`;
    const file = await saveFile(buffer, { filename: fileName, mime: "application/pdf" });
    await Document.create({ ownerRole, owner, category, title, reportDate, file, fileName, mimeType: "application/pdf", size: buffer.length, locked: true });
  };
  const sampleNote = "SAMPLE DOCUMENT - generated for the Medora demo, not a real record.";
  await addSample("patient", patient._id, "lab", "Complete blood count", [
    `Patient: ${patientData.name}    Sample collected: ${clinicDate(-5)}`,
    "",
    "Haemoglobin            14.2 g/dL        (13.0 - 17.0)",
    "Total WBC count        7,800 /uL        (4,000 - 11,000)",
    "Platelet count         2.6 lakh /uL     (1.5 - 4.1)",
    "RBC count              4.9 million/uL   (4.5 - 5.5)",
    "",
    "Impression: all values within the normal range.",
    "",
    sampleNote,
  ], clinicDate(-5));
  await addSample("patient", patient._id, "imaging", "ECG report", [
    `Patient: ${patientData.name}    Date: ${clinicDate(-3)}`,
    "",
    "Rhythm: normal sinus rhythm, heart rate 78 bpm",
    "PR 160 ms, QRS 90 ms, QTc 410 ms",
    "No ST-T changes.",
    "",
    "Impression: normal ECG.",
    "",
    sampleNote,
  ], clinicDate(-3));
  const certificate = (doctor, council) => [
    `This is to certify that ${doctor.name.replace(/^Dr\.\s*/, "Dr. ")}`,
    `is registered with the ${council}`,
    `under registration number ${doctor.registrationNumber}.`,
    "",
    sampleNote,
  ];
  await addSample("doctor", doctor._id, "registration", "Medical registration certificate", certificate(doctorData, "Delhi Medical Council"));
  const applicantDocs = {
    "karan.malhotra@applicant.test": [
      ["registration", "Medical registration certificate", "Delhi Medical Council"],
      ["degree", "MS Orthopaedics degree", null],
    ],
    "meera.nair@applicant.test": [["registration", "Medical registration certificate", "Travancore-Cochin Medical Council"]],
  };
  for (const [email, files] of Object.entries(applicantDocs)) {
    const applicant = applicants.find(item => item.email === email);
    const account = await Doctor.findOne({ email }).select("_id");
    for (const [category, title, council] of files) {
      const lines = council
        ? certificate(applicant, council)
        : [`Awarded to ${applicant.name}`, `${applicant.qualifications.at(-1).degree}, ${applicant.qualifications.at(-1).university}`, "", sampleNote];
      await addSample("doctor", account._id, category, title, lines);
    }
  }

  return {
    admin: adminData.email,
    patient: patientData.email,
    doctor: doctorData.email,
    doctors: moreDoctors.length + 1,
    patients: morePatients.length + 1,
    applicants: applicants.length,
  };
};
