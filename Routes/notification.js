import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { getNotifications, markAllRead, markOneRead, setOffers } from "../Controllers/notificationController.js";

const router = express.Router();

router.get("/", authenticate, restrict(["patient", "doctor"]), getNotifications);
router.put("/read", authenticate, restrict(["patient", "doctor"]), markAllRead);
router.put("/offers", authenticate, restrict(["patient", "doctor"]), setOffers);
router.put("/:id/read", authenticate, restrict(["patient", "doctor"]), markOneRead);

export default router;
