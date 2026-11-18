import { geminiEnabled } from "./gemini.js";
import { createRateLimiter } from "../text.js";

// The free Gemini quota is shared by every AI feature: a cap for the whole site per day and one per
// person (account + network) per day. Past either, the features answer with their non-AI fallback.
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 200;
export const AI_PER_PERSON_DAILY = Number(process.env.AI_PER_PERSON_DAILY) || 20;
const personQuota = createRateLimiter({ count: AI_PER_PERSON_DAILY, windowMs: 24 * 60 * 60 * 1000 });
let siteUsage = { day: "", count: 0 };

const takeSiteQuota = () => {
  const day = new Date().toLocaleDateString("en-CA");
  if (siteUsage.day !== day) siteUsage = { day, count: 0 };
  if (siteUsage.count >= AI_DAILY_LIMIT) return false;
  siteUsage.count++;
  return true;
};

// "ok" (an AI request may be made, and is counted), "off" (no key) or "limit" (today's quota is used up).
// `perPerson` raises the person's own daily allowance (Medora Plus members); the site cap still applies.
export const takeAiQuota = (req, perPerson = AI_PER_PERSON_DAILY) => {
  if (!geminiEnabled()) return "off";
  return personQuota(`${req.userId}|${req.ip}`, perPerson) && takeSiteQuota() ? "ok" : "limit";
};

// The AI chats (booking for patients, reports for doctors) also have a small number of messages per person per
// day, so a visitor can't spend the free quota by chatting. Kept in memory and started again each day.
export const createDailyAllowance = limit => {
  let day = "";
  let used = new Map();
  // { ok, left }: ok is false once the person has used today's messages
  return key => {
    const today = new Date().toLocaleDateString("en-CA");
    if (today !== day) {
      day = today;
      used = new Map();
    }
    const count = used.get(key) || 0;
    if (count >= limit) return { ok: false, left: 0 };
    used.set(key, count + 1);
    return { ok: true, left: limit - count - 1 };
  };
};

export const QUOTA_NOTES = {
  busy: "The AI assistant is busy right now, so this answer comes from our quick guide.",
  limit: "Today's AI limit is reached, so this answer comes from our quick guide.",
};
