// remove invisible control characters (keeps normal text, emoji and line breaks)
// ranges: C0 controls except newline, DEL + C1 controls, zero-width chars, line/paragraph separators + bidi overrides
const INVISIBLE_RANGES = [[0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e]];
const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join("")}]`,
  "g"
);

export const cleanText = text => (typeof text === "string" ? text.replace(INVISIBLE_CHARS, "").trim() : "");

// simple sliding-window rate limit kept in memory: key -> timestamps
export const createRateLimiter = ({ count, windowMs }) => {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }, 60 * 1000).unref();

  // returns true when the action is allowed (and records it)
  return key => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(time => time > now - windowMs);
    if (recent.length >= count) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
};

// escape user input before using it inside a RegExp search
export const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
