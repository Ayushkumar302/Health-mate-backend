import { formatDay, isRunning, planFrom } from "../utils/subscriptions.js";
import { formatRupees } from "../utils/earnings.js";
import { rankOf } from "../utils/tiers.js";
import { addNotification } from "../utils/notifications.js";
import { remindRenewals } from "../utils/renewalReminders.js";
import {
  cancelSubscription, changeSubscriptionPlan, retrieveSubscription, setSubscriptionRenewal, startSubscriptionCheckout, subscriptionFromCheckout,
} from "../utils/billing.js";
import logger from "../utils/logger.js";

// The parts of a paid plan that work the same for doctors (Pro tiers, monthly) and patients (Plus tiers, yearly):
// buying one, coming back from Stripe, moving to another tier, auto-renew, and the renewal check.
// There is no webhook: the subscription is read from Stripe when the person comes back from the payment page
// and again around each renewal date (syncPlans, every few minutes).
export const subscriptionHandlers = ({
  Model, field, role, kind, audience, ownerKey, tiers, order, interval, tierOf, link, returnPath, endPlan, afterChange = () => {}, remindDaysBefore,
}) => {
  const paid = order.filter(id => id !== "free");
  const labelOf = id => `Medora ${tiers[id].label}`;
  const owner = req => ({ key: ownerKey, id: req.userId });
  const period = interval === "month" ? "month" : "year";

  // POST .../checkout  body: { tier }
  const startCheckout = async (req, res) => {
    const tier = tiers[req.body?.tier];
    if (!tier || tier.id === "free" || !paid.includes(tier.id)) {
      return res.status(400).json({ success: false, message: "Choose a plan" });
    }
    if (tier.available === false) {
      return res.status(400).json({ success: false, message: `${labelOf(tier.id)} isn't available yet` });
    }
    try {
      const person = await Model.findById(req.userId).select(`${field} email`);
      const current = tierOf(person);
      if (current !== "free") {
        return res.status(400).json({ success: false, message: `You're already on ${labelOf(current)}. Change your plan instead of buying a new one` });
      }
      const url = await startSubscriptionCheckout({ audience, tier, interval, owner: owner(req), email: person.email, kind, returnPath });
      res.status(200).json({ success: true, data: { url } });
    } catch (error) {
      logger.error(`${kind} checkout error:`, error.message);
      res.status(500).json({ success: false, message: "Could not open the payment page, please try again" });
    }
  };

  // GET .../verify/:sessionId  back from the payment page: confirm it with Stripe and switch the plan on
  const verifyCheckout = async (req, res) => {
    try {
      const { subscription, tier, error } = await subscriptionFromCheckout({ sessionId: req.params.sessionId, owner: owner(req), kind });
      if (error) return res.status(error.status).json({ success: false, message: error.message });
      if (!isRunning(subscription) || !paid.includes(tier)) {
        return res.status(400).json({ success: false, message: "Payment not completed" });
      }
      // the same page can be verified twice (two tabs): only the first switch-on is announced
      const switched = await Model.updateOne(
        { _id: req.userId, [`${field}.subscriptionId`]: { $ne: subscription.id } },
        { $set: { [field]: planFrom(tier, subscription) } }
      );
      afterChange();
      if (switched.modifiedCount) {
        await addNotification(role, req.userId, {
          kind: field,
          title: `Welcome to ${labelOf(tier)}`,
          text: `Your plan renews on ${formatDay(planFrom(tier, subscription).expiresAt)}. You can change or cancel it any time.`,
          link,
        });
      }
      res.status(200).json({ success: true, message: `Welcome to ${labelOf(tier)}` });
    } catch (error) {
      logger.error(`${kind} verify error:`, error.message);
      res.status(500).json({ success: false, message: "Could not verify the payment" });
    }
  };

  // PUT .../change  body: { tier }  upgrade now (pay the difference) or downgrade at the next renewal;
  // choosing the current tier again cancels a downgrade that is waiting
  const changePlan = async (req, res) => {
    const target = tiers[req.body?.tier];
    if (!target || !paid.includes(target.id)) {
      return res.status(400).json({ success: false, message: "Choose a plan" });
    }
    if (target.available === false) {
      return res.status(400).json({ success: false, message: `${labelOf(target.id)} isn't available yet` });
    }
    try {
      const person = await Model.findById(req.userId).select(`+${field}.subscriptionId`);
      const current = tierOf(person);
      const plan = person?.[field];
      if (current === "free") {
        return res.status(400).json({ success: false, message: "You don't have a plan to change yet" });
      }
      if (!plan.subscriptionId) {
        return res.status(400).json({ success: false, message: "This demo plan can't be changed. It goes back to normal at the next demo reset" });
      }
      const base = { subscriptionId: plan.subscriptionId, audience, interval };

      if (target.id === current) {
        if (!plan.pendingTier) return res.status(400).json({ success: false, message: `You're already on ${labelOf(current)}` });
        // keep the current tier after all: the renewal goes back to its price
        await changeSubscriptionPlan({ ...base, tier: tiers[current], upgrade: false });
        await Model.updateOne({ _id: req.userId }, { $unset: { [`${field}.pendingTier`]: 1 } });
        return res.status(200).json({ success: true, message: `You'll stay on ${labelOf(current)}` });
      }

      if (rankOf(order, target.id) > rankOf(order, current)) {
        const { expiresAt, charged } = await changeSubscriptionPlan({ ...base, tier: target, upgrade: true });
        await Model.updateOne(
          { _id: req.userId },
          { $set: { [`${field}.name`]: target.id, [`${field}.price`]: target.price, [`${field}.expiresAt`]: expiresAt }, $unset: { [`${field}.pendingTier`]: 1 } }
        );
        afterChange();
        await addNotification(role, req.userId, {
          kind: field,
          title: `You're on ${labelOf(target.id)} now`,
          text: `${charged ? `${formatRupees(charged)} was charged for the rest of this ${period}. ` : ""}From ${formatDay(expiresAt)} it renews at ${formatRupees(target.price)} a ${period}.`,
          link,
        });
        return res.status(200).json({
          success: true,
          message: `Upgraded to ${labelOf(target.id)}${charged ? `, ${formatRupees(charged)} charged for the rest of this ${period}` : ""}`,
        });
      }

      // downgrade: only meaningful while the plan renews
      if (!plan.autoRenew) {
        return res.status(400).json({ success: false, message: `Your plan already ends on ${formatDay(plan.expiresAt)}. Turn auto-renew on to switch to another plan` });
      }
      await changeSubscriptionPlan({ ...base, tier: target, upgrade: false });
      await Model.updateOne({ _id: req.userId }, { $set: { [`${field}.pendingTier`]: target.id } });
      res.status(200).json({
        success: true,
        message: `From ${formatDay(plan.expiresAt)} you'll be on ${labelOf(target.id)} for ${formatRupees(target.price)} a ${period}. Until then you keep ${labelOf(current)}`,
      });
    } catch (error) {
      logger.error(`${kind} change error:`, error.message);
      const declined = /card|payment|declin|insufficient/i.test(error.message);
      res.status(declined ? 402 : 500).json({ success: false, message: declined ? "The payment for the upgrade didn't go through, your plan is unchanged" : "Could not change the plan" });
    }
  };

  // PUT .../auto-renew  body: { on }  off: the plan ends with the paid period; on: it keeps renewing
  const setAutoRenew = async (req, res) => {
    if (typeof req.body?.on !== "boolean") {
      return res.status(400).json({ success: false, message: "Choose on or off" });
    }
    const { on } = req.body;
    try {
      const person = await Model.findById(req.userId).select(`+${field}.subscriptionId`);
      const current = tierOf(person);
      if (current === "free") {
        return res.status(400).json({ success: false, message: "You don't have a paid plan" });
      }
      const plan = person[field];
      if (plan.subscriptionId) await setSubscriptionRenewal(plan.subscriptionId, on);
      // turning renewal off also drops a downgrade that was waiting for it
      await Model.updateOne({ _id: req.userId }, { $set: { [`${field}.autoRenew`]: on }, ...(!on && plan.pendingTier && { $unset: { [`${field}.pendingTier`]: 1 } }) });
      if (!on && plan.pendingTier && plan.subscriptionId) {
        await changeSubscriptionPlan({ subscriptionId: plan.subscriptionId, audience, interval, tier: tiers[current], upgrade: false });
      }
      const until = formatDay(plan.expiresAt);
      res.status(200).json({
        success: true,
        message: on ? `Auto-renew is on, ${labelOf(current)} renews on ${until}` : `Auto-renew is off. You keep ${labelOf(current)} until ${until}, then move to the free plan`,
      });
    } catch (error) {
      logger.error(`${kind} auto-renew error:`, error.message);
      res.status(500).json({ success: false, message: "Could not update the plan" });
    }
  };

  // every few minutes: plans whose paid period is over are re-read from Stripe. Renewed ones move forward
  // (switching to a downgrade that was waiting), ended ones go back to free.
  const syncPlans = async () => {
    const due = await Model.find({ [`${field}.name`]: { $in: paid }, [`${field}.expiresAt`]: { $lte: new Date() } }).select(`+${field}.subscriptionId`);
    for (const person of due) {
      const plan = person[field];
      try {
        const subscription = plan.subscriptionId ? await retrieveSubscription(plan.subscriptionId) : null;
        if (subscription && isRunning(subscription)) {
          const next = paid.includes(plan.pendingTier) ? plan.pendingTier : plan.name;
          const renewed = planFrom(next, subscription, plan.since);
          await Model.updateOne({ _id: person._id }, { $set: { [field]: renewed } });
          await addNotification(role, person._id, {
            kind: field,
            title: next === plan.name ? `${labelOf(next)} renewed` : `You're on ${labelOf(next)} now`,
            text: `Paid until ${formatDay(renewed.expiresAt)}.`,
            link,
          });
        } else {
          await endPlan(person._id);
          await addNotification(role, person._id, {
            kind: field,
            title: `Your ${labelOf(plan.name)} plan has ended`,
            text: "You're on the free plan now. You can choose a plan again any time.",
            link,
          });
        }
      } catch (error) {
        logger.error("Could not sync plan", String(person._id), error.message);
      }
    }
    if (due.length) afterChange();
    // a few days before the renewal date: "renews on ..." or "ends on ..."
    await remindRenewals({ Model, field, names: paid, role, labelOf, priceOf: id => tiers[id].price, daysBefore: remindDaysBefore, link });
  };

  // demo reset: stop a visitor's test subscription and take the plan off again
  const cancelOf = async person => {
    if (person[field]?.subscriptionId) await cancelSubscription(person[field].subscriptionId);
    await endPlan(person._id);
  };

  return { startCheckout, verifyCheckout, changePlan, setAutoRenew, syncPlans, cancelOf, labelOf };
};
