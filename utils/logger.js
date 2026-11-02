// The server prints nothing by default, so nothing about users, payments or the database ends up in
// logs. Set DEBUG_LOGS=true in .env while debugging to see errors (still without request data).
const enabled = () => process.env.DEBUG_LOGS === "true";

// only the error's name and message, never whole objects (they can contain secrets or user data)
const describe = value => (value instanceof Error ? `${value.name}: ${value.message}` : String(value));

const logger = {
  info: (...parts) => enabled() && console.log(...parts.map(describe)),
  error: (...parts) => enabled() && console.error(...parts.map(describe)),
};

export default logger;
