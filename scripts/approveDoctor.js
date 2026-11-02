// Approve or reject doctors until the admin panel exists.
//   npm run approve-doctor                     -> list doctors waiting for approval
//   npm run approve-doctor <email>             -> approve the doctor
//   npm run approve-doctor <email> reject      -> reject the doctor
import dotenv from "dotenv";
import mongoose from "mongoose";
import Doctor from "../models/DoctorSchema.js";

dotenv.config();

const [email, action] = process.argv.slice(2);

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 15000 });

  if (!email) {
    const pending = await Doctor.find({ isApproved: "pending" }).select("name email registrationNumber specialization");
    if (pending.length === 0) {
      console.log("No doctors are waiting for approval.");
      return;
    }
    console.log("Doctors waiting for approval:");
    pending.forEach(doctor =>
      console.log(`  ${doctor.email}  |  ${doctor.name}  |  reg no: ${doctor.registrationNumber || "-"}  |  ${doctor.specialization || "no specialization yet"}`)
    );
    return;
  }

  const status = action === "reject" ? "rejected" : "approved";
  const doctor = await Doctor.findOneAndUpdate({ email }, { $set: { isApproved: status } }, { new: true });
  if (!doctor) {
    console.log(`No doctor found with email ${email}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${doctor.name} (${doctor.email}) is now ${status === "approved" ? "approved and listed" : "rejected"}.`);
};

run()
  .catch(error => {
    console.error("Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
