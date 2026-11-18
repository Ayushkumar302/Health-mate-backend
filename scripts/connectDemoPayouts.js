// Gives the listed demo doctors Stripe Connect test payout accounts (only those that don't have one yet).
// Doesn't change any other data. Run from the backend folder: npm run connect-demo-payouts
import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDemoDoctors } from "../demo/demoPayouts.js";

dotenv.config();

try {
  await mongoose.connect(process.env.MONGODB_URL);
  const result = await connectDemoDoctors();
  console.log(result.skipped ? `Skipped: ${result.skipped}` : `Demo doctors with payouts ready: ${result.connected} new, ${result.pending} still pending`);
} catch (error) {
  console.error("Could not connect the demo doctors:", error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
