import rateLimit from "express-rate-limit";

const isProduction = () => process.env.NODE_ENV === "production";

// the site(s) allowed to call this API from a browser: CLIENT_SITE_URL (comma separated for several),
// plus localhost / home-network addresses while developing (to test video calls from a phone on the same Wi-Fi)
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

export const isAllowedOrigin = origin => {
  if (!origin) return true; // same-origin requests, curl, server-to-server
  const allowed = (process.env.CLIENT_SITE_URL || "").split(",").map(url => url.trim().replace(/\/$/, "")).filter(Boolean);
  return allowed.includes(origin) || (!isProduction() && DEV_ORIGIN.test(origin));
};

// shared by Express (cors) and Socket.io
export const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));

// MongoDB operators come in as keys starting with "$" (e.g. { "email": { "$gt": "" } } logs in as anyone).
// Strip such keys, and dotted keys, from everything the client sends.
const stripOperators = value => {
  if (Array.isArray(value)) return value.map(stripOperators);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") || key.includes(".")) delete value[key];
      else value[key] = stripOperators(value[key]);
    }
  }
  return value;
};

export const sanitizeInput = (req, res, next) => {
  stripOperators(req.body);
  stripOperators(req.query);
  stripOperators(req.params);
  next();
};

const limitReached = message => (req, res) => res.status(429).json({ success: false, message });

// overall cap per IP address, generous enough for normal browsing
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: limitReached("Too many requests, please slow down and try again in a few minutes"),
});

// password guessing: 8 wrong attempts per email + IP in 15 minutes, successful logins don't count
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: req => `${req.ip}|${String(req.body?.email || "").toLowerCase()}`,
  handler: limitReached("Too many failed login attempts. Please wait 15 minutes and try again"),
});

// the same account attacked from many networks: 20 wrong passwords an hour, whatever the IP
export const accountLoginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: req => `account|${String(req.body?.email || "").toLowerCase()}`,
  handler: limitReached("This account is temporarily locked after too many wrong passwords, try again in an hour"),
});

// starting checkouts: each one holds a slot, so a script must not be able to block a doctor's whole day
export const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: limitReached("Too many booking attempts, please try again later"),
});

// account creation from one IP address
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: limitReached("Too many sign-ups from this network, please try again later"),
});

// verification emails sent on request: 5 an hour per email + IP
export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: req => `${req.ip}|${String(req.body?.email || "").toLowerCase()}`,
  handler: limitReached("Too many emails requested, please try again in an hour"),
});

// guessing email-link tokens
export const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: limitReached("Too many attempts, please wait 15 minutes and ask for a new link"),
});

// AI features (symptom checker, prescription explainer, pre-visit summary): 5 a minute per account and
// network; the daily AI quota is in utils/ai/quota.js
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: req => `${req.ip}|${req.userId}`,
  handler: limitReached("Please wait a minute before checking again"),
});

// file uploads (medical reports, doctor documents)
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: limitReached("Upload limit reached, please try again in an hour"),
});
