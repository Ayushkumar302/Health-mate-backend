import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Types.ObjectId, ref: "Conversation", required: true },
    senderRole: { type: String, enum: ["patient", "doctor"], required: true },
    text: { type: String, required: true, maxLength: 1000 },
    readAt: { type: Date },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });

export default mongoose.model("Message", messageSchema);
