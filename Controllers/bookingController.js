import User from '../models/UserSchema.js'
import Doctor from '../models/DoctorSchema.js'
import Booking from '../models/BookingSchema.js'
import Stripe from 'stripe'
import {
    CANCEL_CUTOFF_MINUTES,
    STRIPE_SESSION_MINUTES,
    isSlotTakenError,
    makeSlotKey,
    minutesUntil,
    releaseExpiredHold,
    validateSlot,
} from '../utils/slots.js'
import { checkCallAccess, formatDoctorName } from '../utils/video.js'
import { CONSULTATION_TYPES, ONLINE_TYPES, feeFor, minutesFor, typeLabel } from '../utils/consultation.js'
import { appointmentEpoch } from '../utils/slots.js'
import { getIO, personRoom } from '../socket/io.js'
import { cleanText } from '../utils/text.js'
import logger from '../utils/logger.js'
import { siteUrl } from '../utils/site.js'

// live update for whoever is online (dashboards refresh, a toast appears)
const notify = (role, id, payload) => getIO()?.to(personRoom(role, id)).emit('booking:updated', payload)

// the doctor gets the new request as soon as it is paid
const announceRequest = booking =>
    notify('doctor', booking.doctor, { bookingId: String(booking._id), status: 'pending', message: `New ${typeLabel(booking.consultationType).toLowerCase()} request for ${booking.appointmentDate} at ${booking.appointmentTime}` })

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY)

const SLOT_TAKEN_MESSAGE = "Sorry, this slot was just booked by someone else. Please pick another time"

// give a hold's slot back and mark it cancelled
const releaseHold = hold =>
    Booking.updateOne({ _id: hold._id }, { $unset: { slotKey: 1 }, $set: { status: 'cancelled' } })

// mark a hold as paid (the payment may have finished even if the browser never came back to us)
const markPaid = async (booking, paymentId) => {
    booking.isPaid = true
    booking.paymentIntent = paymentId
    booking.paymentMethod = 'card'
    await booking.save()
    announceRequest(booking)
    return booking
}

// was this unpaid hold paid after all? true when it has now been marked paid
const settleIfPaid = async (hold, stripe) => {
    if (!hold.session) return false
    try {
        // after this the old checkout page can no longer be paid
        await stripe.checkout.sessions.expire(hold.session)
        return false
    } catch (error) {
        // session is already completed or expired, check whether it was paid
        const session = await stripe.checkout.sessions.retrieve(hold.session)
        if (session.payment_status !== 'paid') return false
        await markPaid(hold, session.payment_intent)
        return true
    }
}

// when a patient starts a new checkout, drop their earlier unpaid holds so they don't block slots
const releaseOwnHolds = async (stripe, userId) => {
    const holds = await Booking.find({ user: userId, isPaid: false, slotKey: { $exists: true } })
    for (const hold of holds) {
        try {
            if (!(await settleIfPaid(hold, stripe))) await releaseHold(hold)
        } catch (error) {
            logger.error('Could not release hold', hold._id.toString(), error.message)
        }
    }
}

const createStripeSession = (stripe, { doctor, user, booking, date, time, ticketPrice, type }) =>
    stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode:'payment',
        // Stripe replaces {CHECKOUT_SESSION_ID} so the success page can verify the payment
        success_url: siteUrl('/checkout-success?session_id={CHECKOUT_SESSION_ID}'),
        cancel_url: siteUrl(`/doctors/${doctor.id}`),
        customer_email:user.email,
        client_reference_id:doctor.id,
        // the slot is only held for a limited time, so the payment page expires too
        expires_at: Math.floor(Date.now() / 1000) + STRIPE_SESSION_MINUTES * 60,
        // with test keys, tell visitors which card to use, right under the Pay button
        ...(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') && {
            custom_text: {
                submit: { message: 'Demo / test mode, no real money: use card 4242 4242 4242 4242, any future date (e.g. 12/34) and any CVC (e.g. 123). If it is declined, use 4000 0035 6000 0008 and click Complete on the bank screen.' },
            },
        }),
        metadata: { bookingId: booking.id, date, time },
        line_items: [
            {
                price_data: {
                    currency: 'inr',
                    product_data: {
                        name:`${typeLabel(type)} with ${doctor.name}`,
                        description: `${date} at ${time} · the doctor confirms your request, a decline is refunded in full`,
                        // Stripe needs a full https link to a photo it can download; the bundled portraits are site paths
                        ...(doctor.photo?.startsWith("https://") && { images: [doctor.photo] }),
                    },
                    unit_amount: Math.round(ticketPrice * 100), // Amount in paise (₹1 = 100 paise), must be an integer
                },
                quantity: 1,
            },
        ],
    })

// POST /bookings/checkout-session/:doctorId  body: { date, time, consultationType }
// holds the slot, then starts a Stripe Checkout session.
// Once paid the booking is a request: the doctor accepts it (confirmed) or declines it (refunded).
export const getCheckoutSession = async(req,res)=>{
    const { date, time } = req.body
    const type = req.body.consultationType
    if (!CONSULTATION_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: "Choose a clinic visit, video consultation or quick call" });
    }
    try {
        const doctor = await Doctor.findOne({ _id: req.params.doctorId, isApproved: 'approved' });
        const user = await User.findById(req.userId)

        if (!doctor || !user) {
            return res.status(404).json({ success: false, message: "Doctor or user not found" });
        }
        const ticketPrice = feeFor(doctor, type)
        if (!ticketPrice || ticketPrice <= 0) {
            return res.status(400).json({ success: false, message: "This doctor has not set a ticket price yet" });
        }
        const slotError = validateSlot(doctor, date, time)
        if (slotError) {
            return res.status(400).json({ success: false, message: slotError });
        }

        const stripeInstance = getStripe()
        const slotKey = makeSlotKey(doctor._id, date, time)
        await releaseOwnHolds(stripeInstance, user._id)
        await releaseExpiredHold(slotKey)

        // claim the slot first, the unique slotKey index rejects a second booking for the same slot
        let booking
        try {
            booking = await Booking.create({
                doctor: doctor._id,
                user: user._id,
                ticketPrice,
                appointmentDate: date,
                appointmentTime: time,
                slotDuration: minutesFor(doctor, type),
                consultationType: type,
                slotKey,
                paymentProvider: 'stripe',
                isPaid: false,
                status: 'pending',
            })
        } catch (error) {
            if (isSlotTakenError(error)) {
                return res.status(409).json({ success: false, message: SLOT_TAKEN_MESSAGE });
            }
            throw error
        }

        try {
            const session = await createStripeSession(stripeInstance, { doctor, user, booking, date, time, ticketPrice, type })
            booking.session = session.id
            await booking.save()
            res.status(200).json({ success: true, message: 'Checkout session created', session })
        } catch (error) {
            // payment page could not be created, give the slot back
            await Booking.deleteOne({ _id: booking._id })
            throw error
        }
    } catch (error) {
        logger.error('Checkout session error:', error.message)
        res.status(500).json({ success: false, message: "Error creating checkout session " });
    }
}

// called by the checkout-success page to confirm the payment with Stripe
export const verifyCheckoutSession = async(req,res)=>{
    try {
        const booking = await Booking.findOne({ session: req.params.sessionId, user: req.userId })
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }

        if (!booking.isPaid) {
            const session = await getStripe().checkout.sessions.retrieve(req.params.sessionId)
            if (session.payment_status !== 'paid') {
                return res.status(400).json({ success: false, message: "Payment not completed" });
            }
            await markPaid(booking, session.payment_intent)
        }

        res.status(200).json({ success: true, message: "Payment verified, appointment booked", data: booking });
    } catch (error) {
        res.status(500).json({ success: false, message: "Could not verify payment" });
    }
}

// find the booking and make sure the logged in patient/doctor is part of it
const findOwnBooking = async (req) => {
    const owner = req.role === 'doctor' ? { doctor: req.userId } : { user: req.userId }
    return Booking.findOne({ _id: req.params.id, ...owner, isPaid: true })
}

const getPaymentIntent = async (stripe, booking) => {
    if (booking.paymentIntent) return booking.paymentIntent
    if (!booking.session) return null
    try {
        const session = await stripe.checkout.sessions.retrieve(booking.session)
        return session.payment_intent
    } catch (error) {
        return null
    }
}

// give the money back through Stripe; returns the refund id (none for seeded demo bookings)
const refundBooking = async booking => {
    const stripe = getStripe()
    const paymentIntent = await getPaymentIntent(stripe, booking)
    if (!paymentIntent) return undefined
    const refund = await stripe.refunds.create({ payment_intent: paymentIntent })
    return refund.id
}

// PUT /bookings/:id/cancel  (patient or doctor)
export const cancelBooking = async(req,res)=>{
    try {
        const booking = await findOwnBooking(req)
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        if (booking.status === 'cancelled') {
            return res.status(400).json({ success: false, message: "This booking is already cancelled" });
        }

        const hasSlot = booking.appointmentDate && booking.appointmentTime
        const minutesLeft = hasSlot ? minutesUntil(booking.appointmentDate, booking.appointmentTime) : null
        if (hasSlot && minutesLeft <= 0) {
            return res.status(400).json({ success: false, message: "Past appointments can't be cancelled" });
        }
        // patients can only cancel (and get a refund) up to 2 hours before, after that they can reschedule;
        // a request the doctor hasn't accepted yet can be withdrawn any time
        if (req.role === 'patient' && booking.status !== 'pending' && hasSlot && minutesLeft < CANCEL_CUTOFF_MINUTES) {
            return res.status(400).json({ success: false, message: "Appointments can only be cancelled up to 2 hours before. You can still reschedule it" });
        }

        // refund the payment through whoever took it
        const refundId = await refundBooking(booking)

        await Booking.updateOne(
            { _id: booking._id },
            {
                $set: { status: 'cancelled', cancelledBy: req.role, ...(refundId && { refundId }) },
                $unset: { slotKey: 1 },
            }
        )

        const message = refundId
            ? "Appointment cancelled, the payment will be refunded in 5-10 days"
            : "Appointment cancelled"
        // tell the other side
        if (req.role === 'doctor') notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: 'Your doctor cancelled an appointment, the payment is being refunded' })
        else notify('doctor', booking.doctor, { bookingId: String(booking._id), status: 'cancelled', message: `A patient cancelled the ${booking.appointmentDate} ${booking.appointmentTime} appointment` })
        res.status(200).json({ success: true, message });
    } catch (error) {
        logger.error('Cancel booking error:', error.message)
        res.status(500).json({ success: false, message: "Could not cancel the booking" });
    }
}

// PUT /bookings/:id/reschedule  (patient only) body: { date, time }
export const rescheduleBooking = async(req,res)=>{
    const { date, time } = req.body
    try {
        const booking = await findOwnBooking(req)
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        if (booking.status === 'cancelled') {
            return res.status(400).json({ success: false, message: "Cancelled bookings can't be rescheduled" });
        }
        if (booking.appointmentDate && booking.appointmentTime && minutesUntil(booking.appointmentDate, booking.appointmentTime) <= 0) {
            return res.status(400).json({ success: false, message: "Past appointments can't be rescheduled" });
        }

        const doctor = await Doctor.findById(booking.doctor)
        if (!doctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        const slotError = validateSlot(doctor, date, time)
        if (slotError) {
            return res.status(400).json({ success: false, message: slotError });
        }

        const slotKey = makeSlotKey(doctor._id, date, time)
        if (slotKey === booking.slotKey) {
            return res.status(400).json({ success: false, message: "Your appointment is already at this time" });
        }
        await releaseExpiredHold(slotKey)

        // moving the slotKey releases the old slot and claims the new one in one step
        try {
            await Booking.updateOne(
                { _id: booking._id },
                { $set: { appointmentDate: date, appointmentTime: time, slotKey, slotDuration: minutesFor(doctor, booking.consultationType), status: 'pending' } }
            )
        } catch (error) {
            if (isSlotTakenError(error)) {
                return res.status(409).json({ success: false, message: SLOT_TAKEN_MESSAGE });
            }
            throw error
        }

        notify('doctor', booking.doctor, { bookingId: String(booking._id), status: 'pending', message: `A patient moved their appointment to ${date} at ${time}, please confirm it` })
        res.status(200).json({ success: true, message: "Appointment moved, the doctor will confirm the new time" });
    } catch (error) {
        logger.error('Reschedule booking error:', error.message)
        res.status(500).json({ success: false, message: "Could not reschedule the booking" });
    }
}

// GET /bookings/:id/video  (patient or doctor of the booking)
// tells the call page whether the call is open and who is in it; the call itself runs over Socket.io + WebRTC
export const getVideoSession = async(req,res)=>{
    try {
        const { booking, window, error } = await checkCallAccess({ bookingId: req.params.id, userId: req.userId, role: req.role })
        if (error) {
            return res.status(error.status).json({ success: false, code: error.code, message: error.message, data: error.data });
        }

        const [doctor, patient] = await Promise.all([
            Doctor.findById(booking.doctor).select('name photo'),
            User.findById(booking.user).select('name photo'),
        ])

        res.status(200).json({
            success: true,
            message: "Video call ready",
            data: {
                ...window,
                doctorName: formatDoctorName(doctor?.name),
                doctorPhoto: doctor?.photo,
                patientName: patient?.name || 'Patient',
                patientId: booking.user,
                consultationType: booking.consultationType,
                patientPhoto: patient?.photo,
                appointmentDate: booking.appointmentDate,
                appointmentTime: booking.appointmentTime,
                slotDuration: booking.slotDuration || 30,
                extendedMinutes: booking.extendedMinutes || 0,
            },
        });
    } catch (error) {
        logger.error('Video session error:', error.message)
        res.status(500).json({ success: false, message: "Could not start the video call, please try again" });
    }
}

// PUT /bookings/:id/respond  (doctor) body: { action: "accept" | "decline", reason }
export const respondToBooking = async(req,res)=>{
    const { action } = req.body
    if (action !== 'accept' && action !== 'decline') {
        return res.status(400).json({ success: false, message: "Accept or decline the request" });
    }
    const reason = cleanText(req.body.reason).slice(0, 300)
    if (action === 'decline' && !reason) {
        return res.status(400).json({ success: false, message: "Tell the patient why, it helps them book someone else" });
    }
    try {
        const booking = await Booking.findOne({ _id: req.params.id, doctor: req.userId, isPaid: true })
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        if (booking.status !== 'pending') {
            return res.status(400).json({ success: false, message: "This request was already answered" });
        }
        if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) <= Date.now()) {
            return res.status(400).json({ success: false, message: "This request has expired, the time has passed" });
        }

        if (action === 'accept') {
            // only flip it if it is still a request (two tabs clicking at once)
            const updated = await Booking.findOneAndUpdate(
                { _id: booking._id, status: 'pending' },
                { $set: { status: 'approved', respondedAt: new Date() } },
                { new: true }
            )
            if (!updated) return res.status(409).json({ success: false, message: "This request was already answered" });
            const online = ONLINE_TYPES.includes(updated.consultationType)
            notify('patient', updated.user, {
                bookingId: String(updated._id),
                status: 'approved',
                message: `Your ${typeLabel(updated.consultationType).toLowerCase()} on ${updated.appointmentDate} at ${updated.appointmentTime} is confirmed${online ? ', the video room opens 10 minutes before' : ''}`,
            })
            return res.status(200).json({ success: true, message: "Request accepted, the patient has been told", data: updated });
        }

        const refundId = await refundBooking(booking)
        const declined = await Booking.findOneAndUpdate(
            { _id: booking._id, status: 'pending' },
            {
                $set: { status: 'cancelled', cancelledBy: 'doctor', declineReason: reason, respondedAt: new Date(), ...(refundId && { refundId }) },
                $unset: { slotKey: 1 },
            },
            { new: true }
        )
        if (!declined) return res.status(409).json({ success: false, message: "This request was already answered" });
        notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: `Your request was declined: ${reason}. The payment is being refunded` })
        res.status(200).json({ success: true, message: "Request declined and refunded", data: declined });
    } catch (error) {
        logger.error('Respond to booking error:', error.message)
        res.status(500).json({ success: false, message: "Could not update the request" });
    }
}

// requests the doctor never answered are cancelled and refunded once their time has passed
export const expireUnansweredRequests = async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.CLINIC_TIMEZONE || 'Asia/Kolkata' })
    const candidates = await Booking.find({ isPaid: true, status: 'pending', appointmentDate: { $lte: today } })
    for (const booking of candidates) {
        if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) > Date.now()) continue
        try {
            const refundId = await refundBooking(booking)
            await Booking.updateOne(
                { _id: booking._id, status: 'pending' },
                { $set: { status: 'cancelled', cancelledBy: 'system', declineReason: 'The doctor did not confirm in time', ...(refundId && { refundId }) }, $unset: { slotKey: 1 } }
            )
            notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: 'Your doctor did not confirm the request in time, so it was cancelled and refunded' })
        } catch (error) {
            logger.error('Could not expire request', String(booking._id), error.message)
        }
    }
}

// bookings made before visit types and doctor confirmation existed: confirmed video consultations
export const migrateOldBookings = async () => {
    await Booking.updateMany({ consultationType: { $exists: false }, isPaid: true, status: 'pending' }, { $set: { status: 'approved' } })
    await Booking.updateMany({ consultationType: { $exists: false } }, { $set: { consultationType: 'video' } })
}

// the doctor took time off: their paid requests and appointments on those days are cancelled and refunded,
// and unpaid holds there are released. Returns how many patients were affected.
export const bookingsInTimeOff = (doctorId, from, to) =>
    Booking.find({ doctor: doctorId, isPaid: true, status: { $in: ['pending', 'approved'] }, appointmentDate: { $gte: from, $lte: to } })

export const cancelForTimeOff = async (doctorId, from, to) => {
    const bookings = await bookingsInTimeOff(doctorId, from, to)
    let cancelled = 0
    for (const booking of bookings) {
        // appointments that already started are left alone
        if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) <= Date.now()) continue
        try {
            const refundId = await refundBooking(booking)
            const updated = await Booking.updateOne(
                { _id: booking._id, status: { $in: ['pending', 'approved'] } },
                {
                    $set: { status: 'cancelled', cancelledBy: 'doctor', declineReason: 'The doctor is on leave that day', respondedAt: new Date(), ...(refundId && { refundId }) },
                    $unset: { slotKey: 1 },
                }
            )
            if (updated.modifiedCount === 0) continue
            cancelled++
            notify('patient', booking.user, {
                bookingId: String(booking._id),
                status: 'cancelled',
                message: `Your doctor is on leave on ${booking.appointmentDate}, so the appointment was cancelled and the payment is being refunded`,
            })
        } catch (error) {
            logger.error('Time off cancel error:', String(booking._id), error.message)
        }
    }
    await Booking.updateMany(
        { doctor: doctorId, isPaid: false, slotKey: { $exists: true }, appointmentDate: { $gte: from, $lte: to } },
        { $unset: { slotKey: 1 }, $set: { status: 'cancelled' } }
    )
    return cancelled
}
