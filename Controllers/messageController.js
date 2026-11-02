import mongoose from "mongoose";
import Booking from "../models/BookingSchema.js";
import Conversation from "../models/ConversationSchema.js";
import Message from "../models/MessageSchema.js";
import Doctor from "../models/DoctorSchema.js";
import User from "../models/UserSchema.js";
import { getIO, personRoom } from "../socket/io.js";
import { cleanText, createRateLimiter } from "../utils/text.js";

// Doctor <-> patient messaging outside of calls. Messages are stored in MongoDB and pushed live
// over Socket.io to whoever is online. Limits are enforced here, the browser cannot skip them.
export const MESSAGE_LIMITS = {
  maxLength: 1000,  // characters per message
  burst: 5,         // at most 5 messages...
  burstMs: 10_000,  // ...per 10 seconds
  hourly: 60,       // and 60 per hour, per person
  pageSize: 30,     // messages loaded at a time
};

const burstLimit = createRateLimiter({ count: MESSAGE_LIMITS.burst, windowMs: MESSAGE_LIMITS.burstMs });
const hourlyLimit = createRateLimiter({ count: MESSAGE_LIMITS.hourly, windowMs: 60 * 60 * 1000 });

const isDoctor = req => req.role === "doctor";
// my side of a conversation and the other side
const mine = req => (isDoctor(req) ? { doctor: req.userId } : { user: req.userId });
const myUnreadField = req => (isDoctor(req) ? "unreadForDoctor" : "unreadForUser");
const otherUnreadField = req => (isDoctor(req) ? "unreadForUser" : "unreadForDoctor");

const populateOther = (query, req) =>
  isDoctor(req) ? query.populate("user", "name photo gender") : query.populate("doctor", "name photo specialization");

// what the browser needs to show a conversation in the list
const summarize = (conversation, req) => {
  const other = isDoctor(req) ? conversation.user : conversation.doctor;
  return {
    _id: conversation._id,
    other: other && {
      _id: other._id,
      name: other.name,
      photo: other.photo,
      role: isDoctor(req) ? "patient" : "doctor",
      specialization: other.specialization,
    },
    lastMessage: conversation.lastMessage?.at ? conversation.lastMessage : null,
    unread: conversation[myUnreadField(req)] || 0,
    updatedAt: conversation.updatedAt,
  };
};

// a patient and doctor may only message each other once they have a paid booking together
const haveBooked = (userId, doctorId) => Booking.exists({ user: userId, doctor: doctorId, isPaid: true });

const findMyConversation = (req, id) =>
  mongoose.isValidObjectId(id) ? Conversation.findOne({ _id: id, ...mine(req) }) : null;

// tell every open tab of a person about something
const notify = (role, id, event, payload) => getIO()?.to(personRoom(role, id)).emit(event, payload);

// GET /messages/conversations
export const getConversations = async (req, res) => {
  try {
    const conversations = await populateOther(Conversation.find(mine(req)).sort({ updatedAt: -1 }), req);
    res.status(200).json({
      success: true,
      message: "Conversations",
      data: conversations.map(item => summarize(item, req)).filter(item => item.other),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load conversations" });
  }
};

// GET /messages/contacts  people I'm allowed to message (my doctors, or my patients)
export const getContacts = async (req, res) => {
  try {
    const field = isDoctor(req) ? "user" : "doctor";
    const bookings = await Booking.find({ ...mine(req), isPaid: true })
      .select(field)
      .populate(field, isDoctor(req) ? "name photo" : "name photo specialization");
    const people = new Map();
    bookings.forEach(booking => {
      const person = booking[field];
      if (person) people.set(String(person._id), { _id: person._id, name: person.name, photo: person.photo, specialization: person.specialization });
    });
    res.status(200).json({ success: true, message: "Contacts", data: [...people.values()] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load contacts" });
  }
};

// POST /messages/conversations  body: { participantId }  open (or create) the thread with a doctor/patient
export const openConversation = async (req, res) => {
  const { participantId } = req.body;
  if (!mongoose.isValidObjectId(participantId)) {
    return res.status(400).json({ success: false, message: "Choose who to message" });
  }
  try {
    const pair = isDoctor(req) ? { user: participantId, doctor: req.userId } : { user: req.userId, doctor: participantId };
    if (!(await haveBooked(pair.user, pair.doctor))) {
      return res.status(403).json({ success: false, message: "You can message a doctor once you have booked an appointment with them" });
    }
    const conversation = await Conversation.findOneAndUpdate(pair, { $setOnInsert: pair }, { new: true, upsert: true });
    await populateOther(conversation, req);
    res.status(200).json({ success: true, message: "Conversation ready", data: summarize(conversation, req) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not open the conversation" });
  }
};

// GET /messages/conversations/:id/messages?before=<ISO date>
export const getMessages = async (req, res) => {
  try {
    const conversation = await findMyConversation(req, req.params.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }
    const before = req.query.before ? new Date(req.query.before) : null;
    const filter = { conversation: conversation._id, ...(before && !isNaN(before) && { createdAt: { $lt: before } }) };
    // newest page first, then flipped so the browser gets them oldest -> newest
    const messages = await Message.find(filter).sort({ createdAt: -1 }).limit(MESSAGE_LIMITS.pageSize + 1);
    const hasMore = messages.length > MESSAGE_LIMITS.pageSize;
    res.status(200).json({
      success: true,
      message: "Messages",
      data: { messages: messages.slice(0, MESSAGE_LIMITS.pageSize).reverse(), hasMore, limits: MESSAGE_LIMITS },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load messages" });
  }
};

// POST /messages/conversations/:id/messages  body: { text }
export const sendMessage = async (req, res) => {
  const text = cleanText(req.body.text);
  if (!text) {
    return res.status(400).json({ success: false, message: "Message can't be empty" });
  }
  if (text.length > MESSAGE_LIMITS.maxLength) {
    return res.status(400).json({ success: false, message: `Messages can be at most ${MESSAGE_LIMITS.maxLength} characters` });
  }
  const sender = `${req.role}:${req.userId}`;
  if (!burstLimit(sender)) {
    return res.status(429).json({ success: false, message: "You're sending messages too fast, wait a few seconds" });
  }
  if (!hourlyLimit(sender)) {
    return res.status(429).json({ success: false, message: `You can send up to ${MESSAGE_LIMITS.hourly} messages an hour` });
  }
  try {
    const conversation = await findMyConversation(req, req.params.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }
    const senderRole = isDoctor(req) ? "doctor" : "patient";
    const message = await Message.create({ conversation: conversation._id, senderRole, text });
    const updated = await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        $set: { lastMessage: { text: text.slice(0, 140), senderRole, at: message.createdAt } },
        $inc: { [otherUnreadField(req)]: 1 },
      },
      { new: true }
    );

    // push it to the other person and to my other tabs
    const sender = isDoctor(req) ? await Doctor.findById(req.userId).select("name") : await User.findById(req.userId).select("name");
    const payload = { conversationId: String(conversation._id), message, lastMessage: updated.lastMessage, senderName: sender?.name };
    if (isDoctor(req)) {
      notify("patient", conversation.user, "dm:new", { ...payload, unread: updated.unreadForUser });
      notify("doctor", conversation.doctor, "dm:new", { ...payload, unread: updated.unreadForDoctor });
    } else {
      notify("doctor", conversation.doctor, "dm:new", { ...payload, unread: updated.unreadForDoctor });
      notify("patient", conversation.user, "dm:new", { ...payload, unread: updated.unreadForUser });
    }
    res.status(201).json({ success: true, message: "Sent", data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not send the message" });
  }
};

// PUT /messages/conversations/:id/read  I've seen everything in this thread
export const markRead = async (req, res) => {
  try {
    const conversation = await findMyConversation(req, req.params.id);
    if (!conversation) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }
    const readAt = new Date();
    const otherRole = isDoctor(req) ? "patient" : "doctor";
    await Promise.all([
      Conversation.updateOne({ _id: conversation._id }, { $set: { [myUnreadField(req)]: 0 } }),
      Message.updateMany({ conversation: conversation._id, senderRole: otherRole, readAt: { $exists: false } }, { $set: { readAt } }),
    ]);
    const payload = { conversationId: String(conversation._id), readAt, readBy: isDoctor(req) ? "doctor" : "patient" };
    notify(otherRole, isDoctor(req) ? conversation.user : conversation.doctor, "dm:read", payload);
    notify(req.role, req.userId, "dm:read", payload);
    res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update the conversation" });
  }
};

// GET /messages/unread  total unread messages, for the badge in the header
export const getUnreadCount = async (req, res) => {
  try {
    const field = myUnreadField(req);
    const [result] = await Conversation.aggregate([
      { $match: isDoctor(req) ? { doctor: new mongoose.Types.ObjectId(req.userId) } : { user: new mongoose.Types.ObjectId(req.userId) } },
      { $group: { _id: null, total: { $sum: `$${field}` } } },
    ]);
    res.status(200).json({ success: true, message: "Unread count", data: { unread: result?.total || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load unread messages" });
  }
};

// socket "dm:typing": relay "is typing" to the other person (only for members of the conversation)
export const relayTyping = async (socket, { conversationId } = {}) => {
  if (!mongoose.isValidObjectId(conversationId)) return;
  const { role, userId } = socket.data;
  const conversation = await Conversation.findOne({ _id: conversationId, ...(role === "doctor" ? { doctor: userId } : { user: userId }) }).select("user doctor");
  if (!conversation) return;
  const to = role === "doctor" ? personRoom("patient", conversation.user) : personRoom("doctor", conversation.doctor);
  socket.to(to).emit("dm:typing", { conversationId });
};
