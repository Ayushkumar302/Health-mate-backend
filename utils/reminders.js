import Booking from "../models/BookingSchema.js";
import { addNotification } from "./notifications.js";
import { actionEmail, sendMail, usingTestInbox } from "./mailer.js";
import { addDays, appointmentEpoch, clinicToday } from "./slots.js";
import { ONLINE_TYPES, typeLabel } from "./consultation.js";
import { siteUrl } from "./site.js";
import logger from "./logger.js";

// Appointment reminders for confirmed visits: the patient a day before and an hour before, the doctor an hour before.
// In the notification centre (and pushed live); by email too when a real mail server is set up (SMTP_HOST).
// Each reminder is sent once (remindersSent on the booking). Someone who booked less than a day ahead only
// gets the one-hour reminder.

const HOUR = 60 * 60 * 1000;

const clock = time => {
  const [hours, minutes] = time.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "pm" : "am"}`;
};

const patientMessage = (booking, due, today) => {
  const doctor = booking.doctor?.name || "your doctor";
  const when = due === "1h" ? "In 1 hour" : booking.appointmentDate === today ? `Today at ${clock(booking.appointmentTime)}` : `Tomorrow at ${clock(booking.appointmentTime)}`;
  const forWhom = booking.familyMember?.name ? ` for ${booking.familyMember.name}` : "";
  const how = ONLINE_TYPES.includes(booking.consultationType)
    ? "The video room opens 10 minutes before, join from your dashboard."
    : `At ${booking.doctor?.clinicAddress || "the clinic"}.`;
  const intake = booking.intake?.submittedAt ? "" : " Tell the doctor why you're coming before the visit, it takes a minute.";
  return {
    title: `${when}: ${typeLabel(booking.consultationType).toLowerCase()} with ${doctor}${forWhom}`,
    text: `${how}${intake}`,
  };
};

// runs with the 5-minute jobs (onlyBookings limits a run to those bookings, used by tests); returns how many were sent
export const sendReminders = async (now = Date.now(), onlyBookings) => {
  const today = clinicToday();
  const bookings = await Booking.find({
    ...(onlyBookings && { _id: { $in: onlyBookings } }),
    isPaid: true,
    status: "approved",
    appointmentDate: { $in: [today, addDays(today, 1)] },
  })
    .select("doctor user appointmentDate appointmentTime consultationType familyMember remindersSent createdAt intake.submittedAt")
    .populate("doctor", "name clinicAddress")
    .populate("user", "name email");
  let sent = 0;
  for (const booking of bookings) {
    const start = appointmentEpoch(booking.appointmentDate, booking.appointmentTime);
    const left = start - now;
    if (left <= 0) continue;
    const due = left <= HOUR ? "1h" : left <= 24 * HOUR ? "24h" : null;
    if (!due || booking.remindersSent?.includes(due)) continue;
    // booked less than a day ahead: they don't need a "tomorrow" reminder
    if (due === "24h" && booking.createdAt > new Date(start - 24 * HOUR)) continue;
    try {
      const claimed = await Booking.updateOne({ _id: booking._id, remindersSent: { $ne: due } }, { $addToSet: { remindersSent: due } });
      if (!claimed.modifiedCount) continue;
      const message = patientMessage(booking, due, today);
      await addNotification("patient", booking.user._id, { kind: "reminder", ...message, link: "/users/profile/me" });
      if (due === "1h") {
        const who = booking.familyMember?.name || booking.user?.name || "A patient";
        await addNotification("doctor", booking.doctor._id, {
          kind: "reminder",
          title: `In 1 hour: ${who}, ${typeLabel(booking.consultationType).toLowerCase()}`,
          text: `${booking.appointmentDate} at ${clock(booking.appointmentTime)}.${booking.intake?.submittedAt ? " They sent pre-visit notes." : ""}`,
          link: "/doctors/profile/me?appointments",
        });
      }
      // a real mail server is set up: the patient gets it by email too
      if (!usingTestInbox() && booking.user?.email) {
        sendMail({
          to: booking.user.email,
          subject: message.title,
          ...actionEmail({ name: booking.user.name, intro: `${message.title}. ${message.text}`, button: "Open your dashboard", url: siteUrl("/users/profile/me"), note: "You get this because you have an appointment booked on Medora." }),
        }).catch(error => logger.error("Reminder email failed:", error.message));
      }
      sent++;
    } catch (error) {
      logger.error("Reminder failed", String(booking._id), error.message);
    }
  }
  return sent;
};
