import express from 'express'
import { authenticate, restrict } from "../auth/verifyToken.js";
import { checkoutLimiter } from "../middleware/security.js";
import { cancelBooking, getCheckoutSession, getVideoSession, rescheduleBooking, respondToBooking, verifyCheckoutSession } from '../Controllers/bookingController.js';

const router = express.Router()
router.post('/checkout-session/:doctorId', checkoutLimiter, authenticate, restrict(["patient"]), getCheckoutSession)
router.get('/verify-session/:sessionId', authenticate, restrict(["patient"]), verifyCheckoutSession)
router.put('/:id/cancel', authenticate, restrict(["patient", "doctor"]), cancelBooking)
router.put('/:id/respond', authenticate, restrict(["doctor"]), respondToBooking)
router.put('/:id/reschedule', authenticate, restrict(["patient"]), rescheduleBooking)
router.get('/:id/video', authenticate, restrict(["patient", "doctor"]), getVideoSession)

export default router;
