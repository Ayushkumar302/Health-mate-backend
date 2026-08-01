import Booking from "../models/BookingSchema.js";
import Doctor from "../models/DoctorSchema.js"; // Make sure DoctorSchema is correctly exported from DoctorSchema.js

export const updateDoctor = async (req, res) => {
    const id = req.params.id;
    try {
        const updatedDoctor = await Doctor.findByIdAndUpdate(id, { $set: req.body }, { new: true });
        if (!updatedDoctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        res.status(200).json({ success: true, message: "Doctor updated successfully", data: updatedDoctor });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to update doctor" });
    }
};

export const deleteDoctor = async (req, res) => {
    const id = req.params.id;
    try {
        const deletedDoctor = await Doctor.findByIdAndDelete(id);
        if (!deletedDoctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        res.status(200).json({ success: true, message: "Doctor deleted successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to delete doctor" });
    }
};

export const getsingleDoctor = async (req, res) => {
    const id = req.params.id;
    try {
        const doctor = await Doctor.findById(id).populate('reviews').select("-password -__v");
        if (!doctor) {
            return res.status(404).json({ success: false, message: "Doctor not found" });
        }
        res.status(200).json({ success: true, message: "Doctor found successfully", data: doctor });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving doctor" });
    }
};

export const getAllDoctor = async (req, res) => {
    try {
        const {query} = req.query;
        let doctors;
        if(query){
        doctors = await Doctor.find({
            $or: [
                { name: { $regex: query, $options: "i" } },
                { specialization: { $regex: query, $options: "i" } },
        
            ],
        }).select("-password -__v");
    }else{
            doctors = await Doctor.find().select("-password -__v");
        }

        res.status(200).json({ success: true, message: "Doctors found successfully", data: doctors });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error retrieving doctors" });
    }
};

// export const getDoctorprofile = async(req,res)=>{
//     const doctorId = req.doctorId;
    

//     try{
//         const doctor = await Doctor.findById(doctorId).select("-password -__v");

//      if(!doctor){
//             return res.status(404).json({success:false,message:"User not found"});
//         }
//     const {password, ...rest} = doctor._doc
//     const appointments = await Booking.find({doctor:doctorId})
//     res.status(200).json({success:true,message:"Getting doctor profile",data:{...rest , appointments}});
        
//     }catch(error){
//      res.status(500).json({success:false,message:"oops, somthing went worng"});
//     }
// }

export const getDoctorprofile = async (req, res) => {
    const doctorId = req.doctorId; // Get doctorId from authenticated request

    try {
        // Fetch doctor profile
        const doctor = await Doctor.findById(doctorId).select("-password -__v");

        if (!doctor) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Fetch appointments for this doctor
        const { password, ...rest } = doctor._doc;
        const appointments = await Booking.find({ doctor: doctorId });

        res.status(200).json({
            success: true,
            message: "Getting doctor profile",
            data: { ...rest, appointments },
        });
    } catch (error) {
        console.error("Error fetching doctor profile:", error);
        res.status(500).json({ success: false, message: "Oops, something went wrong" });
    }
};
