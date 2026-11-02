// Import User model correctly
import User from "../models/UserSchema.js"; // Ensure UserSchema is exported as User in UserSchema.js
import Booking from '../models/BookingSchema.js'
import bcrypt from 'bcryptjs'
import { DEMO_MESSAGES, isDemoMode } from '../utils/demo.js'
import { DEMO_LOCKED_PATIENT_FIELDS, changedLockedFields, sanitizePatientUpdate } from '../utils/validate.js'
import { passwordProblem } from '../utils/tokens.js'

// users can only read/change/delete their own account
const isOwnAccount = req => req.params.id === req.userId

// empty values clear the field instead of storing ""/null
const toUpdate = updates => {
    const $set = {}
    const $unset = {}
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === null || value === "") $unset[key] = 1
        else $set[key] = value
    }
    return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) }
}

export const updateUser = async (req, res) => {
    const id = req.params.id;
    if (!isOwnAccount(req)) {
        return res.status(403).json({ success: false, message: "You can only update your own account" });
    }
    try {
        if (req.body.password && isDemoMode()) {
            return res.status(403).json({ success: false, message: DEMO_MESSAGES.password });
        }
        const current = await User.findById(id);
        if (!current) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        // only known fields, cleaned and range-checked (role, email... can't be sent)
        const { updates, error } = sanitizePatientUpdate(req.body, current);
        if (error) {
            return res.status(400).json({ success: false, message: error });
        }
        // shared demo patients keep the name and photo doctors and reviews show
        if (isDemoMode() && current.isDemo) {
            const locked = changedLockedFields(current.toObject(), updates, DEMO_LOCKED_PATIENT_FIELDS);
            if (locked.length) {
                return res.status(403).json({ success: false, message: `${DEMO_MESSAGES.publicProfile} (${locked.join(", ")})` });
            }
        }
        if (req.body.password) {
            const weak = passwordProblem(req.body.password);
            if (weak) return res.status(400).json({ success: false, message: weak });
            updates.password = await bcrypt.hash(req.body.password, 12);
        }
        const updatedUser = await User.findByIdAndUpdate(id, toUpdate(updates), { new: true, runValidators: true }).select("-password -__v");
        res.status(200).json({ success: true, message: "Profile updated", data: updatedUser });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to update the profile" });
    }
};

export const deleteUser = async (req, res) => {
    const id = req.params.id;
    if (!isOwnAccount(req)) {
        return res.status(403).json({ success: false, message: "You can only delete your own account" });
    }
    if (isDemoMode()) {
        return res.status(403).json({ success: false, message: DEMO_MESSAGES.deleteAccount });
    }
    try {
        await User.findByIdAndDelete(id);
        res.status(200).json({ success: true, message: "User deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete user" });
    }
};

export const getsingleUser = async (req, res) => {
    const id = req.params.id;
    if (!isOwnAccount(req)) {
        return res.status(403).json({ success: false, message: "You can only view your own account" });
    }
    try {
        const user = await User.findById(id).select(
            "-password -__v"
        );
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        res.status(200).json({ success: true, message: "User found successfully", data: user });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving user" });
    }
};

export const getUserProfile = async (req,res)=>{
    const userId = req.userId;
    try{
        const user = await User.findById(userId).select("-password -__v");

     if(!user){
            return res.status(404).json({success:false,message:"User not found"});
        }
    const {password, ...rest} = user._doc
    res.status(200).json({success:true,message:"Getting user profile",data:{...rest}});

    }catch(error){
     res.status(500).json({success:false,message:"oops, somthing went worng"});
    }
}

export const getMyAppointments = async(req,res)=>{
    try {
        // return the paid bookings themselves (with doctor details) so status, price and date are kept
        const bookings = await Booking.find({ user: req.userId, isPaid: true })
            .populate("doctor", "-password -__v -registrationNumber -reviewNote -reviewedAt -emailVerified -isDemo -appointments")
            .sort({ appointmentDate: -1, appointmentTime: -1, createdAt: -1 })

        // skip bookings whose doctor account was deleted
        const validBookings = bookings.filter(booking => booking.doctor)

        res.status(200).json({ success: true, message: "Getting appointments", data: validBookings });

    } catch (error) {
        res.status(500).json({ success: false, message: "oops, somthing went worng" });

    }
}
