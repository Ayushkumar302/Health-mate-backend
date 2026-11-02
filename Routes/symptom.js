import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { checkSymptoms, deleteSavedCheck, getSavedChecks, saveCheck } from "../Controllers/symptomController.js";
import { aiLimiter } from "../middleware/security.js";

const router = express.Router();

router.post("/", authenticate, restrict(["patient"]), aiLimiter, checkSymptoms);
router.get("/saved", authenticate, restrict(["patient"]), getSavedChecks);
router.post("/saved", authenticate, restrict(["patient"]), saveCheck);
router.delete("/saved/:id", authenticate, restrict(["patient"]), deleteSavedCheck);

export default router;
