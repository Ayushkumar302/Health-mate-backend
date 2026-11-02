import { geminiEnabled } from "./gemini.js";
import { createRateLimiter } from "../text.js";

// The free Gemini quota is shared by every AI feature: a cap for the whole site per day and one per
// person (account + network) per day. Past either, the features answer with their non-AI fallback.
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 200;
const personQuota = createRateLimiter({ count: Number(process.env.AI_PER_PERSON_DAILY) || 20, windowMs: 24 * 60 * 60 * 1000 });
let siteUsage = { day: "", count: 0 };

const takeSiteQuota = () => {
  const day = new Date().toLocaleDateString("en-CA");
  if (siteUsage.day !== day) siteUsage = { day, count: 0 };
  if (siteUsage.count >= AI_DAILY_LIMIT) return false;
  siteUsage.count++;
  return true;
};

// "ok" (an AI request may be made, and is counted), "off" (no key) or "limit" (today's quota is used up)
export const takeAiQuota = req => {
  if (!geminiEnabled()) return "off";
  return personQuota(`${req.userId}|${req.ip}`) && takeSiteQuota() ? "ok" : "limit";
};

export const QUOTA_NOTES = {
  busy: "The AI assistant is busy right now, so this answer comes from our quick guide.",
  limit: "Today's AI limit is reached, so this answer comes from our quick guide.",
};
