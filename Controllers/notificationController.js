import mongoose from "mongoose";
import Notification from "../models/NotificationSchema.js";
import { offersOn, resumeOffers, setOffersOn } from "../utils/offers.js";

const PAGE = 30;
const mine = req => ({ role: req.role, person: req.userId });

// GET /notifications  the latest notifications, how many are unread, and whether upgrade suggestions are on
export const getNotifications = async (req, res) => {
  try {
    const [items, unread, offers] = await Promise.all([
      Notification.find(mine(req)).sort({ createdAt: -1 }).limit(PAGE).select("-role -person -__v"),
      Notification.countDocuments({ ...mine(req), readAt: { $exists: false } }),
      offersOn(req.role, req.userId),
    ]);
    res.status(200).json({ success: true, data: { items, unread, offers } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load notifications" });
  }
};

// PUT /notifications/read  mark everything as read
export const markAllRead = async (req, res) => {
  try {
    const result = await Notification.updateMany({ ...mine(req), readAt: { $exists: false } }, { $set: { readAt: new Date() } });
    // upgrade suggestions that were seen are no longer "ignored"
    if (result.modifiedCount) resumeOffers(req.role, req.userId);
    res.status(200).json({ success: true, message: "All caught up" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update notifications" });
  }
};

// PUT /notifications/:id/read
export const markOneRead = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  try {
    const updated = await Notification.findOneAndUpdate(
      { _id: req.params.id, ...mine(req) },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Notification not found" });
    if (updated.kind === "offer") resumeOffers(req.role, req.userId);
    res.status(200).json({ success: true, message: "Read" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not update the notification" });
  }
};

// PUT /notifications/offers  body: { on }  "Offers and tips": upgrade suggestions in the bell, on or off
export const setOffers = async (req, res) => {
  if (typeof req.body?.on !== "boolean") {
    return res.status(400).json({ success: false, message: "Say on or off" });
  }
  try {
    await setOffersOn(req.role, req.userId, req.body.on);
    res.status(200).json({
      success: true,
      message: req.body.on ? "Offers and tips are on, at most one every 15 days" : "No more offers and tips. Booking and plan updates still arrive",
      data: { offers: req.body.on },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not save the setting" });
  }
};
