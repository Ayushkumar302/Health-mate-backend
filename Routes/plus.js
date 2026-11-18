import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { checkoutLimiter } from "../middleware/security.js";
import { changePlus, getPlus, setPlusAutoRenew, startPlusCheckout, verifyPlusCheckout } from "../Controllers/plusController.js";

const router = express.Router();

router.get("/", authenticate, restrict(["patient"]), getPlus);
router.post("/checkout", checkoutLimiter, authenticate, restrict(["patient"]), startPlusCheckout);
router.get("/verify/:sessionId", authenticate, restrict(["patient"]), verifyPlusCheckout);
router.put("/auto-renew", authenticate, restrict(["patient"]), setPlusAutoRenew);
router.put("/change", authenticate, restrict(["patient"]), changePlus);

export default router;
