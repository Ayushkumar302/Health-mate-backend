// links back to the website (emails, Stripe): the first CLIENT_SITE_URL when several are listed
export const siteUrl = path =>
  `${(process.env.CLIENT_SITE_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "")}${path}`;
