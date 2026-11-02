// The three ways a patient can book a doctor
export const CONSULTATION_TYPES = ["clinic", "video", "quick-call"];
export const ONLINE_TYPES = ["video", "quick-call"]; // these get a video room
export const QUICK_CALL_MINUTES = 10;

// a short call to check whether a visit is needed costs less, unless the doctor set their own fee
export const defaultQuickCallFee = ticketPrice => Math.max(100, Math.round((Number(ticketPrice) * 0.4) / 10) * 10);

export const feeFor = (doctor, type) =>
  type === "quick-call" ? Number(doctor.quickCallFee) || defaultQuickCallFee(doctor.ticketPrice) : Number(doctor.ticketPrice);

// minutes the appointment takes (the slot itself is the doctor's normal slot length)
export const minutesFor = (doctor, type) => (type === "quick-call" ? QUICK_CALL_MINUTES : doctor.slotDuration || 30);

export const typeLabel = type => ({ clinic: "Clinic visit", video: "Video consultation", "quick-call": "Quick call" })[type] || "Consultation";
