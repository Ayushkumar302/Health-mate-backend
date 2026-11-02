import { cleanText } from "./text.js";
import { isValidDate } from "./slots.js";

// Whitelists for everything a user can edit: unknown fields are dropped, text is cleaned and capped,
// numbers and dates are range-checked. Each sanitizer returns { updates } or { error }.

const WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const GENDERS = ["male", "female", "other"];
const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const SLOT_DURATIONS = [15, 20, 30, 45, 60];

const text = (value, max) => cleanText(value).slice(0, max);
const isTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
const today = () => new Date().toLocaleDateString("en-CA");

// profile photos may only come from our own Cloudinary account (no tracking pixels or random sites),
// and with CLOUDINARY_PHOTO_FOLDER set, only from Medora's folder there (not other images in the account)
export const isAllowedPhoto = url => {
  if (url === "" || url === null || url === undefined) return true;
  // the illustrated demo portraits bundled with the website
  if (typeof url === "string" && /^\/doctors\/[a-z0-9-]+\.svg$/.test(url)) return true;
  const cloud = (process.env.CLOUDINARY_CLOUD_NAME || "").replace(/[^\w-]/g, "") || "[\\w-]+";
  const folder = (process.env.CLOUDINARY_PHOTO_FOLDER || "").replace(/[^\w/-]/g, "").replace(/^\/+|\/+$/g, "");
  const pattern = folder
    ? new RegExp(`^https://res\\.cloudinary\\.com/${cloud}/image/upload/(v\\d+/)?${folder}/[\\w-]+\\.(jpe?g|png)$`)
    : new RegExp(`^https://res\\.cloudinary\\.com/${cloud}/image/upload/`);
  return typeof url === "string" && url.length <= 300 && pattern.test(url);
};

const numberIn = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

const dateOrEmpty = value => (value === "" || value === undefined || value === null ? "" : isValidDate(value) ? value : null);

const cleanPeriods = (items, fields) => {
  if (!Array.isArray(items)) return { error: "Invalid list" };
  if (items.length > 10) return { error: "At most 10 entries" };
  const list = [];
  for (const item of items) {
    const startingDate = dateOrEmpty(item?.startingDate);
    const endingDate = dateOrEmpty(item?.endingDate);
    if (startingDate === null || endingDate === null) return { error: "Please use valid dates" };
    const entry = { startingDate, endingDate };
    for (const [field, max] of fields) entry[field] = text(item?.[field], max);
    list.push(entry);
  }
  return { list };
};

// shared by patients and doctors
const commonFields = (body, updates, current) => {
  if ("name" in body) {
    const name = text(body.name, 60);
    if (name.length < 2) return "Please enter your name";
    updates.name = name;
  }
  if ("phone" in body) {
    const phone = text(body.phone, 20);
    if (phone && !/^\+?[\d\s-]{7,15}$/.test(phone)) return "Please enter a valid phone number";
    updates.phone = phone;
  }
  if ("photo" in body) {
    // the photo already on the profile is fine as it is (forms send it back unchanged)
    if (body.photo !== current?.photo && !isAllowedPhoto(body.photo)) return "Profile photos must be uploaded through the site";
    updates.photo = body.photo || undefined;
  }
  if ("gender" in body && body.gender) {
    if (!GENDERS.includes(body.gender)) return "Please choose a gender";
    updates.gender = body.gender;
  }
  return null;
};

export const sanitizePatientUpdate = (body, current) => {
  const updates = {};
  const error = commonFields(body, updates, current);
  if (error) return { error };

  if ("bloodType" in body && body.bloodType) {
    if (!BLOOD_TYPES.includes(body.bloodType)) return { error: "Please choose a blood type" };
    updates.bloodType = body.bloodType;
  }
  if ("dateOfBirth" in body) {
    if (body.dateOfBirth && (!isValidDate(body.dateOfBirth) || body.dateOfBirth > today() || body.dateOfBirth < "1900-01-01")) {
      return { error: "Please enter a valid date of birth" };
    }
    updates.dateOfBirth = body.dateOfBirth || undefined;
  }
  for (const [field, min, max] of [["heightCm", 30, 250], ["weightKg", 1, 400]]) {
    if (field in body && body[field] !== "" && body[field] !== null && body[field] !== undefined) {
      const value = numberIn(body[field], min, max);
      if (value === null) return { error: field === "heightCm" ? "Height must be 30-250 cm" : "Weight must be 1-400 kg" };
      updates[field] = value;
    }
  }
  for (const field of ["allergies", "conditions", "medications"]) {
    if (field in body) {
      updates[field] = (Array.isArray(body[field]) ? body[field] : []).map(item => text(item, 80)).filter(Boolean).slice(0, 20);
    }
  }
  if ("emergencyContact" in body) updates.emergencyContact = text(body.emergencyContact, 80);
  return { updates };
};

export const sanitizeDoctorUpdate = (body, current) => {
  const updates = {};
  const error = commonFields(body, updates, current);
  if (error) return { error };

  if ("specialization" in body) updates.specialization = text(body.specialization, 40).toLowerCase();
  if ("bio" in body) updates.bio = text(body.bio, 200);
  if ("about" in body) updates.about = text(body.about, 1500);
  if ("clinicAddress" in body) updates.clinicAddress = text(body.clinicAddress, 200);
  if ("ticketPrice" in body) {
    const fee = numberIn(body.ticketPrice, 100, 20000);
    if (fee === null) return { error: "The consultation fee must be between ₹100 and ₹20,000" };
    updates.ticketPrice = Math.round(fee);
  }
  if ("quickCallFee" in body) {
    if (body.quickCallFee === "" || body.quickCallFee === null) updates.quickCallFee = null;
    else {
      const fee = numberIn(body.quickCallFee, 50, 20000);
      if (fee === null) return { error: "The quick call fee must be between ₹50 and ₹20,000" };
      updates.quickCallFee = Math.round(fee);
    }
  }
  if ("slotDuration" in body) {
    const minutes = Number(body.slotDuration);
    if (!SLOT_DURATIONS.includes(minutes)) return { error: "Choose a slot length of 15, 20, 30, 45 or 60 minutes" };
    updates.slotDuration = minutes;
  }
  if ("qualifications" in body) {
    const { list, error: listError } = cleanPeriods(body.qualifications, [["degree", 60], ["university", 80]]);
    if (listError) return { error: `Qualifications: ${listError}` };
    updates.qualifications = list;
  }
  if ("experiences" in body) {
    const { list, error: listError } = cleanPeriods(body.experiences, [["position", 60], ["hospital", 80]]);
    if (listError) return { error: `Experience: ${listError}` };
    updates.experiences = list;
  }
  if ("timeSlots" in body) {
    if (!Array.isArray(body.timeSlots) || body.timeSlots.length > 21) return { error: "At most 21 weekly time slots" };
    const slots = [];
    for (const slot of body.timeSlots) {
      const day = String(slot?.day || "").toLowerCase();
      if (!WEEK_DAYS.includes(day) || !isTime(slot?.startingTime) || !isTime(slot?.EndingTime) || slot.startingTime >= slot.EndingTime) {
        return { error: "Each time slot needs a day and a start time before the end time" };
      }
      slots.push({ day, startingTime: slot.startingTime, EndingTime: slot.EndingTime });
    }
    updates.timeSlots = slots;
  }
  return { updates };
};

// fields other visitors see on a shared demo account; they stay as seeded while the demo runs
export const DEMO_LOCKED_DOCTOR_FIELDS = ["name", "photo", "specialization", "bio", "about", "qualifications", "experiences", "clinicAddress"];
export const DEMO_LOCKED_PATIENT_FIELDS = ["name", "photo"];

// which locked fields this update would actually change (forms send everything back unchanged)
export const changedLockedFields = (current, updates, fields) => {
  const same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
  return fields.filter(field => {
    if (!(field in updates)) return false;
    const before = current[field];
    if (field === "qualifications" || field === "experiences") {
      const normalised = (Array.isArray(before) ? before : []).map(item =>
        Object.fromEntries(Object.keys(updates[field][0] || { startingDate: 1 }).map(key => [key, item?.[key] ?? ""]))
      );
      return !same(normalised, updates[field]);
    }
    return !same(before, updates[field]);
  });
};
