# Health Mate Backend

Health Mate is a comprehensive healthcare application designed to help users manage their health and medical appointments effectively. The backend is built using Node.js, Express, and MongoDB, providing a robust API for user authentication with JWT, data management, and payment integrations via Stripe.

## Getting Started

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Create a `.env` file in the root directory based on the sample below.
4. Run `npm start` or `npm run start-dev` (auto-restart with nodemon) to start the server.

## Sample Environment Variables

Create a `.env` file in the root directory and add the following variables:

```env
PORT=5000
MONGODB_URL=your mongo db connection string
JWT_SECRET_KEY=your_jwt_secret_key_here
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
CLIENT_SITE_URL=http://localhost:5173 # the website allowed to call the API (comma separated for several)
NODE_ENV=production                  # on the live server: only CLIENT_SITE_URL may call the API
TRUST_PROXY=1                        # on Render/Railway etc., so rate limits see the visitor's real IP
CLINIC_TIMEZONE=Asia/Kolkata         # optional
# Emails (verify email). Leave these out to use a free Ethereal test inbox:
# nothing reaches real inboxes and the website shows an "Open the email" link instead.
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=465
# SMTP_USER=you@gmail.com
# SMTP_PASS=your-16-letter-app-password
# MAIL_FROM=Medora <you@gmail.com>
ALLOW_SIGNUPS=false                  # portfolio demo: sign-ups closed, demo accounts protected (set true to open)
DEMO_AUTO_RESET=true                 # optional: reset the demo data every DEMO_RESET_HOURS (deletes what visitors created)
DEMO_RESET_HOURS=6                   # optional, default 6
JWT_EXPIRES_IN=12h                   # optional, how long a login lasts (default 12h)
CLOUDINARY_CLOUD_NAME=your-cloud     # optional: only accept profile photos from this Cloudinary account
CLOUDINARY_PHOTO_FOLDER=medora/avatars  # optional: ...and only from this folder (the upload preset's public ID path)
GEMINI_API_KEY=your_gemini_key      # optional: AI symptom checker (free key from aistudio.google.com); without it a rules guide answers
GEMINI_MODELS=gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash  # optional: models to try, fastest first
AI_DAILY_LIMIT=200                  # optional: AI symptom checks per day for the whole site (then the rules guide answers)
AI_PER_PERSON_DAILY=20              # optional: AI symptom checks per day per account + network
TURN_URLS=turn:...,turns:...        # optional: TURN relay for video calls across networks (e.g. a free Metered.ca account)
TURN_USERNAME=...                   #           its username and credential, only given to logged-in users
TURN_CREDENTIAL=...
DEBUG_LOGS=true                      # optional: print server errors (the server logs nothing by default)
```

## Security

- Sign-ups are closed in the demo; demo accounts can't change password, be deleted, or change the name, photo
  and public profile text other visitors see. The demo admin only sees demo data and can only act on the sample applications.
- Logins are rate limited per network and per account, tokens expire after 12 hours and only HS256 is accepted.
- Every editable field is whitelisted and validated; MongoDB operators in requests are stripped; bodies over 100 KB are refused.
- Only `CLIENT_SITE_URL` may call the API from a browser in production; security headers come from helmet.
- Medical files are stored in MongoDB (GridFS) and only served to the owner, their doctors or admins.
- The frontend build ships a Content Security Policy and no console output; `vercel.json` adds hosting headers.
  Set `VITE_API_URL` (the live API address) before building the frontend.

## Demo data

`npm run seed` creates (or resets) the demo accounts, all with the password `Medora#Demo26`:

- `admin@healthmate.test`: admin panel (doctor verification, patients, bookings, revenue)
- `patient@healthmate.test`: patient with past visits, prescriptions, a health record and a conversation
- `doctor@healthmate.test` and more listed doctors
- testing doctors open 24/7 in 15 minute slots (`riya.sen@`, `kabir.anand@`, `zoya.khan@healthmate.test`), so the
  whole flow (book, doctor accepts, video call) can be tried within minutes
- three pending doctor applications for the admin to approve or reject

Stripe test payments: card `4242 4242 4242 4242` with any future expiry (e.g. 12/34) and any CVC.
