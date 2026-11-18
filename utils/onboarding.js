// Doctor onboarding: a verified doctor appears in search (and can be booked) only once their profile is
// complete, their weekly hours are set and a payout account is connected. One list of rules, used for the
// doctor's checklist, the admin panel and every public query (search, profile, slots, checkout, AI suggestions).

const filled = value => typeof value === "string" ? value.trim().length > 0 : value != null;

// what a complete profile needs, with the label shown when it's missing
export const PROFILE_REQUIREMENTS = [
  ["specialization", "Specialty", doctor => filled(doctor.specialization)],
  ["ticketPrice", "Consultation fee", doctor => Number(doctor.ticketPrice) > 0],
  ["bio", "Short bio", doctor => filled(doctor.bio)],
  ["qualifications", "At least one qualification", doctor => Array.isArray(doctor.qualifications) && doctor.qualifications.length > 0],
  ["experiences", "At least one work experience", doctor => Array.isArray(doctor.experiences) && doctor.experiences.length > 0],
];

// the doctor's checklist, in the order they work through it
export const onboardingOf = doctor => {
  const missing = PROFILE_REQUIREMENTS.filter(([, , ok]) => !ok(doctor)).map(([, label]) => label);
  const steps = [
    { id: "profile", label: "Complete your profile", done: missing.length === 0, missing },
    { id: "hours", label: "Set your weekly hours", done: Array.isArray(doctor.timeSlots) && doctor.timeSlots.length > 0 },
    { id: "payouts", label: "Connect a payout account", done: Boolean(doctor.payoutsEnabled) },
    { id: "verified", label: "Verification by Medora", done: doctor.isApproved === "approved", status: doctor.isApproved },
  ];
  const ready = steps.slice(0, 3).every(step => step.done);
  return { steps, ready, listed: ready && doctor.isApproved === "approved", done: steps.filter(step => step.done).length };
};

// the same rules as a MongoDB filter: doctors the public can find and book
export const LISTED = {
  isApproved: "approved",
  payoutsEnabled: true,
  "timeSlots.0": { $exists: true },
  "qualifications.0": { $exists: true },
  "experiences.0": { $exists: true },
  // inside $and so a search on fee or specialty can't overwrite them
  $and: [{ specialization: { $nin: [null, ""] } }, { ticketPrice: { $gt: 0 } }, { bio: { $nin: [null, ""] } }],
};

// fields the checklist reads
export const ONBOARDING_FIELDS = "specialization ticketPrice bio qualifications experiences timeSlots payoutsEnabled isApproved";
