// Import User model correctly
import User from "../models/UserSchema.js"; // Ensure UserSchema is exported as User in UserSchema.js
import Booking from '../models/BookingSchema.js'
import Doctor from '../models/DoctorSchema.js'
export const updateUser = async (req, res) => {
    const id = req.params.id;
    try {
        const updatedUser = await User.findByIdAndUpdate(id, { $set: req.body }, { new: true });
        res.status(200).json({ success: true, message: "User updated successfully", data: updatedUser });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to update user" });
    }
};

export const deleteUser = async (req, res) => {
    const id = req.params.id;
    try {
        await User.findByIdAndDelete(id);
        res.status(200).json({ success: true, message: "User deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete user" });
    }
};

export const getsingleUser = async (req, res) => {
    const id = req.params.id;
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

export const getAllUser = async (req, res) => {
    try {
        const users = await User.find({}).select("-password -__v")
        res.status(200).json({ success: true, message: "Users found successfully", data: users });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving users" });
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
        //1)retrieve appointments from booking for the specific user 
        const bookings = await Booking.find({user:req.userId})
        //2)exract doctor ids from appointment bookings
        const doctorIds = bookings.map(book=>book.doctor)
        //3)retriev docto using doctor ids
        const doctors = await Doctor.find({ _id: { $in: doctorIds } }).select("-password -__v");

        res.status(200).json({ success: true, message: "Getting appointments", data: doctors });
        
    } catch (error) {
        res.status(500).json({ success: false, message: "oops, somthing went worng" });
        
    }
}