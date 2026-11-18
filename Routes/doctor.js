import express from "express";
import { updateDoctor,getsingleDoctor,getAllDoctor,deleteDoctor, getDoctorprofile, getAvailableSlots, getTimeOffImpact, addTimeOff, removeTimeOff, aiSearch } from "../Controllers/doctorController.js";
import { authenticate , restrict} from "../auth/verifyToken.js";
import { connectPayouts, connectTestPayouts, getEarnings, getPayoutStatus, getStatement } from "../Controllers/earningsController.js";
import { changePlan, getPlan, setAutoRenew, setInstantBooking, startProCheckout, updateClinicBranding, verifyProCheckout } from "../Controllers/planController.js";
import { aiLimiter, checkoutLimiter } from "../middleware/security.js";
import reviewRouter from './review.js'

const router = express.Router();
// nested route
router.use("/:doctorId/reviews", reviewRouter)

router.get('/profile/me',authenticate, restrict(["doctor"]),getDoctorprofile)
router.get('/earnings', authenticate, restrict(["doctor"]), getEarnings)
router.get('/earnings/statement', authenticate, restrict(["doctor"]), getStatement)
router.post('/payouts/connect', authenticate, restrict(["doctor"]), connectPayouts)
router.get('/payouts/status', authenticate, restrict(["doctor"]), getPayoutStatus)
router.post('/payouts/test-account', authenticate, restrict(["doctor"]), connectTestPayouts)
router.get('/plan', authenticate, restrict(["doctor"]), getPlan)
router.post('/plan/checkout', checkoutLimiter, authenticate, restrict(["doctor"]), startProCheckout)
router.get('/plan/verify/:sessionId', authenticate, restrict(["doctor"]), verifyProCheckout)
router.put('/plan/auto-renew', authenticate, restrict(["doctor"]), setAutoRenew)
router.put('/plan/instant-booking', authenticate, restrict(["doctor"]), setInstantBooking)
router.put('/plan/change', authenticate, restrict(["doctor"]), changePlan)
router.put('/plan/clinic', authenticate, restrict(["doctor"]), updateClinicBranding)
router.get('/time-off/impact', authenticate, restrict(["doctor"]), getTimeOffImpact)
router.post('/time-off', authenticate, restrict(["doctor"]), addTimeOff)
router.delete('/time-off/:entryId', authenticate, restrict(["doctor"]), removeTimeOff)
router.get("/search/ai", aiLimiter, aiSearch)
router.get('/:id/slots',getAvailableSlots)
router.get('/:id',getsingleDoctor)
router.get('/',getAllDoctor)
router.put('/:id',authenticate, restrict(["doctor"]),updateDoctor)
router.delete('/:id',authenticate, restrict(["doctor"]),deleteDoctor)


export default router;
