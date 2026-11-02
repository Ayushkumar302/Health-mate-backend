import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import {
  getContacts,
  getConversations,
  getMessages,
  getUnreadCount,
  markRead,
  openConversation,
  sendMessage,
} from "../Controllers/messageController.js";

const router = express.Router();
router.use(authenticate, restrict(["patient", "doctor"]));

router.get("/unread", getUnreadCount);
router.get("/contacts", getContacts);
router.get("/conversations", getConversations);
router.post("/conversations", openConversation);
router.get("/conversations/:id/messages", getMessages);
router.post("/conversations/:id/messages", sendMessage);
router.put("/conversations/:id/read", markRead);

export default router;
