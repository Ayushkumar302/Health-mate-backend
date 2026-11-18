import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { getMoneySettings, getSubscriptions, stopRenewal, updateMoneySettings } from "../Controllers/adminMoneyController.js";
import { getBookings, getDoctors, getPatients, getStats, updateDoctorStatus } from "../Controllers/adminController.js";

const router = express.Router();
router.use(authenticate, restrict(["admin"]));

router.get("/stats", getStats);
router.get("/doctors", getDoctors);
router.put("/doctors/:id/status", updateDoctorStatus);
router.get("/patients", getPatients);
router.get("/bookings", getBookings);
router.get("/settings/money", getMoneySettings);
router.put("/settings/money", updateMoneySettings);
router.get("/plans", getSubscriptions);
router.put("/plans/:kind/:id/stop-renewal", stopRenewal);

export default router;
