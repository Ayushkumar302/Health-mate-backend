import mongoose from "mongoose";

// settings the admin can change from the panel (one document per group, e.g. key "money")
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Object, default: {} },
    updatedBy: { type: mongoose.Types.ObjectId },
  },
  { timestamps: true, minimize: false }
);

export default mongoose.model("Setting", settingSchema);
