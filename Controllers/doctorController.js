import Booking from "../models/BookingSchema.js";
import Doctor from "../models/DoctorSchema.js"; // Make sure DoctorSchema is correctly exported from DoctorSchema.js
import bcrypt from "bcryptjs";
import { DEMO_MESSAGES, isDemoMode } from "../utils/demo.js";
import { addDays, clinicToday, daysFromTo, getSlotsForDate, isValidDate, leaveOn } from "../utils/slots.js";
import { bookingsInTimeOff, cancelForTimeOff } from "./bookingController.js";
import mongoose from "mongoose";
import { cleanText } from "../utils/text.js";
import logger from "../utils/logger.js"
import { DEMO_LOCKED_DOCTOR_FIELDS, changedLockedFields, sanitizeDoctorUpdate } from "../utils/validate.js";
import { passwordProblem } from "../utils/tokens.js";
import { bookingWindowFor, confirmsInstantly, doctorTier, isPro, planBadgeOf, timeOffLimitFor } from "../utils/plans.js";
import { proVisibility } from "../utils/featured.js";
import { LISTED, onboardingOf } from "../utils/onboarding.js";
import { CONSULTATION_TYPES } from "../utils/consultation.js";
import { MIN_REVIEWS, refreshReviewSummary, reviewSummaryOf } from "../utils/ai/reviewSummary.js";
import { searchWithAI, searchWithRules } from "../utils/ai/doctorSearch.js";
import { takeAiQuota } from "../utils/ai/quota.js";

// specialties that have listed doctors (what plain-words search may pick), refreshed every 5 minutes
let specialtyCache = { at: 0, list: [] };
export const listedSpecialties = async () => {
    if (Date.now() - specialtyCache.at < 5 * 60 * 1000 && specialtyCache.list.length) return specialtyCache.list;
    const list = (await Doctor.distinct("specialization", LISTED)).map(name => String(name).toLowerCase()).filter(Boolean);
    specialtyCache = { at: Date.now(), list: [...new Set(list)].sort() };
    return specialtyCache.list;
};

// GET /doctors/search/ai?q=  turn a sentence ("skin doctor under 600 free today", Hindi too) into search filters
export const aiSearch = async (req, res) => {
    const text = cleanText(req.query.q).replace(/\s+/g, " ").slice(0, 200);
    if (text.length < 3) return res.status(400).json({ success: false, message: "Describe what you're looking for" });
    try {
        const specialties = await listedSpecialties();
        if (takeAiQuota(req) === "ok") {
            try {
                return res.status(200).json({ success: true, data: { ...(await searchWithAI(text, specialties)), source: "ai" } });
            } catch (error) {
                logger.error("AI search error:", error.message);
            }
        }
        res.status(200).json({ success: true, data: { ...searchWithRules(text, specialties), source: "rules" } });
    } catch (error) {
        res.status(500).json({ success: false, message: "Could not understand the search" });
    }
};

// fields hidden on the public doctor pages
// public pages show the profile, never contact details or admin notes
const PUBLIC_EXCLUDE = "-password -__v -registrationNumber -email -phone -reviewNote -reviewedAt -emailVerified -isDemo -appointments -role -createdAt -updatedAt -timeOff.reason -payoutsEnabled -profileViews";

// what patients see of a doctor's plan: the badges and booking rules it gives, never the subscription itself
const toPublic = (doctor, visibility, { showFeatured = false } = {}) => {
    const { plan, instantBooking, clinic, reviewSummary, offers, ...rest } = doctor.toObject();
    const id = String(doctor._id);
    return {
        ...rest,
        // "What patients say" (AI): only while the doctor is on Pro or Pro Clinic
        ...(reviewSummaryOf(doctor) && { reviewSummary }),
        isPro: isPro(doctor),
        // "Pro" or "Pro Clinic" (none for Free and Starter)
        planBadge: planBadgeOf(doctor),
        // the clinic's name, logo and photos: only while on Pro Clinic
        ...(doctorTier(doctor).clinicBranding && clinic?.name && { clinic }),
        featured: showFeatured && visibility.featured.has(id),
        availableToday: visibility.availableToday.has(id),
        instantBooking: confirmsInstantly(doctor),
        bookingWindowDays: bookingWindowFor(doctor),
    };
};

// escape regex special characters so search text is matched literally
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// empty values clear the field instead of storing ""/null
const toUpdate = updates => {
    const $set = {}
    const $unset = {}
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === null || value === "") $unset[key] = 1
        else $set[key] = value
    }
    return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }
}

export const updateDoctor = async (req, res) => {
    const id = req.params.id;
    if (id !== req.userId) {
        return res.status(403).json({ success: false, message: "You can only update your own profile" });
    }
    try {
        if (req.body.password && isDemoMode()) {
            return res.status(403).json({ success: false, message: DEMO_MESSAGES.password });
        }
        const current = await Doctor.findById(id);
        if (!current) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        // only known fields, cleaned and range-checked (role, email, approval status... can't be sent)
        const { updates, error } = sanitizeDoctorUpdate(req.body, current);
        if (error) {
            return res.status(400).json({ success: false, message: error });
        }
        // the shared demo doctors keep the public profile other visitors see
        if (isDemoMode() && current.isDemo) {
            const locked = changedLockedFields(current.toObject(), updates, DEMO_LOCKED_DOCTOR_FIELDS);
            if (locked.length) {
                return res.status(403).json({ success: false, message: `${DEMO_MESSAGES.publicProfile} (${locked.join(", ")})` });
            }
        }
        if (req.body.password) {
            const weak = passwordProblem(req.body.password);
            if (weak) return res.status(400).json({ success: false, message: weak });
            updates.password = await bcrypt.hash(req.body.password, 12);
        }
        const updatedDoctor = await Doctor.findByIdAndUpdate(id, toUpdate(updates), { new: true, runValidators: true }).select("-password -__v");
        res.status(200).json({ success: true, message: "Profile updated", data: updatedDoctor });
    } catch (error) {
        logger.error("Update doctor error:", error);
        res.status(500).json({ success: false, message: "Failed to update the profile" });
    }
};

export const deleteDoctor = async (req, res) => {
    const id = req.params.id;
    if (id !== req.userId) {
        return res.status(403).json({ success: false, message: "You can only delete your own profile" });
    }
    if (isDemoMode()) {
        return res.status(403).json({ success: false, message: DEMO_MESSAGES.deleteAccount });
    }
    try {
        const deletedDoctor = await Doctor.findByIdAndDelete(id);
        if (!deletedDoctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        res.status(200).json({ success: true, message: "Doctor deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete doctor" });
    }
};

export const getsingleDoctor = async (req, res) => {
    const id = req.params.id;
    try {
        // doctors that are not verified or haven't finished setting up are not public
        const doctor = await Doctor.findOne({ _id: id, ...LISTED }).populate('reviews').select(PUBLIC_EXCLUDE);
        if (!doctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        // counted for the doctor's own analytics (Pro)
        Doctor.updateOne({ _id: doctor._id }, { $inc: { profileViews: 1 } }, { timestamps: false }).catch(() => {});
        // reviews changed since the AI summary was made: a new one is made in the background
        if (doctorTier(doctor).aiTools && doctor.reviews.length >= MIN_REVIEWS && doctor.reviewSummary?.count !== doctor.reviews.length) {
            refreshReviewSummary(doctor._id);
        }
        res.status(200).json({ success: true, message: "Doctor found successfully", data: toPublic(doctor, await proVisibility()) });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving doctor" });
    }
};

// GET /doctors/:id/slots?date=YYYY-MM-DD&type=clinic|video|quick-call -> the doctor's slots on that day and
// whether each is free (with a type: only the shifts of the weekly routine that offer that kind of visit)
export const getAvailableSlots = async (req, res) => {
    const { date } = req.query;
    const type = CONSULTATION_TYPES.includes(req.query.type) ? req.query.type : undefined;
    if (!isValidDate(date)) {
        return res.status(400).json({ success: false, message: "Please provide a date as YYYY-MM-DD" });
    }
    try {
        const doctor = await Doctor.findOne({ _id: req.params.id, ...LISTED }).select("timeSlots slotDuration bufferMinutes timeOff plan");
        if (!doctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        const windowDays = bookingWindowFor(doctor);
        // beyond the doctor's booking window nothing is offered
        const slots = daysFromTo(clinicToday(), date) > windowDays ? [] : await getSlotsForDate(doctor, date, type);
        const leave = leaveOn(doctor, date);
        res.status(200).json({ success: true, message: "Slots found", data: slots, windowDays, ...(leave && { onLeave: { from: leave.from, to: leave.to } }) });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving slots" });
    }
};

// GET /doctors?query=&specialty=&minPrice=&maxPrice=&minRating=&sort=&page=&limit=
const SORTS = {
    recommended: { averageRating: -1, totalRating: -1, _id: 1 },
    rating: { averageRating: -1, totalRating: -1, _id: 1 },
    reviews: { totalRating: -1, averageRating: -1, _id: 1 },
    price_low: { ticketPrice: 1, _id: 1 },
    price_high: { ticketPrice: -1, _id: 1 },
};
const MAX_PAGE_SIZE = 24;

// a number from the query string, clamped to a range, or undefined when not given
const numberParam = (value, min, max) => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : undefined;
};

export const getAllDoctor = async (req, res) => {
    try {
        const query = cleanText(req.query.query);
        const specialty = cleanText(req.query.specialty);
        const minPrice = numberParam(req.query.minPrice, 0, 100000);
        const maxPrice = numberParam(req.query.maxPrice, 0, 100000);
        const minRating = numberParam(req.query.minRating, 0, 5);
        const page = Math.floor(numberParam(req.query.page, 1, 1000) || 1);
        const limit = Math.floor(numberParam(req.query.limit, 1, MAX_PAGE_SIZE) || 9);
        const sort = SORTS[req.query.sort] || SORTS.recommended;
        // paid placement only in the default order; when a patient sorts by price or rating, that order is kept
        const showFeatured = sort === SORTS.recommended;
        const visibility = await proVisibility();

        // verified doctors who finished onboarding (profile, weekly hours, payout account)
        const listed = LISTED;
        const filter = { ...listed };
        // "Available today": Pro doctors who still have a free slot today
        if (req.query.availableToday === "true") filter._id = { $in: [...visibility.availableToday] };
        if (query) {
            const safeQuery = escapeRegex(query);
            filter.$or = [
                { name: { $regex: safeQuery, $options: "i" } },
                { specialization: { $regex: safeQuery, $options: "i" } },
            ];
        }
        if (specialty) filter.specialization = { $regex: `^${escapeRegex(specialty)}$`, $options: "i" };
        if (minPrice !== undefined || maxPrice !== undefined) {
            filter.ticketPrice = { ...(minPrice !== undefined && { $gte: minPrice }), ...(maxPrice !== undefined && { $lte: maxPrice }) };
        }
        if (minRating) filter.averageRating = { $gte: minRating };

        // featured doctors that match the search come first, the rest follow in the usual order
        const skip = (page - 1) * limit;
        const featuredIds = showFeatured ? [...visibility.featured] : [];
        const first = featuredIds.length
            ? await Doctor.find({ $and: [filter, { _id: { $in: featuredIds } }] }).select(PUBLIC_EXCLUDE).sort(sort)
            : [];
        const fromFirst = first.slice(skip, skip + limit);
        const findDoctors = async () => {
            if (fromFirst.length === limit) return fromFirst;
            const rest = await Doctor.find({ $and: [filter, { _id: { $nin: featuredIds } }] })
                .select(PUBLIC_EXCLUDE)
                .sort(sort)
                .skip(Math.max(0, skip - first.length))
                .limit(limit - fromFirst.length);
            return [...fromFirst, ...rest];
        };

        const [doctors, total, specialties, priceRange] = await Promise.all([
            findDoctors(),
            Doctor.countDocuments(filter),
            // filter options shown on the page, from every listed doctor
            Doctor.aggregate([
                { $match: listed },
                { $group: { _id: { $toLower: "$specialization" }, label: { $first: "$specialization" }, count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } },
            ]),
            Doctor.aggregate([
                { $match: listed },
                { $group: { _id: null, min: { $min: "$ticketPrice" }, max: { $max: "$ticketPrice" } } },
            ]),
        ]);

        res.status(200).json({
            success: true,
            message: "Doctors found successfully",
            data: doctors.map(doctor => toPublic(doctor, visibility, { showFeatured })),
            pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
            availableToday: visibility.availableToday.size,
            facets: {
                specialties: specialties.map(item => ({ name: item._id, label: item.label, count: item.count })),
                price: { min: priceRange[0]?.min || 0, max: priceRange[0]?.max || 0 },
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving doctors" });
    }
};

export const getDoctorprofile = async (req, res) => {
    const doctorId = req.doctorId; // Get doctorId from authenticated request

    try {
        // Fetch doctor profile
        // reviews (with the patient's name and photo) are shown on the dashboard
        const doctor = await Doctor.findById(doctorId).select("-password -__v").populate("reviews");

        if (!doctor) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Fetch paid appointments for this doctor, with patient details for the appointments table
        const { password, ...rest } = doctor._doc;
        const appointments = await Booking.find({ doctor: doctorId, isPaid: true })
            .populate("user", "name email photo gender bloodType dateOfBirth allergies")
            .sort({ appointmentDate: -1, appointmentTime: -1, createdAt: -1 });

        res.status(200).json({
            success: true,
            message: "Getting doctor profile",
            // the setup checklist: what is still needed before patients can find this doctor;
            // aiTools: the plan includes the AI tools (prescription drafts, review summary)
            data: { ...rest, appointments, onboarding: onboardingOf(doctor), aiTools: doctorTier(doctor).aiTools },
        });
    } catch (error) {
        logger.error("Error fetching doctor profile:", error);
        res.status(500).json({ success: false, message: "Oops, something went wrong" });
    }
};

// ---- time off (leave days, holidays)


const MAX_TIME_OFF_DAYS = 60;
const TIME_OFF_AHEAD_DAYS = 365;
// the shared demo doctors stay bookable for visitors: leave must start 3+ days ahead, last at most a week, 2 at a time
const DEMO_TIME_OFF = { startsIn: 3, days: 7, count: 2 };

const readTimeOff = query => {
    const from = query.from;
    const to = query.to || query.from;
    const today = clinicToday();
    if (!isValidDate(from) || !isValidDate(to)) return { error: "Please pick valid dates" };
    if (from < today) return { error: "Time off can't start in the past" };
    if (to < from) return { error: "The last day must be on or after the first day" };
    if (daysFromTo(from, to) + 1 > MAX_TIME_OFF_DAYS) return { error: `Time off can be at most ${MAX_TIME_OFF_DAYS} days at once` };
    if (daysFromTo(today, from) > TIME_OFF_AHEAD_DAYS) return { error: "Time off can be planned up to a year ahead" };
    return { from, to };
};

// GET /doctors/time-off/impact?from=&to=  (doctor) how many booked patients those days would affect
export const getTimeOffImpact = async (req, res) => {
    const { from, to, error } = readTimeOff(req.query);
    if (error) return res.status(400).json({ success: false, message: error });
    try {
        const bookings = await bookingsInTimeOff(req.userId, from, to);
        res.status(200).json({ success: true, data: { count: bookings.length } });
    } catch (err) {
        res.status(500).json({ success: false, message: "Could not check your appointments" });
    }
};

// POST /doctors/time-off  body: { from, to, reason }  (doctor) block those days; bookings on them are refunded
export const addTimeOff = async (req, res) => {
    const { from, to, error } = readTimeOff(req.body || {});
    if (error) return res.status(400).json({ success: false, message: error });
    const reason = cleanText(req.body.reason).slice(0, 100);
    try {
        const doctor = await Doctor.findById(req.userId).select("timeOff isDemo plan");
        if (!doctor) return res.status(404).json({ success: false, message: "Doctor not found" });
        const today = clinicToday();
        // leave that is over is dropped
        const upcoming = (doctor.timeOff || []).filter(entry => entry.to >= today);
        if (upcoming.some(entry => entry.from <= to && from <= entry.to)) {
            return res.status(400).json({ success: false, message: "You already have time off on some of these days" });
        }
        const demoLimits = isDemoMode() && doctor.isDemo;
        if (demoLimits && (from < addDays(today, DEMO_TIME_OFF.startsIn) || daysFromTo(from, to) + 1 > DEMO_TIME_OFF.days || upcoming.length >= DEMO_TIME_OFF.count)) {
            return res.status(403).json({
                success: false,
                message: `Demo doctors can add up to ${DEMO_TIME_OFF.count} breaks of at most ${DEMO_TIME_OFF.days} days, starting ${DEMO_TIME_OFF.startsIn}+ days from today, so other visitors can still book them`,
            });
        }
        const maxEntries = timeOffLimitFor(doctor);
        if (upcoming.length >= maxEntries) {
            return res.status(400).json({
                success: false,
                message: isPro(doctor) ? `You can plan up to ${maxEntries} breaks at a time` : `The free plan allows ${maxEntries} planned breaks at a time. Every Pro plan removes this limit`,
            });
        }

        // block the days first, so nobody can book them while the existing bookings are being cancelled
        const timeOff = [...upcoming, { from, to, reason }].sort((a, b) => a.from.localeCompare(b.from));
        const updated = await Doctor.findByIdAndUpdate(req.userId, { $set: { timeOff } }, { new: true, runValidators: true }).select("timeOff");
        const cancelled = await cancelForTimeOff(req.userId, from, to);
        res.status(200).json({
            success: true,
            message: cancelled
                ? `Time off added. ${cancelled} appointment${cancelled === 1 ? " was" : "s were"} cancelled and refunded, the patients have been told`
                : "Time off added, those days are no longer bookable",
            data: { timeOff: updated.timeOff, cancelled },
        });
    } catch (err) {
        logger.error("Add time off error:", err.message);
        res.status(500).json({ success: false, message: "Could not add the time off" });
    }
};

// DELETE /doctors/time-off/:entryId  (doctor) the days become bookable again (cancelled bookings stay cancelled)
export const removeTimeOff = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.entryId)) {
        return res.status(404).json({ success: false, message: "Time off not found" });
    }
    try {
        const updated = await Doctor.findOneAndUpdate(
            { _id: req.userId, "timeOff._id": req.params.entryId },
            { $pull: { timeOff: { _id: req.params.entryId } } },
            { new: true }
        ).select("timeOff");
        if (!updated) return res.status(404).json({ success: false, message: "Time off not found" });
        res.status(200).json({ success: true, message: "Time off removed, those days are bookable again", data: { timeOff: updated.timeOff } });
    } catch (err) {
        res.status(500).json({ success: false, message: "Could not remove the time off" });
    }
};
