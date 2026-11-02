import crypto from "node:crypto";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import User from "../models/UserSchema.js";
import Doctor from "../models/DoctorSchema.js";
import Booking from "../models/BookingSchema.js";
import { EXTEND_MINUTES, checkCallAccess, extendCall, formatDoctorName } from "../utils/video.js";
import { cleanText } from "../utils/text.js";
import { personRoom, setIO } from "./io.js";
import { corsOrigin } from "../middleware/security.js";
import { relayTyping } from "../Controllers/messageController.js";
import logger from "../utils/logger.js"

// Signaling server for peer-to-peer video calls (WebRTC).
// The video itself flows directly between the two browsers; this server only passes along the
// offer/answer and network candidates so they can find each other, and keeps strangers out.

const roomOf = bookingId => `call:${bookingId}`;

// in-call chat limits (enforced here on the server, the browser cannot bypass them)
const CHAT = {
  maxLength: 500,              // characters per message
  rateCount: 8,                // at most 8 messages...
  rateWindowMs: 10 * 1000,     // ...per 10 seconds per person
  maxPerPerson: 100,           // messages per person per call
  historyLimit: 200,           // messages kept for someone who rejoins
};

// hard end time: each participant gets a warning 5 minutes before the window closes and is
// removed from the call when it closes (the browsers then hang up the peer-to-peer connection)
const WARNING_BEFORE_END_MS = 5 * 60 * 1000;
const callTimers = new Map(); // socket.id -> timeouts

const clearCallTimers = socketId => {
  (callTimers.get(socketId) || []).forEach(clearTimeout);
  callTimers.delete(socketId);
};

const scheduleCallEnd = (socket, room, closesAt) => {
  clearCallTimers(socket.id);
  const msLeft = closesAt - Date.now();
  const timers = [];
  // joined with less than 5 minutes left: warn straight away
  timers.push(setTimeout(() => socket.emit("call-ending-soon", { closesAt }), Math.max(0, msLeft - WARNING_BEFORE_END_MS)));
  timers.push(
    setTimeout(() => {
      socket.emit("call-ended");
      socket.leave(room);
      socket.data.bookingId = null;
      clearCallTimers(socket.id);
    }, Math.max(0, msLeft))
  );
  callTimers.set(socket.id, timers);
};

// chat lives only in memory while the call window is open, nothing is written to the database
// bookingId -> { messages: [], expiresAt, sentBy: Map(userId -> timestamps[]) }
const chats = new Map();

const getChat = (bookingId, expiresAt) => {
  if (!chats.has(bookingId)) chats.set(bookingId, { messages: [], expiresAt, sentBy: new Map() });
  return chats.get(bookingId);
};

// forget chats whose call window has closed
setInterval(() => {
  const now = Date.now();
  for (const [bookingId, chat] of chats) {
    if (chat.expiresAt < now) chats.delete(bookingId);
  }
}, 5 * 60 * 1000).unref();

export const initCallSocket = httpServer => {
  // 64 KB is plenty for WebRTC offers and chat, anything bigger is dropped
  const io = new Server(httpServer, { cors: { origin: corsOrigin }, maxHttpBufferSize: 64 * 1024 });
  setIO(io);

  // only logged-in users can open a socket
  io.use((socket, next) => {
    try {
      const decoded = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET_KEY, { algorithms: ["HS256"] });
      socket.data.userId = decoded.id;
      socket.data.role = decoded.role;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", socket => {
    socket.join(personRoom(socket.data.role, socket.data.userId));

    // more than 40 events a second is not a browser on a call, it's a script: disconnect it
    let windowStart = Date.now();
    let eventsInWindow = 0;
    socket.use((packet, next) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        eventsInWindow = 0;
      }
      eventsInWindow += 1;
      if (eventsInWindow > 40) {
        socket.disconnect(true);
        return;
      }
      next();
    });

    // messaging: "is typing" hint, at most one every 2 seconds per socket
    let lastTyping = 0;
    socket.on("dm:typing", payload => {
      if (Date.now() - lastTyping < 2000) return;
      lastTyping = Date.now();
      relayTyping(socket, payload).catch(() => {});
    });

    const leave = () => {
      clearCallTimers(socket.id);
      const { bookingId } = socket.data;
      if (!bookingId) return;
      socket.to(roomOf(bookingId)).emit("peer-left");
      socket.leave(roomOf(bookingId));
      socket.data.bookingId = null;
    };

    socket.on("join-call", async ({ bookingId } = {}, reply = () => {}) => {
      try {
        const { userId, role } = socket.data;
        const { booking, window, error } = await checkCallAccess({ bookingId, userId, role });
        if (error) return reply({ ok: false, code: error.code, message: error.message });

        const room = roomOf(bookingId);
        const others = await io.in(room).fetchSockets();
        // the same person opening the call again (second tab, reload): close the old connection
        for (const other of others.filter(s => s.data.userId === userId)) {
          clearCallTimers(other.id);
          other.emit("replaced");
          other.leave(room);
          const live = io.sockets.sockets.get(other.id);
          if (live) live.data.bookingId = null;
        }
        const peers = others.filter(s => s.data.userId !== userId);
        if (peers.length >= 1 && peers.some(s => s.data.role === role)) {
          return reply({ ok: false, code: "FULL", message: "This call already has two participants" });
        }

        const person =
          role === "doctor"
            ? await Doctor.findById(userId).select("name photo")
            : await User.findById(userId).select("name photo");
        socket.data.bookingId = String(booking._id);
        socket.data.name = role === "doctor" ? formatDoctorName(person?.name) : person?.name || "Patient";
        socket.data.photo = person?.photo;
        socket.data.closesAt = window.closesAt;

        await socket.join(room);
        scheduleCallEnd(socket, room, window.closesAt);
        // the person already waiting starts the connection when someone new arrives
        socket.to(room).emit("peer-joined", { name: socket.data.name, role, photo: socket.data.photo });
        const peer = peers[0];
        const chat = getChat(socket.data.bookingId, window.closesAt);
        reply({
          ok: true,
          peer: peer ? { name: peer.data.name, role: peer.data.role, photo: peer.data.photo } : null,
          messages: chat.messages,
          chatLimits: { maxLength: CHAT.maxLength, maxPerPerson: CHAT.maxPerPerson },
        });
      } catch (error) {
        logger.error("join-call error:", error.message);
        reply({ ok: false, code: "ERROR", message: "Could not join the call" });
      }
    });

    // offer / answer / ICE candidates, passed on unchanged to the other person in the call
    socket.on("signal", data => {
      if (socket.data.bookingId) socket.to(roomOf(socket.data.bookingId)).emit("signal", data);
    });

    // mute / camera off indicators
    socket.on("media-state", state => {
      if (socket.data.bookingId) socket.to(roomOf(socket.data.bookingId)).emit("media-state", state);
    });

    // in-call chat: sender identity comes from the verified token, never from the message itself
    socket.on("chat-message", (payload, reply) => {
      const respond = typeof reply === "function" ? reply : () => {};
      const { bookingId, userId, role, name, closesAt } = socket.data;
      if (!bookingId) return respond({ ok: false, message: "Join the call first" });
      if (Date.now() > closesAt) return respond({ ok: false, message: "This consultation has ended" });

      const raw = payload?.text;
      if (typeof raw !== "string") return respond({ ok: false, message: "Invalid message" });
      const text = cleanText(raw);
      if (!text) return respond({ ok: false, message: "Message is empty" });
      if (text.length > CHAT.maxLength) {
        return respond({ ok: false, message: `Messages can be at most ${CHAT.maxLength} characters` });
      }

      const chat = getChat(bookingId, closesAt);
      const now = Date.now();
      const sent = chat.sentBy.get(userId) || [];
      if (sent.length >= CHAT.maxPerPerson) {
        return respond({ ok: false, message: `Message limit reached (${CHAT.maxPerPerson} per call)` });
      }
      const recent = sent.filter(time => now - time < CHAT.rateWindowMs);
      if (recent.length >= CHAT.rateCount) {
        return respond({ ok: false, message: "You're sending messages too fast, please wait a moment" });
      }
      sent.push(now);
      chat.sentBy.set(userId, sent);

      const message = { id: crypto.randomUUID(), text, senderRole: role, senderName: name, sentAt: now };
      chat.messages.push(message);
      if (chat.messages.length > CHAT.historyLimit) chat.messages.shift();

      io.to(roomOf(bookingId)).emit("chat-message", message);
      respond({ ok: true, remaining: CHAT.maxPerPerson - sent.length });
    });

    // doctor adds 10 minutes to the running consultation
    socket.on("extend-call", async (_payload, reply) => {
      const respond = typeof reply === "function" ? reply : () => {};
      try {
        const { bookingId, role } = socket.data;
        if (!bookingId) return respond({ ok: false, message: "Join the call first" });
        if (role !== "doctor") return respond({ ok: false, message: "Only the doctor can extend the consultation" });

        const booking = await Booking.findById(bookingId);
        const result = await extendCall(booking);
        if (result.error) return respond({ ok: false, message: result.error });

        // move the warning and the hang-up time for everyone in the call
        const room = roomOf(bookingId);
        const { closesAt, endsAt } = result.window;
        for (const remote of await io.in(room).fetchSockets()) {
          const live = io.sockets.sockets.get(remote.id);
          if (!live) continue;
          live.data.closesAt = closesAt;
          scheduleCallEnd(live, room, closesAt);
        }
        const chat = chats.get(bookingId);
        if (chat) chat.expiresAt = closesAt;

        io.to(room).emit("call-extended", {
          endsAt,
          closesAt,
          extendedMinutes: result.booking.extendedMinutes,
          addedMinutes: EXTEND_MINUTES,
          by: socket.data.name,
        });
        respond({ ok: true });
      } catch (error) {
        logger.error("extend-call error:", error.message);
        respond({ ok: false, message: "Could not extend the consultation" });
      }
    });

    socket.on("leave-call", leave);
    socket.on("disconnect", leave);
  });

  return io;
};
