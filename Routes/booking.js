import express from 'express'
import { authenticate, restrict } from "../auth/verifyToken.js";
import { aiLimiter, checkoutLimiter } from "../middleware/security.js";
import { getIntakeQuestions, saveIntake } from '../Controllers/intakeController.js';
import { getMyWaitlist, joinWaitlist, leaveWaitlist } from '../Controllers/waitlistController.js';
import { bookingAssistant } from '../Controllers/bookingAssistantController.js';
import { cancelBooking, getCheckoutSession, getReceipt, getRefundQuote, getVideoSession, markNoShow, rescheduleBooking, respondToBooking, verifyCheckoutSession } from '../Controllers/bookingController.js';

const router = express.Router()
// book with AI: matching doctors and free times for a message (the patient still pays through the checkout)
router.post('/assistant', authenticate, restrict(["patient"]), aiLimiter, bookingAssistant)
router.post('/checkout-session/:doctorId', checkoutLimiter, authenticate, restrict(["patient"]), getCheckoutSession)
router.get('/verify-session/:sessionId', authenticate, restrict(["patient"]), verifyCheckoutSession)
router.get('/:id/refund-quote', authenticate, restrict(["patient"]), getRefundQuote)
router.put('/:id/cancel', authenticate, restrict(["patient", "doctor"]), cancelBooking)
router.put('/:id/no-show', authenticate, restrict(["doctor"]), markNoShow)
router.put('/:id/respond', authenticate, restrict(["doctor"]), respondToBooking)
router.put('/:id/reschedule', authenticate, restrict(["patient"]), rescheduleBooking)
router.get('/:id/video', authenticate, restrict(["patient", "doctor"]), getVideoSession)
router.get('/:id/receipt', authenticate, restrict(["patient"]), getReceipt)
// waitlist for fully booked days (Plus and Plus Family)
router.post('/waitlist', authenticate, restrict(["patient"]), joinWaitlist)
router.get('/waitlist/mine', authenticate, restrict(["patient"]), getMyWaitlist)
router.delete('/waitlist/:id', authenticate, restrict(["patient"]), leaveWaitlist)
// pre-visit intake (AI questions and a summary for the doctor)
router.post('/:id/intake/questions', authenticate, restrict(["patient"]), aiLimiter, getIntakeQuestions)
router.put('/:id/intake', authenticate, restrict(["patient"]), aiLimiter, saveIntake)

export default router;
