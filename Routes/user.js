import express from "express";
import { updateUser,deleteUser, getsingleUser, getUserProfile, getMyAppointments } from "../Controllers/userController.js";
import { addFamilyMember, getFamily, removeFamilyMember, updateFamilyMember } from "../Controllers/familyController.js";
import { authenticate , restrict} from "../auth/verifyToken.js";

const router = express.Router();

// before "/:id", which would otherwise catch "/family"
router.get('/family', authenticate, restrict(["patient"]), getFamily)
router.post('/family', authenticate, restrict(["patient"]), addFamilyMember)
router.put('/family/:memberId', authenticate, restrict(["patient"]), updateFamilyMember)
router.delete('/family/:memberId', authenticate, restrict(["patient"]), removeFamilyMember)

router.get('/:id',authenticate, restrict(["patient"]), getsingleUser)
router.put('/:id',authenticate, restrict(["patient"]),updateUser)
router.delete('/:id',authenticate, restrict(["patient"]),deleteUser)
router.get('/profile/me',authenticate, restrict(["patient"]),getUserProfile)
router.get('/appointments/my-appointments',authenticate, restrict(["patient"]),getMyAppointments)



export default router;
