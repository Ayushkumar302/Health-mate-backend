# Health Mate Backend

Health Mate is a comprehensive healthcare application designed to help users manage their health and medical appointments effectively. The backend is built using Node.js, Express, and MongoDB, providing a robust API for user authentication with JWT, data management, and payment integrations via Stripe.

## Getting Started

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Create a `.env` file in the root directory based on the sample below.
4. Run `npm run start` or `npm run dev` to start the server.

## Sample Environment Variables

Create a `.env` file in the root directory and add the following variables:

```env
PORT=5000
MONGODB_URL=your mongo db connection string
JWT_SECRET_KEY=your_jwt_secret_key_here
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
CLIENT_SITE_URL=http://localhost:5173
```
