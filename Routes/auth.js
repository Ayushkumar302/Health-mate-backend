import express from 'express'
import { register,login, resendVerification, verifyEmail } from '../Controllers/authController.js'
import { accountLoginLimiter, emailLimiter, loginLimiter, signupLimiter, tokenLimiter } from '../middleware/security.js'

const router = express.Router()
router.post('/register', signupLimiter, register)
router.post('/login', loginLimiter, accountLoginLimiter, login)
router.post('/verify-email', tokenLimiter, verifyEmail)
router.post('/resend-verification', emailLimiter, resendVerification)

export default router;
