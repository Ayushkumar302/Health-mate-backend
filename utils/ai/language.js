// Languages the AI can answer patients in (the symptom checker, prescription and report explainers, the
// pre-visit questions). What doctors read stays in English. The non-AI fallbacks are English only.

export const LANGUAGES = {
  en: { name: "English", native: "English" },
  hi: { name: "Hindi", native: "हिन्दी" },
  bn: { name: "Bengali", native: "বাংলা" },
  mr: { name: "Marathi", native: "मराठी" },
  ta: { name: "Tamil", native: "தமிழ்" },
  te: { name: "Telugu", native: "తెలుగు" },
  gu: { name: "Gujarati", native: "ગુજરાતી" },
  kn: { name: "Kannada", native: "ಕನ್ನಡ" },
};

export const readLang = value => (typeof value === "string" && LANGUAGES[value] ? value : "en");

// added to the AI's instructions: what to write in, and what must stay as it is
export const languageRule = lang =>
  lang === "en"
    ? ""
    : `\n\nLanguage: write every text value meant for the patient in ${LANGUAGES[lang].name}, in its own script, instead of English.
Use simple everyday ${LANGUAGES[lang].name}, the way people speak at home. Keep medicine names, test names, numbers, units and doses
exactly as written (in English letters). Values that must come from a fixed list (enums) stay exactly as given.`;

// the fallback (rules) answer is in English: tell the patient why
export const englishOnlyNote = lang =>
  lang === "en" ? undefined : `This answer is in English: the AI that answers in ${LANGUAGES[lang].name} isn't available right now.`;
