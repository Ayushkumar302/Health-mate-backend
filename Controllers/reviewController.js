import Review from '../models/ReviewSchema.js'
import Doctor from '../models/DoctorSchema.js'
import Booking from '../models/BookingSchema.js'
import { cleanText } from '../utils/text.js'

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

    try {
        const hasBooking = await Booking.exists({ doctor: doctorId, user: userId, isPaid: true, status: { $ne: 'cancelled' } })
        if (!hasBooking) {
            return res.status(403).json({ success: false, message: 'You can only review a doctor you have booked' });
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
        res.status(201).json({ success: true, message: 'Review submitted successfully' , data:savedReview });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not save the review' });
    }
}
