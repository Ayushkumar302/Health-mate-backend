import Notification from "../models/NotificationSchema.js";
import { getIO, personRoom } from "../socket/io.js";
import logger from "./logger.js";

// where a notification takes each side
export const DASHBOARD = { patient: "/users/profile/me", doctor: "/doctors/profile/me" };

// store a notification for the bell and push it to the person's open tabs.
// Never throws: a notification that can't be saved must not break what caused it.
export const addNotification = async (role, person, { kind, title, text, link }) => {
  try {
    const notification = await Notification.create({
      role,
      person,
      kind,
      title: String(title).slice(0, 120),
      ...(text && { text: String(text).slice(0, 400) }),
      link: link || DASHBOARD[role],
    });
    getIO()?.to(personRoom(role, person)).emit("notification:new", notification);
    return notification;
  } catch (error) {
    logger.error("Could not save notification:", error.message);
    return null;
  }
};
