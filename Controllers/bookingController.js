import User from '../models/UserSchema.js'
import Doctor from '../models/DoctorSchema.js'
import Booking from '../models/BookingSchema.js'
import Stripe from 'stripe'
import {
    STRIPE_SESSION_MINUTES,
    clinicToday,
    isSlotTakenError,
    makeSlotKey,
    minutesUntil,
    releaseExpiredHold,
    validateSlot,
} from '../utils/slots.js'
import { checkCallAccess, formatDoctorName, getCallWindow } from '../utils/video.js'
import { doctorSharePaise, formatRupees, refundPaise, refundShareFor } from '../utils/earnings.js'
import { bookingWindowFor, commissionRateFor, confirmsInstantly } from '../utils/plans.js'
import { maxReschedulesFor, patientTier, patientTierOf } from '../utils/plus.js'
import { addNotification } from '../utils/notifications.js'
import { CONSULTATION_TYPES, ONLINE_TYPES, feeFor, minutesFor, typeLabel } from '../utils/consultation.js'
import { appointmentEpoch } from '../utils/slots.js'
import { getIO, personRoom } from '../socket/io.js'
import { cleanText } from '../utils/text.js'
import logger from '../utils/logger.js'
import { siteUrl } from '../utils/site.js'
import { LISTED } from '../utils/onboarding.js'
import { checkWaitlist } from './waitlistController.js'
import { receiptPdf } from '../utils/receipts.js'

const TITLES = {
    doctor: { pending: 'New booking request', approved: 'Booking confirmed', cancelled: 'Appointment cancelled' },
    patient: { pending: 'Booking update', approved: 'Appointment confirmed', cancelled: 'Appointment cancelled' },
}
const LINKS = { doctor: '/doctors/profile/me?appointments', patient: '/users/profile/me' }

// live update for whoever is online (dashboards refresh, a toast appears), also kept in their notification centre
const notify = (role, id, { title, ...payload }) => {
    getIO()?.to(personRoom(role, id)).emit('booking:updated', payload)
    addNotification(role, id, { kind: 'booking', title: title || TITLES[role]?.[payload.status] || 'Appointment update', text: payload.message, link: LINKS[role] })
}

// the patient's membership decides their refund and how often they can move an appointment
const patientOf = userId => User.findById(userId).select('plus')

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
    // a doctor with instant booking doesn't accept each request: it is confirmed straight away
    if (booking.instant) {
        booking.status = 'approved'
        booking.respondedAt = new Date()
    }
    await booking.save()
    if (booking.instant) {
        notify('doctor', booking.doctor, { title: 'New confirmed booking', bookingId: String(booking._id), status: 'approved', message: `New confirmed ${typeLabel(booking.consultationType).toLowerCase()} on ${booking.appointmentDate} at ${booking.appointmentTime} (instant booking)` })
    } else {
        announceRequest(booking)
    }
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

const createStripeSession = (stripe, { doctor, user, booking, date, time, ticketPrice, type, cancelPath }) =>
    stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode:'payment',
        // Stripe Connect: the doctor's share goes straight to their payout account, the commission stays with the platform.
        // The doctor's share is worked out on their full fee, so a Plus Family discount only lowers the platform's part.
        ...(booking.payoutAccount && {
            payment_intent_data: {
                application_fee_amount: Math.max(0, Math.round(ticketPrice * 100) - doctorSharePaise(booking.listPrice || ticketPrice, booking.commissionRate)),
                transfer_data: { destination: booking.payoutAccount },
            },
        }),
        // Stripe replaces {CHECKOUT_SESSION_ID} so the success page can verify the payment
        success_url: siteUrl('/checkout-success?session_id={CHECKOUT_SESSION_ID}'),
        // back to where the patient started: the doctor's page, or the booking assistant
        cancel_url: siteUrl(cancelPath || `/doctors/${doctor.id}`),
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
                        name:`${typeLabel(type)} with ${doctor.name}${booking.familyMember?.name ? ` for ${booking.familyMember.name}` : ''}`,
                        description: `${date} at ${time}${booking.familyDiscount ? ` · Plus Family: ${formatRupees(booking.familyDiscount)} off the ${formatRupees(booking.listPrice)} fee` : ''} · the doctor confirms your request, a decline is refunded in full`,
                        // Stripe needs a full https link to a photo it can download; the bundled portraits are site paths
                        ...(doctor.photo?.startsWith("https://") && { images: [doctor.photo] }),
                    },
                    unit_amount: Math.round(ticketPrice * 100), // Amount in paise (₹1 = 100 paise), must be an integer
                },
                quantity: 1,
            },
        ],
    })

// who the visit is for and what it costs: Plus Family members can book for a family member, and every visit
// on that plan is cheaper (the discount is paid by Medora, the doctor is still paid on the full fee).
// Returns { familyMember, ticketPrice, listPrice, familyDiscount } or { error }.
export const pricingFor = (user, listPrice, memberId) => {
    const tier = patientTier(user)
    let familyMember
    if (memberId) {
        if (!(tier.familyMembers > 0)) return { error: 'Booking for a family member needs Plus Family' }
        const member = (user.family || []).find(item => String(item._id) === String(memberId))
        if (!member) return { error: 'Family member not found' }
        familyMember = { _id: member._id, name: member.name, relation: member.relation }
    }
    const familyDiscount = Math.round(listPrice * (tier.consultDiscount || 0) * 100) / 100
    if (familyDiscount <= 0) return { familyMember, ticketPrice: listPrice }
    return { familyMember, ticketPrice: Math.round((listPrice - familyDiscount) * 100) / 100, listPrice, familyDiscount }
}

// POST /bookings/checkout-session/:doctorId  body: { date, time, consultationType, memberId?, from? }
// (from: "assistant" when booked from the booking assistant, so a cancelled payment goes back there)
// holds the slot, then starts a Stripe Checkout session.
// Once paid the booking is a request: the doctor accepts it (confirmed) or declines it (refunded).
export const getCheckoutSession = async(req,res)=>{
    const { date, time } = req.body
    const type = req.body.consultationType
    if (!CONSULTATION_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: "Choose a clinic visit, video consultation or quick call" });
    }
    try {
        const doctor = await Doctor.findOne({ _id: req.params.doctorId, ...LISTED }).select('+stripeAccountId');
        const user = await User.findById(req.userId)

        if (!doctor || !user) {
            return res.status(404).json({ success: false, message: "Doctor or user not found" });
        }
        const fee = feeFor(doctor, type)
        if (!fee || fee <= 0) {
            return res.status(400).json({ success: false, message: "This doctor has not set a ticket price yet" });
        }
        const pricing = pricingFor(user, fee, req.body.memberId)
        if (pricing.error) {
            return res.status(400).json({ success: false, message: pricing.error });
        }
        const { ticketPrice } = pricing
        const slotError = validateSlot(doctor, date, time, bookingWindowFor(doctor), type)
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
                ...(pricing.familyDiscount && { listPrice: pricing.listPrice, familyDiscount: pricing.familyDiscount }),
                ...(pricing.familyMember && { familyMember: pricing.familyMember }),
                appointmentDate: date,
                appointmentTime: time,
                slotDuration: minutesFor(doctor, type),
                consultationType: type,
                slotKey,
                paymentProvider: 'stripe',
                isPaid: false,
                status: 'pending',
                // the doctor's plan when the booking is made decides the commission, later plan changes don't
                commissionRate: commissionRateFor(doctor),
                ...(confirmsInstantly(doctor) && { instant: true }),
                // doctors without a finished payout account still get bookings; the platform holds their share
                ...(doctor.payoutsEnabled && doctor.stripeAccountId && { payoutAccount: doctor.stripeAccountId }),
                joinsTracked: ONLINE_TYPES.includes(type),
            })
        } catch (error) {
            if (isSlotTakenError(error)) {
                return res.status(409).json({ success: false, message: SLOT_TAKEN_MESSAGE });
            }
            throw error
        }

        try {
            const cancelPath = req.body.from === 'assistant' ? '/book' : undefined
            const session = await createStripeSession(stripeInstance, { doctor, user, booking, date, time, ticketPrice, type, cancelPath })
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

// give `share` of the payment back through Stripe; returns { refundId, refundedAmount, refundCovered } in rupees.
// `normalShare` is what the standard rules give back: a Medora Plus member gets more, and that extra is paid
// by the platform, so the doctor's part comes back only as it would without Plus.
// (seeded demo bookings were never really paid: only the amounts are recorded)
const refundBooking = async (booking, share = 1, normalShare = share) => {
    const amount = refundPaise(booking, share)
    const normal = Math.min(amount, refundPaise(booking, normalShare))
    const refundedAmount = amount / 100
    const covered = (amount - normal) / 100
    const coveredField = covered > 0 ? { refundCovered: covered } : {}
    if (amount <= 0) return { refundedAmount: 0 }
    const stripe = getStripe()
    const paymentIntent = await getPaymentIntent(stripe, booking)
    if (!paymentIntent) return { refundedAmount, ...coveredField }
    if (booking.payoutAccount && covered > 0) {
        // the patient gets everything from the platform's balance...
        const refund = await stripe.refunds.create({ payment_intent: paymentIntent, ...(share < 1 && { amount }) })
        // ...and only the standard refund is taken back from the doctor, with the commission on it returned in proportion
        if (normal > 0) {
            try {
                const intent = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge.transfer'] })
                const transfer = intent.latest_charge?.transfer
                // the transfer can be in another currency (the doctor's payout currency), so reverse the same
                // fraction of it that the standard refund is of the payment, like Stripe's reverse_transfer does
                const reverse = transfer && Math.round((transfer.amount * normal) / intent.amount)
                if (reverse > 0) await stripe.transfers.createReversal(transfer.id, { amount: Math.min(reverse, transfer.amount - transfer.amount_reversed), refund_application_fee: true })
            } catch (error) {
                logger.error('Transfer reversal failed', String(booking._id), error.message)
            }
        }
        return { refundId: refund.id, refundedAmount, ...coveredField }
    }
    const refund = await stripe.refunds.create({
        payment_intent: paymentIntent,
        ...(share < 1 && { amount }),
        // the doctor's part comes back from their payout account and the commission is returned in proportion,
        // so whatever is kept (a cancellation fee) is still split the same way
        ...(booking.payoutAccount && { reverse_transfer: true, refund_application_fee: true }),
    })
    return { refundId: refund.id, refundedAmount, ...coveredField }
}

const refundFields = ({ refundId, refundedAmount, refundCovered }) => ({ refundedAmount, ...(refundId && { refundId }), ...(refundCovered && { refundCovered }) })

// GET /bookings/:id/receipt  (patient) the payment receipt of a paid booking, as a PDF
export const getReceipt = async(req,res)=>{
    try {
        const booking = await findOwnBooking(req)
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        const [doctor, patient] = await Promise.all([
            Doctor.findById(booking.doctor).select('name specialization registrationNumber'),
            User.findById(booking.user).select('name'),
        ])
        const pdf = receiptPdf({ booking, doctor, patient })
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdf.length,
            'Content-Disposition': `attachment; filename="medora-receipt-${String(booking._id).slice(-8)}.pdf"`,
            'Cache-Control': 'private, no-store',
        })
        res.send(pdf)
    } catch (error) {
        logger.error('Receipt error:', error.message)
        res.status(500).json({ success: false, message: "Could not make the receipt" });
    }
}

// GET /bookings/:id/refund-quote  (patient) what they would get back if they cancelled now
export const getRefundQuote = async(req,res)=>{
    try {
        const booking = await findOwnBooking(req)
        if (!booking || booking.status === 'cancelled') {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        const tier = patientTierOf(await patientOf(req.userId))
        const share = refundShareFor(booking, 'patient', { tier })
        const refund = refundPaise(booking, share) / 100
        // how much of it is thanks to Medora Plus
        const plusExtra = Math.round((refund - refundPaise(booking, refundShareFor(booking, 'patient')) / 100) * 100) / 100
        res.status(200).json({ success: true, data: { share, refund, fee: Math.round((booking.ticketPrice - refund) * 100) / 100, plus: tier !== 'free', tier, plusExtra } });
    } catch (error) {
        res.status(500).json({ success: false, message: "Could not work out the refund" });
    }
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

        // a doctor cancelling refunds everything; a patient pays a cancellation fee once the doctor has accepted
        // (smaller for Medora Plus members, the platform pays the difference)
        const tier = req.role === 'patient' ? patientTierOf(await patientOf(req.userId)) : 'free'
        const share = refundShareFor(booking, req.role, { tier })
        const refund = await refundBooking(booking, share, refundShareFor(booking, req.role))

        await Booking.updateOne(
            { _id: booking._id },
            {
                $set: { status: 'cancelled', cancelledBy: req.role, ...refundFields(refund), ...(req.role === 'doctor' && booking.status === 'approved' && { doctorFault: true }) },
                $unset: { slotKey: 1 },
            }
        )

        const fee = booking.ticketPrice - refund.refundedAmount
        const plusNote = refund.refundCovered ? ` Your membership added ${formatRupees(refund.refundCovered)}.` : ''
        const message = share === 1
            ? `Appointment cancelled, the full payment will be refunded in 5-10 days.${plusNote}`
            : `Appointment cancelled, ${formatRupees(refund.refundedAmount)} will be refunded in 5-10 days (${formatRupees(fee)} cancellation fee).${plusNote}`
        // tell the other side
        if (req.role === 'doctor') notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: 'Your doctor cancelled an appointment, the payment is being refunded' })
        else notify('doctor', booking.doctor, { bookingId: String(booking._id), status: 'cancelled', message: `A patient cancelled the ${booking.appointmentDate} ${booking.appointmentTime} appointment` })
        // the slot is free again: tell people on the waitlist for that day
        checkWaitlist(booking.doctor, booking.appointmentDate)
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
        // one move per appointment, as many as needed for Medora Plus members
        const maxMoves = maxReschedulesFor(await patientOf(req.userId))
        const movedTooOften = maxMoves === 1
            ? "You've already moved this appointment once. You can still cancel it, or move it more often with a Medora Plus plan"
            : `You've already moved this appointment ${maxMoves} times. You can still cancel it, or move it as often as you need with Medora Plus`
        if ((booking.rescheduleCount || 0) >= maxMoves) {
            return res.status(400).json({ success: false, message: movedTooOften });
        }

        const doctor = await Doctor.findById(booking.doctor)
        if (!doctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        const slotError = validateSlot(doctor, date, time, bookingWindowFor(doctor), booking.consultationType)
        if (slotError) {
            return res.status(400).json({ success: false, message: slotError });
        }
        // a doctor with instant booking confirms the new time straight away too
        const instant = confirmsInstantly(doctor)

        const slotKey = makeSlotKey(doctor._id, date, time)
        if (slotKey === booking.slotKey) {
            return res.status(400).json({ success: false, message: "Your appointment is already at this time" });
        }
        await releaseExpiredHold(slotKey)

        // moving the slotKey releases the old slot and claims the new one in one step
        // the count is part of the filter, so two quick clicks can't both move it
        let moved
        try {
            moved = await Booking.updateOne(
                { _id: booking._id, ...(Number.isFinite(maxMoves) && { $or: [{ rescheduleCount: { $exists: false } }, { rescheduleCount: { $lt: maxMoves } }] }) },
                {
                    $set: { appointmentDate: date, appointmentTime: time, slotKey, slotDuration: minutesFor(doctor, booking.consultationType), status: instant ? 'approved' : 'pending' },
                    $inc: { rescheduleCount: 1 },
                }
            )
        } catch (error) {
            if (isSlotTakenError(error)) {
                return res.status(409).json({ success: false, message: SLOT_TAKEN_MESSAGE });
            }
            throw error
        }
        if (moved.modifiedCount === 0) {
            return res.status(400).json({ success: false, message: movedTooOften });
        }

        // the old time is free again
        checkWaitlist(booking.doctor, booking.appointmentDate)
        notify('doctor', booking.doctor, { title: 'Appointment moved', bookingId: String(booking._id), status: instant ? 'approved' : 'pending', message: `A patient moved their appointment to ${date} at ${time}${instant ? '' : ', please confirm it'}` })
        res.status(200).json({ success: true, message: instant ? "Appointment moved and confirmed" : "Appointment moved, the doctor will confirm the new time" });
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
                // the visit is for one of the patient's family members (Plus Family)
                ...(booking.familyMember?._id && { familyMember: booking.familyMember }),
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

        const refund = await refundBooking(booking)
        const declined = await Booking.findOneAndUpdate(
            { _id: booking._id, status: 'pending' },
            {
                $set: { status: 'cancelled', cancelledBy: 'doctor', declineReason: reason, respondedAt: new Date(), ...refundFields(refund) },
                $unset: { slotKey: 1 },
            },
            { new: true }
        )
        if (!declined) return res.status(409).json({ success: false, message: "This request was already answered" });
        notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: `Your request was declined: ${reason}. The payment is being refunded` })
        checkWaitlist(booking.doctor, booking.appointmentDate)
        res.status(200).json({ success: true, message: "Request declined and refunded", data: declined });
    } catch (error) {
        logger.error('Respond to booking error:', error.message)
        res.status(500).json({ success: false, message: "Could not update the request" });
    }
}

// requests the doctor never answered are cancelled and refunded once their time has passed
export const expireUnansweredRequests = async () => {
    const candidates = await Booking.find({ isPaid: true, status: 'pending', appointmentDate: { $lte: clinicToday() } })
    for (const booking of candidates) {
        if (appointmentEpoch(booking.appointmentDate, booking.appointmentTime) > Date.now()) continue
        try {
            const refund = await refundBooking(booking)
            await Booking.updateOne(
                { _id: booking._id, status: 'pending' },
                { $set: { status: 'cancelled', cancelledBy: 'system', declineReason: 'The doctor did not confirm in time', ...refundFields(refund) }, $unset: { slotKey: 1 } }
            )
            notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: 'Your doctor did not confirm the request in time, so it was cancelled and refunded' })
            checkWaitlist(booking.doctor, booking.appointmentDate)
        } catch (error) {
            logger.error('Could not expire request', String(booking._id), error.message)
        }
    }
}

// video calls whose window has closed: the doctor never came → full refund; the patient never came → no refund
export const settleMissedCalls = async () => {
    const candidates = await Booking.find({
        isPaid: true,
        status: 'approved',
        joinsTracked: true,
        settledAt: { $exists: false },
        appointmentDate: { $lte: clinicToday() },
    })
    for (const booking of candidates) {
        if (getCallWindow(booking).closesAt > Date.now()) continue
        try {
            if (!booking.joinedAt?.doctor) {
                const refund = await refundBooking(booking)
                const updated = await Booking.updateOne(
                    { _id: booking._id, status: 'approved', settledAt: { $exists: false } },
                    {
                        $set: { status: 'cancelled', cancelledBy: 'doctor', noShow: 'doctor', doctorFault: true, declineReason: 'The doctor did not join the call', settledAt: new Date(), ...refundFields(refund) },
                        $unset: { slotKey: 1 },
                    }
                )
                if (updated.modifiedCount) notify('patient', booking.user, { bookingId: String(booking._id), status: 'cancelled', message: 'Your doctor did not join the call, so the full payment is being refunded' })
            } else {
                await Booking.updateOne(
                    { _id: booking._id, settledAt: { $exists: false } },
                    { $set: { settledAt: new Date(), ...(!booking.joinedAt?.patient && { noShow: 'patient' }) } }
                )
            }
        } catch (error) {
            logger.error('Could not settle call', String(booking._id), error.message)
        }
    }
}

// PUT /bookings/:id/no-show  (doctor) the patient didn't come to a clinic visit: no refund, the fee is kept
export const markNoShow = async(req,res)=>{
    try {
        const booking = await Booking.findOne({ _id: req.params.id, doctor: req.userId, isPaid: true })
        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found" });
        }
        if (booking.consultationType !== 'clinic' || booking.status !== 'approved') {
            return res.status(400).json({ success: false, message: "Only confirmed clinic visits can be marked as missed (video calls are checked automatically)" });
        }
        const minutesSinceStart = -minutesUntil(booking.appointmentDate, booking.appointmentTime)
        if (minutesSinceStart < 0) {
            return res.status(400).json({ success: false, message: "The appointment hasn't started yet" });
        }
        if (minutesSinceStart > 3 * 24 * 60) {
            return res.status(400).json({ success: false, message: "Missed visits can be reported up to 3 days after" });
        }
        const updated = await Booking.updateOne(
            { _id: booking._id, noShow: { $exists: false } },
            { $set: { noShow: 'patient', settledAt: new Date() } }
        )
        if (updated.modifiedCount === 0) {
            return res.status(400).json({ success: false, message: "This visit was already marked" });
        }
        notify('patient', booking.user, { title: 'Visit marked as missed', bookingId: String(booking._id), status: 'approved', message: `Your doctor marked the ${booking.appointmentDate} clinic visit as missed` })
        res.status(200).json({ success: true, message: "Marked as missed, the fee is kept" });
    } catch (error) {
        logger.error('No-show error:', error.message)
        res.status(500).json({ success: false, message: "Could not update the visit" });
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
            const refund = await refundBooking(booking)
            const updated = await Booking.updateOne(
                { _id: booking._id, status: { $in: ['pending', 'approved'] } },
                {
                    $set: { status: 'cancelled', cancelledBy: 'doctor', declineReason: 'The doctor is on leave that day', respondedAt: new Date(), ...refundFields(refund), ...(booking.status === 'approved' && { doctorFault: true }) },
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
