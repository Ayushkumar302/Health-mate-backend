import express from "express";
import { getAllReviews,createReview, replyToReview } from "../Controllers/reviewController.js";
import { authenticate,restrict } from "../auth/verifyToken.js";

const router = express.Router({mergeParams:true});
router.route("/").get(getAllReviews).post(authenticate,restrict(["patient"]),createReview);
// the doctor answers a review publicly (an empty text removes the answer)
router.put("/:id/reply", authenticate, restrict(["doctor"]), replyToReview);

export default router;
