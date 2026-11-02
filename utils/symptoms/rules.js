// Fixed rules for the symptom checker: they need no AI, always give the same answer and are easy to check.
//  - emergencies are caught here first, before anything is sent to Gemini
//  - when Gemini is off, busy or out of free quota, the guide below answers instead

const has = (text, pattern) => new RegExp(pattern, "i").test(text);

// signs that need a hospital now; each rule is a list of patterns that must all appear
const EMERGENCIES = [
  {
    match: [String.raw`chest (pain|pressure|tightness|heaviness)|pain in (my |the )?chest|heart attack`],
    message: "Chest pain can be a sign of a heart attack.",
  },
  {
    match: [String.raw`face (droop|drooping|is drooping)|slurred speech|can.?t speak|one side of (my |the )?(body|face)|sudden (weakness|numbness)|\bstroke\b`],
    message: "These can be signs of a stroke, where every minute counts.",
  },
  {
    match: [String.raw`can.?t breathe|cannot breathe|unable to breathe|struggling to breathe|gasping|choking|blue lips|lips (are |turning )?blue`],
    message: "Serious trouble breathing needs emergency care.",
  },
  {
    match: [String.raw`unconscious|not waking|won.?t wake|passed out|seizure|convulsion|having a fit|epileptic attack`],
    message: "Fainting that doesn't pass, or a seizure, needs emergency care.",
  },
  {
    match: [String.raw`(won.?t|not|doesn.?t) stop(ped)? bleeding|heavy bleeding|severe bleeding|vomiting blood|coughing (up )?blood|blood in (my )?vomit`],
    message: "Heavy bleeding needs emergency care.",
  },
  {
    match: [String.raw`(throat|tongue|lips?|face) (is |are )?(swelling|swollen)|swelling of (the )?(throat|tongue|lips?|face)`, String.raw`breath|allerg|sting|bite|peanut|swallow`],
    message: "Swelling with breathing trouble can be a severe allergic reaction.",
  },
  {
    match: [String.raw`poison|overdose|swallowed (a |some )?(pills|tablets|chemical|bleach|kerosene)`],
    message: "Poisoning or an overdose needs emergency care.",
  },
  {
    match: [String.raw`stiff neck`, String.raw`fever`],
    message: "Fever with a stiff neck can be a sign of a serious infection.",
  },
  {
    match: [String.raw`head (injury|hit|trauma)|hit (my |his |her )?head|fell on (my |his |her )?head`, String.raw`vomit|confus|drows|sleepy|unconscious|bleed`],
    message: "A head injury with these signs needs to be checked straight away.",
  },
];

// thoughts of self-harm get their own answer with helplines
const SELF_HARM = String.raw`suicid|kill (my|him|her)self|end (my|this) life|want to die|self.?harm|hurt myself|no reason to live`;

// returns an emergency answer, or null
export const findEmergency = text => {
  if (has(text, SELF_HARM)) {
    return {
      kind: "self-harm",
      message: "You don't have to go through this alone. Please talk to someone right now.",
      actions: [
        "Call Tele-MANAS on 14416 (free, 24/7, government mental health helpline)",
        "In danger right now: call 112",
        "Tell someone you trust and stay with them",
      ],
    };
  }
  const rule = EMERGENCIES.find(item => item.match.every(pattern => has(text, pattern)));
  if (!rule) return null;
  return {
    kind: "medical",
    message: rule.message,
    actions: ["Call 112 for an ambulance now", "Or go to the nearest hospital emergency department", "Don't drive yourself if you feel unwell"],
  };
};

// each topic adds points to the specialties that treat it; the highest score wins
const TOPICS = [
  {
    name: "skin",
    pattern: String.raw`rash|itch|acne|pimple|eczema|psoriasis|hair (fall|loss)|dandruff|\bmoles?\b|\bskin\b|hives|blister|fungal|ringworm|dark spots`,
    scores: { dermatologist: 3 },
    visit: "video",
    reason: "Skin, hair and nail problems are treated by a dermatologist",
  },
  {
    name: "teeth",
    pattern: String.raw`tooth|teeth|\bgums?\b|cavity|mouth ulcer|bad breath|braces|wisdom|jaw pain`,
    scores: { dentist: 3 },
    visit: "clinic",
    reason: "Teeth and gum problems need a dentist to look in person",
  },
  {
    name: "heart",
    pattern: String.raw`palpitation|heart ?beat|heart (is )?racing|blood pressure|\bbp\b|swollen (ankles|feet|legs)|cholesterol|breathless (when|on) walking`,
    scores: { cardiologist: 3, "general physician": 1 },
    visit: "clinic",
    reason: "Heartbeat and blood pressure problems are checked by a cardiologist",
  },
  {
    name: "nerves",
    pattern: String.raw`headache|migraine|dizz|numb|tingling|memory|tremor|shaking hands|vertigo|faint`,
    scores: { neurologist: 3, "general physician": 1 },
    visit: "video",
    reason: "Headaches, dizziness and numbness are looked at by a neurologist",
  },
  {
    name: "mind",
    pattern: String.raw`anxi|panic|depress|\bsad\b|stress|can.?t sleep|insomnia|\bmood\b|worry|overthink|lonely|no energy to do anything`,
    scores: { psychiatrist: 3 },
    visit: "video",
    reason: "Anxiety, low mood and sleep problems can be treated by a psychiatrist",
  },
  {
    name: "general",
    pattern: String.raw`fever|\bcold\b|cough|sore throat|\bflu\b|body ?ache|vomit|diarrh|loose motion|stomach|acidity|\bgas\b|weak|tired|fatigue|infection|nausea|chills`,
    scores: { "general physician": 3 },
    visit: "video",
    reason: "Fever, cough, stomach and other everyday illnesses are treated by a general physician",
  },
  {
    name: "ent",
    pattern: String.raw`\bears?\b|earache|hearing|\bnose\b|sinus|tonsil|snor|nosebleed|blocked nose|ringing`,
    scores: { "ent specialist": 3, "general physician": 1 },
    visit: "clinic",
    reason: "Ear, nose and throat problems are treated by an ENT specialist",
  },
  {
    name: "women",
    pattern: String.raw`period|menstrua|pregnan|pcos|pcod|vagin|pelvic|discharge|breast`,
    scores: { gynecologist: 3 },
    visit: "video",
    reason: "Periods, pregnancy and women's health are looked after by a gynecologist",
  },
  {
    name: "bones",
    pattern: String.raw`joint|knee|back ?pain|neck pain|shoulder|fracture|sprain|\bbones?\b|ankle|wrist|arthritis|injur|twisted`,
    scores: { orthopedist: 3 },
    visit: "clinic",
    reason: "Joint, bone and injury problems are treated by an orthopedist",
  },
  {
    name: "hormones",
    pattern: String.raw`thyroid|diabet|blood sugar|\bsugar\b|weight (gain|loss)|hormon|very thirsty|excessive thirst|urinating (a lot|often)|frequent urination`,
    scores: { endocrinologist: 3, "general physician": 1 },
    visit: "video",
    reason: "Thyroid, sugar and hormone problems are treated by an endocrinologist",
  },
];

const GENERAL = "general physician";

const WARNING_SIGNS = [
  "Trouble breathing or chest pain",
  "Fainting, confusion or a severe headache",
  "Symptoms getting quickly worse",
  "High fever that doesn't come down",
];

// a complete answer from the rules, in the same shape as Gemini's
export const ruleGuide = (input, specialties) => {
  const text = `${input.symptoms} ${input.chips.join(" ")}`;
  const available = new Set(specialties);
  const scores = new Map();
  const matched = TOPICS.filter(topic => has(text, topic.pattern));
  for (const topic of matched) {
    for (const [specialty, points] of Object.entries(topic.scores)) {
      if (available.has(specialty)) scores.set(specialty, (scores.get(specialty) || 0) + points);
    }
  }
  // children are best seen by a pediatrician first, whatever the problem
  if (input.ageGroup === "child" && available.has("pediatrician")) {
    scores.set("pediatrician", (scores.get("pediatrician") || 0) + 4);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([specialty]) => specialty);
  const fallback = available.has(GENERAL) ? GENERAL : specialties[0];
  const specialty = ranked[0] || fallback;
  const topic = matched.find(item => item.scores[specialty]);
  const unclear = !ranked.length;

  const reasons = unclear
    ? ["Your symptoms don't point clearly to one specialist", "A general physician can check you and refer you if needed"]
    : [
        specialty === "pediatrician" && input.ageGroup === "child"
          ? "Children are best checked by a pediatrician first"
          : topic?.reason,
        input.severity === "severe" ? "You rated it as severe, so don't wait long" : null,
      ].filter(Boolean);

  return {
    notSymptoms: false,
    urgency: input.severity === "severe" ? "soon" : "routine",
    specialty,
    alsoConsider: ranked.slice(1, 3),
    // unclear: a short call first to find out whether a visit is needed at all
    visitType: unclear ? "quick-call" : topic?.visit || "video",
    summary: unclear
      ? "We couldn't match your symptoms to one specialist. A short call with a general physician is a good first step."
      : `Based on what you described, a ${specialty} is the right doctor to start with.`,
    reasons,
    possibleCauses: [],
    selfCare: ["Rest and drink plenty of water", "Note when it started and what makes it better or worse"],
    warningSigns: WARNING_SIGNS,
  };
};
