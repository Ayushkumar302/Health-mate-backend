// regist and login functionality
import User from '../models/UserSchema.js'
import Doctor from '../models/DoctorSchema.js'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { DEMO_MESSAGES, isDemoMode } from '../utils/demo.js'
import { actionEmail, sendMail } from '../utils/mailer.js'
import { VERIFY_EMAIL_HOURS, createToken, hashToken, passwordProblem } from '../utils/tokens.js'
import logger from '../utils/logger.js'
import { isAllowedPhoto } from '../utils/validate.js'
import { siteUrl } from '../utils/site.js'

// compared against when the email doesn't exist, so that answer takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10)


// the account (patient/admin or doctor) with this email, emails are unique across both
const findAccount = email => User.findOne({ email }).then(user => user || Doctor.findOne({ email }))

// the account holding a still-valid emailed token
const findByToken = async (hashField, expiresField, token) => {
    if (typeof token !== 'string' || token.length !== 64) return null
    const filter = { [hashField]: hashToken(token), [expiresField]: { $gt: new Date() } }
    return (await User.findOne(filter)) || (await Doctor.findOne(filter))
}

// emails a fresh verification link; returns { previewUrl } when the test inbox is used
const sendVerificationEmail = async account => {
    const { token, hash } = createToken()
    account.emailVerifyTokenHash = hash
    account.emailVerifyExpires = new Date(Date.now() + VERIFY_EMAIL_HOURS * 60 * 60 * 1000)
    await account.save()
    return sendMail({
        to: account.email,
        subject: 'Verify your email for Medora',
        ...actionEmail({
            name: account.name,
            intro: 'Thanks for joining Medora. Please confirm this is your email address to finish setting up your account.',
            button: 'Verify my email',
            url: siteUrl(`/verify-email?token=${token}`),
            note: `This link works once and expires in ${VERIFY_EMAIL_HOURS} hours. If you didn't sign up, you can ignore this email.`,
        }),
    })
}

// short-lived sessions: a stolen token stops working within hours (JWT_EXPIRES_IN, default 12h)
const generateToken = user=>{
  return jwt.sign({id:user._id, role:user.role}, process.env.JWT_SECRET_KEY,
  {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  })

}

// what the browser keeps after login: just enough for the header and menus, no health or account details
const publicProfile = user => ({
    _id: user._id,
    name: user.name,
    email: user.email,
    photo: user.photo,
    gender: user.gender,
    ...(user.specialization && { specialization: user.specialization }),
})

export const register = async(req,res)=>{
    if (isDemoMode()) {
        return res.status(403).json({ success: false, message: DEMO_MESSAGES.signup })
    }

    const {email,password,name,role,photo} = req.body
    // empty string would fail the gender enum, so treat it as not provided
    const gender = req.body.gender || undefined

    if(!email || !password || !name){
        return res.status(400).json({success:false, message:'Name, email and password are required'})
    }
    const weakPassword = passwordProblem(password)
    if (weakPassword) {
        return res.status(400).json({ success: false, message: weakPassword })
    }
    if(!isAllowedPhoto(photo)){
        return res.status(400).json({success:false, message:'Profile photos must be uploaded through the site'})
    }
    if(role !== 'patient' && role !== 'doctor'){
        return res.status(400).json({success:false, message:'Role must be patient or doctor'})
    }
    // doctors must give their medical registration number so they can be verified before approval
    const registrationNumber = req.body.registrationNumber?.trim()
    if(role === 'doctor' && !registrationNumber){
        return res.status(400).json({success:false, message:'Medical registration number is required for doctors'})
    }

    try {
        // an email can only belong to one account, patient or doctor
        const user = await User.findOne({email}) || await Doctor.findOne({email})

        //check if user exist
        if(user){
            return res.status(400).json({message:'User already exist'})
        }
        if(role === 'doctor' && await Doctor.exists({registrationNumber})){
            return res.status(400).json({success:false, message:'This registration number is already in use'})
        }

        //hash password
        const salt = await bcrypt.genSalt(12)
        const hashedPassword = await bcrypt.hash(password, salt)

        //create new user
        const newUser = role === "doctor"
          ? new Doctor({ email, password: hashedPassword, name, photo, gender, role, registrationNumber, isApproved: "pending", emailVerified: false })
          : new User({ email, password: hashedPassword, name, photo, gender, role, emailVerified: false });
        //save user to database
        await newUser.save()
        // the account can log in once the emailed link is clicked
        let previewUrl
        try {
            ({ previewUrl } = await sendVerificationEmail(newUser))
        } catch (error) {
            logger.error('Verification email failed:', error.message)
        }
        const message = role === "doctor"
          ? 'Account created. Check your email to verify it, then we will review your registration number'
          : 'Account created. Check your email to verify it, then log in'
        res.status(201).json({ success: true, message, data: { previewUrl } }); // 201 for successful creation

    } catch (error) {
        logger.error('Register error:', error)
        res.status(500).json({ success: false, message: 'Failed to create the account' });
    }
}

export const login = async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email || typeof req.body.password !== 'string' || !req.body.password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }
  // the login form says whether this is a patient or a doctor; older clients don't send it
  const { role: loginAs } = req.body;
  if (loginAs && loginAs !== 'patient' && loginAs !== 'doctor') {
    return res.status(400).json({ success: false, message: "Role must be patient or doctor" });
  }
  try {
    let user;
    if (loginAs === 'doctor') {
      user = await Doctor.findOne({ email });
    } else if (loginAs === 'patient') {
      user = await User.findOne({ email });
    } else {
      user = await User.findOne({ email }) || await Doctor.findOne({ email });
    }
    // same answer (and roughly the same time) for an unknown email and a wrong password,
    // so the login form can't be used to find out who has an account
    const isPasswordMatch = await bcrypt.compare(req.body.password, user?.password || DUMMY_HASH);
    if (!user || !isPasswordMatch) {
      return res.status(400).json({ success: false, message: "Invalid email or password" });
    }

    // accounts created before email verification existed have no emailVerified field and stay usable
    if (user.emailVerified === false) {
      return res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email first, we sent you a link when you signed up' });
    }

    //get token
    const token = generateToken(user)

    res.status(200).json({ success: true, message: 'logged in successfully', token, data: publicProfile(user), role: user.role });
  } catch (error) {
    logger.error('Login error:', error.name)
    // say clearly when the database is the problem instead of a vague "Failed to login"
    const dbDown = /Mongo|Buffering|timed out/i.test(`${error.name} ${error.message}`)
    res.status(dbDown ? 503 : 500).json({
      success: false,
      message: dbDown ? 'Server cannot reach the database right now, please try again later' : 'Failed to login',
    })
  }
};

// POST /auth/verify-email  body: { token }  (the link from the email)
export const verifyEmail = async (req, res) => {
    try {
        const account = await findByToken('emailVerifyTokenHash', 'emailVerifyExpires', req.body.token)
        if (!account) {
            return res.status(400).json({ success: false, message: 'This link is invalid or has expired. Ask for a new one below' })
        }
        account.emailVerified = true
        account.emailVerifyTokenHash = undefined
        account.emailVerifyExpires = undefined
        await account.save()
        res.status(200).json({ success: true, message: 'Email verified, you can log in now' })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not verify the email' })
    }
}

// POST /auth/resend-verification  body: { email }
export const resendVerification = async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : ''
    if (!email) {
        return res.status(400).json({ success: false, message: 'Please enter your email' })
    }
    try {
        const account = await findAccount(email)
        let previewUrl
        if (account && account.emailVerified === false) {
            ({ previewUrl } = await sendVerificationEmail(account))
        }
        // same answer whether or not the account exists
        res.status(200).json({ success: true, message: 'If that account still needs verifying, a new link is on its way', data: { previewUrl } })
    } catch (error) {
        logger.error('Resend verification error:', error.message)
        res.status(500).json({ success: false, message: 'Could not send the email, please try again' })
    }
}
