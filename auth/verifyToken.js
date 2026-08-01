import jwt from "jsonwebtoken";
import Doctor from "../models/DoctorSchema.js";
import User from "../models/UserSchema.js";

// export const authenticate =async(req,res,next)=>{
//     //get token from headers
//     const authToken = req.headers.authorization

//     // check if token is exists
//     if(!authToken||!authToken.startsWith('Bearer')) {
//         return res.status(401).json({success:false,message:'no token, authorization denied'})

//     }
//     try {
        
//         // verify token
//         const decoded = jwt.verify(authToken.split(' ')[1], process.env.JWT_SECRET_KEY);
//         req.userId = decoded.id;
//         req.role = decoded.role;
//         next();
        
//     } catch (error) {

//         if (error.name === 'TokenExpiredError') {
//             return res.status(401).json({message:'token is expired'})
//         }
//         return res.status(401).json({success:false,message:'invalid token'}) 
        
//     }
// }
export const authenticate = async (req, res, next) => {
    const authToken = req.headers.authorization;

    if (!authToken || !authToken.startsWith("Bearer")) {
        return res.status(401).json({ success: false, message: "No token, authorization denied" });
    }

    try {
        // Verify token
        const decoded = jwt.verify(authToken.split(" ")[1], process.env.JWT_SECRET_KEY);
        req.userId = decoded.id; // Set userId
        req.role = decoded.role; // Set role
        
        // If role is doctor, set doctorId for easier access in doctor-specific routes
        if (decoded.role === "doctor") {
            req.doctorId = decoded.id; 
        }

        next();
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({ message: "Token is expired" });
        }
        return res.status(401).json({ success: false, message: "Invalid token" });
    }
};

export const restrict = roles=> async(req,res,next)=>{
    const userId = req.userId;
    let user;
    const patient = await User.findById(userId)
    const doctor =  await Doctor.findById(userId)

    if(patient){
        user = patient;
    }
    if(doctor){
        user = doctor;
    }
    if(!roles.includes(user.role)){
        return res.status(401).json({success:false,message:'you are not authorized'})

    }
    next();
};