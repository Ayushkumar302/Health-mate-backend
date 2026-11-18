import { addNotification } from "./notifications.js";
import { formatDay } from "./subscriptions.js";
import { formatRupees } from "./earnings.js";
import logger from "./logger.js";

// One notification a few days before a subscription's date: "renews on ... for ₹..." when auto-renew is on,
// "ends on ..." when it is off. The date reminded about is saved, so each renewal is announced once.
export const remindRenewals = async ({ Model, field, names, role, labelOf, priceOf, daysBefore, link }) => {
  const now = new Date();
  const soon = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);
  const due = await Model.find({
    [`${field}.name`]: { $in: names },
    [`${field}.expiresAt`]: { $gt: now, $lte: soon },
    $expr: { $ne: [`$${field}.remindedFor`, `$${field}.expiresAt`] },
  }).select(field);
  for (const person of due) {
    const plan = person[field];
    try {
      // claim the reminder first, so two servers (or a slow run) can't send it twice
      const claimed = await Model.updateOne(
        { _id: person._id, [`${field}.expiresAt`]: plan.expiresAt, [`${field}.remindedFor`]: { $ne: plan.expiresAt } },
        { $set: { [`${field}.remindedFor`]: plan.expiresAt } }
      );
      if (!claimed.modifiedCount) continue;
      // a downgrade that is waiting renews into the cheaper plan
      const next = plan.pendingTier || plan.name;
      const label = labelOf(plan.name);
      await addNotification(role, person._id, {
        kind: field,
        title: plan.autoRenew
          ? next === plan.name ? `${label} renews on ${formatDay(plan.expiresAt)}` : `You move to ${labelOf(next)} on ${formatDay(plan.expiresAt)}`
          : `${label} ends on ${formatDay(plan.expiresAt)}`,
        text: plan.autoRenew
          ? `${formatRupees(next === plan.name ? plan.price || priceOf(next) : priceOf(next))} will be charged to your card. Turn auto-renew off before then if you don't want to continue.`
          : `Turn auto-renew back on to keep ${label}, otherwise you move to the free plan.`,
        link,
      });
    } catch (error) {
      logger.error("Renewal reminder failed", String(person._id), error.message);
    }
  }
};
