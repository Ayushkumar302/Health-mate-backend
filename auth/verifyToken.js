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
        // only accept the algorithm we sign with (blocks "alg: none" and algorithm-swap tricks)
        const decoded = jwt.verify(authToken.split(" ")[1], process.env.JWT_SECRET_KEY, { algorithms: ["HS256"] });
        req.userId = decoded.id; // Set userId
        req.role = decoded.role; // Set role
        
        // If role is doctor, set doctorId for easier access in doctor-specific routes
        if (decoded.role === "doctor") {
            req.doctorId = decoded.id; 
        }

        next();
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({ success: false, code: "SESSION_EXPIRED", message: "Your session has expired, please log in again" });
        }
        return res.status(401).json({ success: false, code: "SESSION_EXPIRED", message: "Please log in again" });
    }
};

export const restrict = roles=> async(req,res,next)=>{
    try {
        const userId = req.userId;
        // look up the collection that matches the role in the token
        const user = req.role === "doctor"
            ? await Doctor.findById(userId)
            : await User.findById(userId)

        // account may have been deleted while the token is still valid
        if(!user){
            return res.status(401).json({success:false, code:'SESSION_EXPIRED', message:'Account not found, please log in again'})
        }
        if(!roles.includes(user.role)){
            return res.status(403).json({success:false,message:'You are not allowed to do this'})
        }
        next();
    } catch (error) {
        return res.status(500).json({success:false,message:'Authorization check failed'})
    }
};