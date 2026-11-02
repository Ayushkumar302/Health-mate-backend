// Resets the demo: removes what visitors did with the demo accounts and recreates the demo data.
// The server also does this on its own every few hours (DEMO_RESET_HOURS). Run from the backend folder: npm run seed
import dotenv from "dotenv";
import mongoose from "mongoose";
import { resetDemoData } from "../demo/resetDemo.js";
import { PASSWORD } from "../demo/demoData.js";

dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });
  const summary = await resetDemoData();
  console.log(`Demo reset done (password for every demo account: ${PASSWORD})`);
  console.log(`  Admin: ${summary.admin}   Patient: ${summary.patient}   Doctor: ${summary.doctor}`);
  console.log(`  ${summary.doctors} listed doctors, ${summary.patients} patients, ${summary.applicants} pending applications`);
};

run()
  .catch(error => {
    console.error("Seeding failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
