import Review from '../models/ReviewSchema.js'
import Doctor from '../models/DoctorSchema.js'
import Booking from '../models/BookingSchema.js'
import { cleanText } from '../utils/text.js'
import mongoose from 'mongoose'
import { hadVisitWith } from '../utils/reviewPrompts.js'
import { addNotification } from '../utils/notifications.js'
import { refreshReviewSummary } from '../utils/ai/reviewSummary.js'

//get all reviews (only the doctor's reviews when used as /doctors/:doctorId/reviews)
export const getAllReviews = async (req, res) => {
    try {
     const filter = req.params.doctorId ? { doctor: req.params.doctorId } : {}
     const reviews = await Review.find(filter)
     res.status(200).json({ success: true, message: 'successfull' , data:reviews });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Not found' });
    }
}
//create review
export const createReview = async (req, res) => {
    // doctor and user always come from the url and the token, never from the body
    const doctorId = req.params.doctorId
    const userId = req.userId
    // whole stars 1-5 and a short, clean text
    const rating = Number(req.body.rating)
    const reviewText = cleanText(req.body.reviewText).slice(0, 500)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Please give a rating from 1 to 5 stars' });
    }
    if (reviewText.length < 5) {
        return res.status(400).json({ success: false, message: 'Please write a few words about your visit' });
    }

    if (!mongoose.isValidObjectId(doctorId)) {
        return res.status(404).json({ success: false, message: 'Doctor not found' });
    }
    try {
        // only after a visit that took place (confirmed, started, and nobody missed it)
        if (!(await hadVisitWith(userId, doctorId))) {
            const booked = await Booking.exists({ doctor: doctorId, user: userId, isPaid: true, status: { $ne: 'cancelled' } })
            return res.status(403).json({ success: false, message: booked ? 'You can review the doctor after your visit' : 'You can only review a doctor you have seen' });
        }
        const alreadyReviewed = await Review.exists({ doctor: doctorId, user: userId })
        if (alreadyReviewed) {
            return res.status(400).json({ success: false, message: 'You have already reviewed this doctor' });
        }

        const newReview = new Review({ doctor: doctorId, user: userId, rating, reviewText })
        const savedReview = await newReview.save()
        await Doctor.findByIdAndUpdate(doctorId, {
            $push: { reviews: savedReview._id }
        })
        // Pro / Pro Clinic: the AI summary of the reviews is made again in the background
        refreshReviewSummary(doctorId)
        addNotification('doctor', doctorId, {
            kind: 'review',
            title: `New ${rating}-star review`,
            text: reviewText.length > 140 ? `${reviewText.slice(0, 140)}…` : reviewText,
            link: '/doctors/profile/me?reviews',
        })
        res.status(201).json({ success: true, message: 'Review submitted successfully' , data:savedReview });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not save the review' });
    }
}

// PUT /reviews/:id/reply  body: { text }  (the reviewed doctor) a public answer under the review; empty removes it.
// The patient is told. Polite answers only: no patient health details (they are shown publicly).
export const replyToReview = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ success: false, message: 'Review not found' });
    }
    const text = cleanText(req.body?.text).slice(0, 500)
    if (text && text.length < 2) {
        return res.status(400).json({ success: false, message: 'Write a few words' });
    }
    try {
        const review = await Review.findOne({ _id: req.params.id, doctor: req.userId })
        if (!review) {
            return res.status(404).json({ success: false, message: 'Review not found' });
        }
        const first = !review.reply?.text
        await Review.updateOne({ _id: review._id }, text ? { $set: { reply: { text, at: new Date() } } } : { $unset: { reply: 1 } }, { timestamps: false })
        if (text && first && review.user) {
            addNotification('patient', review.user._id || review.user, {
                kind: 'review',
                title: 'Your doctor replied to your review',
                text: text.length > 140 ? `${text.slice(0, 140)}…` : text,
                link: `/doctors/${req.userId}?tab=feedback`,
            })
        }
        res.status(200).json({ success: true, message: text ? 'Reply published under the review' : 'Reply removed', data: text ? { text, at: new Date() } : null });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not save the reply' });
    }
}
