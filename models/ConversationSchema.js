import mongoose from "mongoose";

// one thread per patient + doctor pair (only pairs with a paid booking may talk)
const conversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Types.ObjectId, ref: "User", required: true },
    doctor: { type: mongoose.Types.ObjectId, ref: "Doctor", required: true },
    lastMessage: {
      text: { type: String },
      senderRole: { type: String, enum: ["patient", "doctor"] },
      at: { type: Date },
    },
    // messages the other side has not opened yet
    unreadForUser: { type: Number, default: 0 },
    unreadForDoctor: { type: Number, default: 0 },
  },
  { timestamps: true }
);

conversationSchema.index({ user: 1, doctor: 1 }, { unique: true });
conversationSchema.index({ doctor: 1, updatedAt: -1 });

export default mongoose.model("Conversation", conversationSchema);
