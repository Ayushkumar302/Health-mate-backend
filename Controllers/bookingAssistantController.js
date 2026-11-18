// "Book with AI" (patients): a message in plain words -> matching doctors with real free times and the price.
// The AI only reads the message (utils/ai/bookingRequest.js). Free times come from the same code as the booking
// panel, and paying goes through the normal checkout, so every rule there (slot holds, discounts, refunds) applies.
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import { LISTED } from "../utils/onboarding.js";
import { addDays, clinicToday, daysFromTo, getSlotsForDate, toMinutes } from "../utils/slots.js";
import { bookingWindowFor, confirmsInstantly } from "../utils/plans.js";
import { feeFor, minutesFor, typeLabel } from "../utils/consultation.js";
import { patientTier } from "../utils/plus.js";
import { findEmergency } from "../utils/symptoms/rules.js";
import { createDailyAllowance, takeAiQuota } from "../utils/ai/quota.js";
import { askWithAI, askWithRules, checkRequest, isEmptyRequest, mergeRequests } from "../utils/ai/bookingRequest.js";
import { cleanText, escapeRegex } from "../utils/text.js";
import logger from "../utils/logger.js";
import { pricingFor } from "./bookingController.js";
import { listedSpecialties } from "./doctorController.js";

export const BOOKING_CHAT_DAILY = Number(process.env.BOOKING_CHAT_DAILY) || 10;
const allowance = createDailyAllowance(BOOKING_CHAT_DAILY);

const MAX_DOCTORS = 3;
const MAX_TIMES = 4;
// how many days are searched when the asked-for day is full
const DAYS_TRIED = 3;
const PARTS = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440], any: [0, 1440] };

const NOTES = {
  busy: "The AI is busy right now, so I matched your words with simple rules.",
  limit: "Today's AI limit is reached, so I matched your words with simple rules.",
};

const capital = text => text.replace(/\b\w/g, char => char.toUpperCase());
const shortDay = date =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const clock = time => {
  const [hours, minutes] = time.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
};

// "Dermatologist · Tue, 18 Nov · evening · video consultation · under ₹600 · for Aarav"
const describe = (request, member) =>
  [
    request.doctorName ? `Dr ${capital(request.doctorName)}` : request.specialty && capital(request.specialty),
    request.date && shortDay(request.date),
    request.time ? `around ${clock(request.time)}` : request.partOfDay !== "any" && request.partOfDay,
    request.visitType !== "any" && typeLabel(request.visitType).toLowerCase(),
    request.maxPrice && `under ₹${request.maxPrice}`,
    member && `for ${member.name}`,
  ]
    .filter(Boolean)
    .join(" · ");

// ---- who the visit is for (Plus Family members can book for their family)
const RELATION_OF = {
  son: ["child", "male"], daughter: ["child", "female"], child: ["child"], kid: ["child"], baby: ["child"],
  wife: ["spouse", "female"], husband: ["spouse", "male"], spouse: ["spouse"],
  mother: ["parent", "female"], mom: ["parent", "female"], mum: ["parent", "female"], maa: ["parent", "female"],
  father: ["parent", "male"], dad: ["parent", "male"], papa: ["parent", "male"], parent: ["parent"],
  brother: ["sibling", "male"], sister: ["sibling", "female"],
};
const SELF = /^(me|myself|self|mine|i)$/i;

// { member } when exactly one family member fits, otherwise { member: null }
const findMember = (user, forWhom) => {
  const words = forWhom.toLowerCase().replace(/^(for\s+)?my\s+/, "").split(/\s+/).filter(Boolean);
  const family = user.family || [];
  const byName = family.filter(member => member.name.toLowerCase().split(/\s+/).some(part => words.includes(part)));
  if (byName.length === 1) return byName[0];
  const [relation, gender] = RELATION_OF[words[0]] || [];
  if (!relation) return null;
  const byRelation = family.filter(member => member.relation === relation);
  if (byRelation.length === 1) return byRelation[0];
  const byGender = byRelation.filter(member => member.gender === gender);
  return byGender.length === 1 ? byGender[0] : null;
};

const whoFor = (user, forWhom) => {
  if (!forWhom || SELF.test(forWhom)) return {};
  // their own name
  if (user.name && user.name.toLowerCase().split(/\s+/).includes(forWhom.toLowerCase())) return {};
  if (!(patientTier(user).familyMembers > 0)) {
    return { note: "Booking for a family member needs Medora Plus Family, so these times are for you." };
  }
  const member = findMember(user, forWhom);
  if (member) return { member };
  const names = (user.family || []).map(item => item.name);
  return {
    note: `I couldn't tell who "${forWhom}" is in your family list, so these times are for you.`,
    ...(names.length && { choices: names.map(name => `for ${name}`) }),
  };
};

// ---- free times
// exact: the asked-for time must be free (shown first, with the next free ones after it).
// Otherwise: the nearest free times to the asked-for time, or the first ones in the part of the day.
const pickTimes = (times, request, exact) => {
  if (exact) return times.includes(request.time) ? times.filter(time => time >= request.time).slice(0, MAX_TIMES) : [];
  if (!request.time) {
    const [from, to] = PARTS[request.partOfDay];
    return times.filter(time => toMinutes(time) >= from && toMinutes(time) < to).slice(0, MAX_TIMES);
  }
  const target = toMinutes(request.time);
  return [...times]
    .sort((a, b) => Math.abs(toMinutes(a) - target) - Math.abs(toMinutes(b) - target))
    .slice(0, MAX_TIMES)
    .sort();
};

// the first day (of the days tried) with free times that fit, for one doctor.
// `freeTimes` remembers each day's free times, so the second pass doesn't ask the database again.
const firstFreeDay = async (doctor, request, days, today, exact, freeTimes) => {
  const types = request.visitType === "any" ? ["video", "clinic"] : [request.visitType];
  for (const [index, date] of days.entries()) {
    if (daysFromTo(today, date) > bookingWindowFor(doctor)) break;
    for (const type of types) {
      const fee = feeFor(doctor, type);
      if (!fee || fee <= 0 || (request.maxPrice && fee > request.maxPrice)) continue;
      const key = `${doctor._id}|${date}|${type}`;
      if (!freeTimes.has(key)) {
        freeTimes.set(key, (await getSlotsForDate(doctor, date, type)).filter(slot => slot.available).map(slot => slot.time));
      }
      const times = pickTimes(freeTimes.get(key), request, exact);
      if (times.length) return { index, date, type, fee, times };
    }
  }
  return null;
};

const findOptions = async (request, user, member, today) => {
  const filter = { ...LISTED };
  if (request.doctorName) filter.name = { $regex: escapeRegex(request.doctorName), $options: "i" };
  else filter.specialization = { $regex: `^${escapeRegex(request.specialty)}$`, $options: "i" };
  const doctors = await Doctor.find(filter)
    .select("name specialization photo averageRating totalRating ticketPrice quickCallFee timeSlots slotDuration bufferMinutes timeOff plan instantBooking")
    .sort({ averageRating: -1, totalRating: -1, _id: 1 })
    .limit(8);
  const start = request.date || today;
  const days = Array.from({ length: DAYS_TRIED }, (_, index) => addDays(start, index));
  const freeTimes = new Map();
  const search = async (exact, searchDays) =>
    (await Promise.all(doctors.map(async doctor => ({ doctor, free: await firstFreeDay(doctor, request, searchDays, today, exact, freeTimes) }))))
      .filter(item => item.free)
      // the asked-for day first, then the best rated (the order of the query)
      .sort((a, b) => a.free.index - b.free.index)
      .slice(0, MAX_DOCTORS);

  // an exact time: only the doctors free at that time (on the asked-for day, or the next days when no day was said)
  let found = request.time ? await search(true, request.date ? [request.date] : days) : [];
  const exactMissed = Boolean(request.time) && found.length === 0;
  if (!found.length) found = await search(false, days);
  return {
    doctorsFound: doctors.length,
    exactMissed,
    movedDay: found.length > 0 && found.every(item => item.free.index > 0),
    options: found.map(({ doctor, free }) => ({
      doctor: {
        _id: doctor._id,
        name: doctor.name,
        specialization: doctor.specialization,
        photo: doctor.photo,
        averageRating: doctor.averageRating,
        totalRating: doctor.totalRating,
      },
      instant: confirmsInstantly(doctor),
      type: free.type,
      typeLabel: typeLabel(free.type),
      minutes: minutesFor(doctor, free.type),
      fee: free.fee,
      // what the patient pays (Plus Family discount), the same sum the checkout charges
      price: pricingFor(user, free.fee, member?._id).ticketPrice ?? free.fee,
      date: free.date,
      dayLabel: shortDay(free.date),
      times: free.times.map(time => ({ time, label: clock(time) })),
      // the asked-for time itself (highlighted in the chat)
      ...(request.time && free.times.includes(request.time) && { exactTime: request.time }),
    })),
  };
};

// POST /bookings/assistant  body: { message, current? }  (patient)
// current: the request so far (sent back by the browser), so "make it Friday" changes only the day
export const bookingAssistant = async (req, res) => {
  const message = cleanText(req.body?.message).replace(/\s+/g, " ").slice(0, 200);
  if (message.length < 2) {
    return res.status(400).json({ success: false, message: "Tell me what you need, e.g. \"skin doctor tomorrow evening, video\"" });
  }
  try {
    // emergencies get help straight away, without the AI and without using a message
    const emergency = findEmergency(message);
    if (emergency) {
      return res.status(200).json({ success: true, data: { kind: "emergency", emergency } });
    }
    const turn = allowance(`${req.userId}|${req.ip}`);
    if (!turn.ok) {
      return res.status(429).json({
        success: false,
        code: "chat-limit",
        message: `You've used today's ${BOOKING_CHAT_DAILY} messages to the booking assistant. You can still book from any doctor's page.`,
      });
    }

    const today = clinicToday();
    const specialties = await listedSpecialties();
    const current = req.body?.current && typeof req.body.current === "object" ? checkRequest(req.body.current, specialties, today) : null;
    const user = await User.findById(req.userId).select("name plus family");
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });

    let parsed;
    let source = "rules";
    let note;
    const quota = takeAiQuota(req);
    if (quota === "ok") {
      try {
        parsed = await askWithAI(message, current, specialties, today);
        source = "ai";
      } catch (error) {
        logger.error("Booking assistant AI error:", error.message);
        note = NOTES.busy;
      }
    } else if (quota === "limit") {
      note = NOTES.limit;
    }
    if (!parsed) parsed = askWithRules(message, specialties, today);
    const reply = data => res.status(200).json({ success: true, data: { source, left: turn.left, ...(note && { note }), ...data } });

    if (parsed.notBooking || (source === "rules" && isEmptyRequest(parsed.request) && !current)) {
      return reply({ kind: "help", text: "I can find a doctor and a free time for you. Tell me the kind of doctor (or what's wrong), the day, and clinic or video." });
    }
    const request = mergeRequests(current, parsed.request);
    const who = whoFor(user, request.forWhom);
    const member = who.member ? { _id: who.member._id, name: who.member.name } : null;
    const base = { request, understood: describe(request, member), member, ...(who.note && { whoNote: who.note }), ...(who.choices && { choices: who.choices }) };

    if (!request.specialty && !request.doctorName) {
      return reply({
        ...base,
        kind: "ask",
        text: "Which kind of doctor do you need? You can also just say what's wrong, like \"tooth pain\".",
        choices: specialties.slice(0, 8).map(capital),
      });
    }
    const { options, movedDay, exactMissed, doctorsFound } = await findOptions(request, user, member, today);
    if (!options.length) {
      return reply({
        ...base,
        kind: "none",
        text: doctorsFound
          ? `I couldn't find a free time that fits in the next ${DAYS_TRIED} days. Try another day, another time of day, or drop the price limit.`
          : request.doctorName
            ? `I couldn't find a doctor called "${capital(request.doctorName)}". Try the kind of doctor instead.`
            : "There are no doctors of that kind listed right now.",
      });
    }
    return reply({
      ...base,
      kind: "options",
      text: exactMissed
        ? `Nobody is free at exactly ${clock(request.time)}${request.date ? ` on ${shortDay(request.date)}` : ""}, so here are the nearest free times.`
        : movedDay && request.date
          ? `Nothing free on ${shortDay(request.date)} that fits, so here are the next free times.`
          : request.time
            ? `These doctors are free at ${clock(request.time)}. Pick a time to book it.`
            : "Here are the best matches. Pick a time to book it.",
      options,
    });
  } catch (error) {
    logger.error("Booking assistant error:", error.message);
    res.status(500).json({ success: false, message: "The booking assistant couldn't answer, please try again" });
  }
};
