import express from "express";
import { authenticate, restrict } from "../auth/verifyToken.js";
import { deleteDocument, downloadDocument, explainDocument, getExplainAllowance, getMyDocuments, uploadDocument, uploadFile } from "../Controllers/documentController.js";
import { aiLimiter, uploadLimiter } from "../middleware/security.js";

const router = express.Router();

router.post("/", uploadLimiter, authenticate, restrict(["patient", "doctor"]), uploadFile, uploadDocument);
router.get("/mine", authenticate, restrict(["patient", "doctor"]), getMyDocuments);
router.get("/explain/allowance", authenticate, restrict(["patient"]), getExplainAllowance);
router.post("/:id/explain", authenticate, restrict(["patient"]), aiLimiter, explainDocument);
router.get("/:id/file", authenticate, restrict(["patient", "doctor", "admin"]), downloadDocument);
router.delete("/:id", authenticate, restrict(["patient", "doctor"]), deleteDocument);

export default router;
