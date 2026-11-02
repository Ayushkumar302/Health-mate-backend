import crypto from "node:crypto";

// One-time tokens for email verification links.
// The link carries the random token; the database keeps only its SHA-256 hash,
// so someone who can read the database still can't use the links.
export const hashToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");

export const createToken = () => {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: hashToken(token) };
};

export const VERIFY_EMAIL_HOURS = 24;

// at least 8 characters with a letter and a number
export const passwordProblem = password => {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 72) return "Password can be at most 72 characters";
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "Password must contain a letter and a number";
  return null;
};
