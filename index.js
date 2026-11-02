import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import authRoute from './Routes/auth.js'
import userRoute from './Routes/user.js'
import doctorRoute from './Routes/doctor.js'
import reviewRoute from './Routes/review.js'
import bookingRoute from './Routes/booking.js'
import adminRoute from './Routes/admin.js'
import prescriptionRoute from './Routes/prescription.js'
import messageRoute from './Routes/message.js'
import documentRoute from './Routes/document.js'
import symptomRoute from './Routes/symptom.js'
import { expireUnansweredRequests, migrateOldBookings } from './Controllers/bookingController.js'
import { initCallSocket } from './socket/callSocket.js'
import helmet from 'helmet'
import { isDemoMode } from './utils/demo.js'
import { nextResetAt, scheduleDemoReset } from './demo/resetDemo.js'

const autoResetOn = () => isDemoMode() && process.env.DEMO_AUTO_RESET === 'true'
import { apiLimiter, corsOrigin, sanitizeInput } from './middleware/security.js'
import logger from './utils/logger.js'
import { authenticate } from './auth/verifyToken.js'




dotenv.config();
// without a secret every token could be forged, so refuse to start
if (!process.env.JWT_SECRET_KEY || process.env.JWT_SECRET_KEY.length < 16) {
  console.error('JWT_SECRET_KEY is missing or too short (use at least 16 random characters)');
  process.exit(1);
}
const app = express();
const port = process.env.PORT || 8000;

// only our own website may call the API from a browser
const corsOptions = {
  origin: corsOrigin,
};

// behind a hosting proxy (Render, Railway...) the real visitor IP is in X-Forwarded-For; needed for rate limits
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

// Database connection
mongoose.set("strictQuery", false);
// Database connection
// mongoose does not retry a failed first connection, so keep trying every 5 seconds
// (otherwise a short database outage at startup leaves the server broken until restarted)
const connectDB = async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URL, { serverSelectionTimeoutMS: 10000 });
      logger.info("MongoDB database is Connected");
    } catch (error) {
      logger.error(`MongoDB connect failed (${error.name}), retrying in 5 seconds...`);
      setTimeout(connectDB, 5000);
    }
  };
  


// Middleware
// security headers (no MIME sniffing, no framing, hides "X-Powered-By: Express"...);
// files are fetched by the website on another port/domain, so allow cross-origin reads of responses
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));
app.use(sanitizeInput);
app.use('/api', apiLimiter);
app.use('/api/v1/auth',authRoute)// domain/api/v1/auth/register
app.use('/api/v1/users',userRoute)// domain/api/v1/user/getuser
app.use('/api/v1/doctors',doctorRoute)// domain/api/v1/doctors/getdo
app.use('/api/v1/reviews',reviewRoute)// domain/api/v1/reviews/getreviews
app.use('/api/v1/bookings',bookingRoute)// domain/api/v1/bookings/getbook
app.use('/api/v1/admin',adminRoute)
app.use('/api/v1/prescriptions',prescriptionRoute)
app.use('/api/v1/messages',messageRoute)
app.use('/api/v1/documents',documentRoute)
app.use('/api/v1/symptom-check',symptomRoute)
// tells the website, in the demo, when the demo data resets next
app.get('/api/v1/config', (req, res) => {
  res.json({
    success: true,
    data: {
      ...(autoResetOn() && { demoResetAt: nextResetAt() }),
    },
  })
})

// how the two browsers of a video call reach each other: free STUN, plus a TURN relay when one is set up
// (TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL). Calls between different networks (office Wi-Fi, mobile data)
// often need the relay. Only logged-in users get its login, so it isn't public in the website's code.
app.get('/api/v1/ice-servers', authenticate, (req, res) => {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  const turnUrls = (process.env.TURN_URLS || '').split(',').map(url => url.trim()).filter(url => /^turns?:/.test(url))
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL })
  }
  res.set('Cache-Control', 'no-store').json({ success: true, data: servers })
})

// unknown API routes: a plain JSON 404 (no framework error page)
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Fallback error handler so an unexpected error returns a clean message instead of hanging the request
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: "Request is too large" });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: "Invalid JSON" });
  }
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? "Files can be at most 5 MB" : "Upload one file at a time";
    return res.status(400).json({ success: false, message });
  }
  logger.error(err);
  res.status(500).json({ success: false, message: "Something went wrong" });
});

// one HTTP server for both the REST API and the Socket.io video-call signaling
const server = createServer(app);
initCallSocket(server);

// Connect to the database first, then start the server
connectDB().then(async () => {
  await migrateOldBookings().catch(error => logger.error('Booking migration failed:', error.message));
  // every 5 minutes: cancel and refund requests the doctor never answered
  setInterval(() => expireUnansweredRequests().catch(error => logger.error('Request expiry failed:', error.message)), 5 * 60 * 1000);
  // portfolio demo: put the demo data back every few hours, whatever visitors did with it.
  // Off unless DEMO_AUTO_RESET=true, because it deletes what visitors created in the database.
  if (autoResetOn()) scheduleDemoReset(error => logger.error('Demo reset failed:', error));
  server.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
  });
});
