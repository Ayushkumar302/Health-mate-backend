import express from "express";
import { updateDoctor,getsingleDoctor,getAllDoctor,deleteDoctor, getDoctorprofile, getAvailableSlots, getTimeOffImpact, addTimeOff, removeTimeOff } from "../Controllers/doctorController.js";
import { authenticate , restrict} from "../auth/verifyToken.js";
import reviewRouter from './review.js'

const router = express.Router();
// nested route
router.use("/:doctorId/reviews", reviewRouter)

router.get('/profile/me',authenticate, restrict(["doctor"]),getDoctorprofile)
router.get('/time-off/impact', authenticate, restrict(["doctor"]), getTimeOffImpact)
router.post('/time-off', authenticate, restrict(["doctor"]), addTimeOff)
router.delete('/time-off/:entryId', authenticate, restrict(["doctor"]), removeTimeOff)
router.get('/:id/slots',getAvailableSlots)
router.get('/:id',getsingleDoctor)
router.get('/',getAllDoctor)
router.put('/:id',authenticate, restrict(["doctor"]),updateDoctor)
router.delete('/:id',authenticate, restrict(["doctor"]),deleteDoctor)


export default router;
