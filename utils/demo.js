// Medora runs as a demo: nobody can create accounts, and the shared demo accounts
// can't have their password changed or be deleted (so every visitor finds them working).
// Set ALLOW_SIGNUPS=true in .env to turn sign-ups and these account actions back on.
export const isDemoMode = () => process.env.ALLOW_SIGNUPS !== "true";

export const DEMO_MESSAGES = {
  signup: "Sign-ups are closed in this demo. Please use the demo accounts on the login page.",
  password: "Password changes are disabled in the demo so the shared accounts keep working.",
  deleteAccount: "Deleting accounts is disabled in the demo so the shared accounts keep working.",
  publicProfile: "Name, photo and public profile text of demo accounts are locked so every visitor sees the same demo. Everything else can be changed",
};
