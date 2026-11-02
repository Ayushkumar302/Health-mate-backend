import mongoose from "mongoose";
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import { isDemoMode } from "../utils/demo.js";
import { cleanText, escapeRegex } from "../utils/text.js";
import { documentsOf } from "./documentController.js";
import logger from "../utils/logger.js"

// everything here is behind authenticate + restrict(["admin"])

const DOCTOR_FIELDS = "name email phone photo gender specialization registrationNumber ticketPrice qualifications experiences bio isApproved reviewNote reviewedAt averageRating totalRating createdAt isDemo";

// "cancelled" is the old name for "suspended"
const STATUS_FILTERS = {
  pending: ["pending"],
  approved: ["approved"],
  rejected: ["rejected"],
  suspended: ["suspended", "cancelled"],
};

// what an admin may do with an application in each state
const ACTIONS = {
  approve: { from: ["pending", "rejected", "suspended", "cancelled"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  suspend: { from: ["approved"], to: "suspended" },
};

const monthKey = date => date.toISOString().slice(0, 7); // "2026-10"

// In the public portfolio demo the admin only sees demo data: the shared demo accounts and the sample
// applications. Real accounts in the same database (and their emails) stay hidden, and only the sample
// applications can be approved or rejected.
const SAMPLE_APPLICANT = /@applicant\.test$/;
const demoDoctorFilter = { $or: [{ isDemo: true }, { email: SAMPLE_APPLICANT }] };

const scope = async () => {
  if (!isDemoMode()) return { doctors: {}, patients: {}, bookings: {} };
  const [doctorIds, userIds] = await Promise.all([
    Doctor.find(demoDoctorFilter).distinct("_id"),
    User.find({ isDemo: true }).distinct("_id"),
  ]);
  return {
    doctors: demoDoctorFilter,
    patients: { isDemo: true },
    bookings: { doctor: { $in: doctorIds }, user: { $in: userIds } },
  };
};

// GET /admin/stats
export const getStats = async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5, 1);
    sixMonthsAgo.setUTCHours(0, 0, 0, 0);

    const visible = await scope();
    const [patients, doctorCounts, bookingTotals, monthly, bySpecialty, recentBookings] = await Promise.all([
      User.countDocuments({ role: "patient", ...visible.patients }),
      Doctor.aggregate([{ $match: visible.doctors }, { $group: { _id: "$isApproved", count: { $sum: 1 } } }]),
      Booking.aggregate([
        { $match: { isPaid: true, ...visible.bookings } },
        {
          $group: {
            _id: null,
            bookings: { $sum: 1 },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            revenue: { $sum: { $cond: [{ $ifNull: ["$refundId", false] }, 0, "$ticketPrice"] } },
            refunded: { $sum: { $cond: [{ $ifNull: ["$refundId", false] }, "$ticketPrice", 0] } },
          },
        },
      ]),
      // money kept per month (refunded bookings left out), by payment date
      Booking.aggregate([
        { $match: { isPaid: true, refundId: { $exists: false }, createdAt: { $gte: sixMonthsAgo }, ...visible.bookings } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, revenue: { $sum: "$ticketPrice" }, bookings: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { isPaid: true, ...visible.bookings } },
        { $lookup: { from: "doctors", localField: "doctor", foreignField: "_id", as: "doctor" } },
        { $unwind: "$doctor" },
        { $group: { _id: "$doctor.specialization", bookings: { $sum: 1 } } },
        { $sort: { bookings: -1 } },
        { $limit: 6 },
      ]),
      Booking.find({ isPaid: true, ...visible.bookings })
        .sort({ createdAt: -1 })
        .limit(6)
        .populate("user", "name photo")
        .populate("doctor", "name specialization photo"),
    ]);

    // fill in months with no bookings so the chart has all six bars
    const months = [];
    for (let i = 0; i < 6; i++) {
      const date = new Date(sixMonthsAgo);
      date.setUTCMonth(sixMonthsAgo.getUTCMonth() + i);
      const found = monthly.find(item => item._id === monthKey(date));
      months.push({ month: monthKey(date), revenue: found?.revenue || 0, bookings: found?.bookings || 0 });
    }

    const doctors = Object.fromEntries(doctorCounts.map(item => [item._id, item.count]));
    const totals = bookingTotals[0] || { bookings: 0, cancelled: 0, revenue: 0, refunded: 0 };

    res.status(200).json({
      success: true,
      message: "Admin stats",
      data: {
        patients,
        doctors: {
          approved: doctors.approved || 0,
          pending: doctors.pending || 0,
          rejected: doctors.rejected || 0,
          suspended: (doctors.suspended || 0) + (doctors.cancelled || 0),
        },
        bookings: totals.bookings,
        cancelled: totals.cancelled,
        revenue: totals.revenue,
        refunded: totals.refunded,
        months,
        bySpecialty: bySpecialty.map(item => ({ specialization: item._id || "other", bookings: item.bookings })),
        recentBookings: recentBookings.filter(booking => booking.user && booking.doctor),
      },
    });
  } catch (error) {
    logger.error("Admin stats error:", error.message);
    res.status(500).json({ success: false, message: "Could not load the stats" });
  }
};

// GET /admin/doctors?status=pending&query=
export const getDoctors = async (req, res) => {
  const { status = "pending", query } = req.query;
  if (!STATUS_FILTERS[status]) {
    return res.status(400).json({ success: false, message: "Unknown status" });
  }
  try {
    const visible = await scope();
    const filter = { $and: [{ isApproved: { $in: STATUS_FILTERS[status] } }, visible.doctors] };
    const search = cleanText(query);
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: pattern }, { email: pattern }, { specialization: pattern }, { registrationNumber: pattern }];
    }
    const doctors = await Doctor.find(filter).select(DOCTOR_FIELDS).sort({ createdAt: -1 });

    // how busy each doctor is, handy when deciding to suspend someone
    const bookingCounts = await Booking.aggregate([
      { $match: { doctor: { $in: doctors.map(doctor => doctor._id) }, isPaid: true } },
      { $group: { _id: "$doctor", count: { $sum: 1 } } },
    ]);
    const countOf = Object.fromEntries(bookingCounts.map(item => [String(item._id), item.count]));
    // uploaded registration certificates, degrees and IDs
    const documents = await documentsOf("doctor", doctors.map(doctor => doctor._id));

    res.status(200).json({
      success: true,
      message: "Doctors found",
      data: doctors.map(doctor => ({
        ...doctor.toObject(),
        bookings: countOf[String(doctor._id)] || 0,
        documents: documents.filter(document => String(document.owner) === String(doctor._id)),
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load doctors" });
  }
};

// PUT /admin/doctors/:id/status  body: { action: "approve" | "reject" | "suspend", note }
export const updateDoctorStatus = async (req, res) => {
  const { action } = req.body;
  const note = cleanText(req.body.note).slice(0, 300);
  const rule = ACTIONS[action];
  if (!rule) {
    return res.status(400).json({ success: false, message: "Action must be approve, reject or suspend" });
  }
  if (action !== "approve" && !note) {
    return res.status(400).json({ success: false, message: "Please give a reason, it is kept on record" });
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: "Doctor not found" });
  }
  try {
    const doctor = await Doctor.findById(req.params.id).select("isApproved isDemo email");
    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found" });
    }
    // the listed demo doctors have to stay bookable for the next visitor
    if (isDemoMode() && !SAMPLE_APPLICANT.test(doctor.email || "")) {
      return res.status(403).json({ success: false, message: "The demo doctors are protected in the portfolio demo. Try it on a pending application" });
    }
    if (!rule.from.includes(doctor.isApproved)) {
      return res.status(400).json({ success: false, message: `Can't ${action} a doctor who is ${doctor.isApproved}` });
    }

    // only change it if nobody else changed it in the meantime
    const updated = await Doctor.findOneAndUpdate(
      { _id: doctor._id, isApproved: doctor.isApproved },
      { $set: { isApproved: rule.to, reviewNote: note || undefined, reviewedAt: new Date() } },
      { new: true }
    ).select(DOCTOR_FIELDS);
    if (!updated) {
      return res.status(409).json({ success: false, message: "Someone else just updated this doctor, please refresh" });
    }

    const messages = { approve: "Doctor approved, their profile is now listed", reject: "Application rejected", suspend: "Doctor suspended and hidden from patients" };
    res.status(200).json({ success: true, message: messages[action], data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update the doctor" });
  }
};

// GET /admin/patients?query=
export const getPatients = async (req, res) => {
  try {
    const filter = { role: "patient", ...(await scope()).patients };
    const search = cleanText(req.query.query);
    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      filter.$or = [{ name: pattern }, { email: pattern }];
    }
    const patients = await User.find(filter).select("name email phone photo gender bloodType createdAt").sort({ createdAt: -1 }).limit(200);
    const stats = await Booking.aggregate([
      { $match: { user: { $in: patients.map(patient => patient._id) }, isPaid: true } },
      {
        $group: {
          _id: "$user",
          bookings: { $sum: 1 },
          spent: { $sum: { $cond: [{ $ifNull: ["$refundId", false] }, 0, "$ticketPrice"] } },
          lastBooking: { $max: "$createdAt" },
        },
      },
    ]);
    const statsOf = Object.fromEntries(stats.map(item => [String(item._id), item]));
    res.status(200).json({
      success: true,
      message: "Patients found",
      data: patients.map(patient => {
        const item = statsOf[String(patient._id)];
        return { ...patient.toObject(), bookings: item?.bookings || 0, spent: item?.spent || 0, lastBooking: item?.lastBooking };
      }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load patients" });
  }
};

// GET /admin/bookings?status=all|upcoming|cancelled|refunded
export const getBookings = async (req, res) => {
  const filters = {
    all: {},
    active: { status: { $ne: "cancelled" } },
    cancelled: { status: "cancelled" },
    refunded: { refundId: { $exists: true } },
  };
  const filter = filters[req.query.status || "all"];
  if (!filter) {
    return res.status(400).json({ success: false, message: "Unknown status" });
  }
  try {
    const bookings = await Booking.find({ isPaid: true, ...filter, ...(await scope()).bookings })
      .sort({ appointmentDate: -1, appointmentTime: -1 })
      .limit(200)
      .populate("user", "name email photo")
      .populate("doctor", "name specialization photo");
    res.status(200).json({
      success: true,
      message: "Bookings found",
      data: bookings.filter(booking => booking.user && booking.doctor),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load bookings" });
  }
};
