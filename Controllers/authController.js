// regist and login functionality
import User from '../models/UserSchema.js'
import Doctor from '../models/DoctorSchema.js'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const generateToken = user=>{
  return jwt.sign({id:user._id, role:user.role}, process.env.JWT_SECRET_KEY,
  {
    expiresIn: '30d' //change it 30 days expiration time
  })

}

export const register = async(req,res)=>{

    const {email,password,name,role,photo,gender} = req.body

    try {
        let user = null
        if(role === 'patient'){
          user =  await User.findOne({email})
        }
        else if(role === 'doctor'){
            user = await  Doctor.findOne({email})
        }

        //check if user exist
        if(user){
            return res.status(400).json({message:'User already exist'})
        }

        //hash password
        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(password, salt)

        //create new user
        if (role === "patient") {
          user = new User({
            email,
            password: hashedPassword,
            name,
            photo,
            gender,
            role
          });
        }

        if (role === "doctor") {
            user = new Doctor({
              email,
              password: hashedPassword,
              name,
              photo,
              gender,
              role
            });
        }
        //save user to database
        await user.save()
        res.status(201).json({ success: true, message: 'User successfully created' }); // 201 for successful creation

    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to create user', error: error.message }); // Indicate failure
    }
}

export const login = async (req, res) => {
  const { email } = req.body;
  try {
    let user = null;
    const patient = await User.findOne({ email });
    const doctor = await Doctor.findOne({ email });

    if (patient) {
      user = patient;  
    }
    if (doctor) {
      user = doctor;
    }
    //check if user exist or not
    if (!user) {
      return res.status(404).json({ message: "user not found" }); // 401 for unauthorized
    }
    //check if password is correct or not
    const isPasswordMatch = await bcrypt.compare(req.body.password, user.password);
    if (!isPasswordMatch) {
      return res.status(400).json({ status:false ,message: "Invalid credentials" }); // 400 for bad req

    }

    //get token
    const token = generateToken(user)

    const {password,role,appointments, ...rest} = user._doc
    res.status(200).json({ success: true, message: 'logged in successfully',token, data:{...rest},role}); // 200 for successful login
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to login', error})

  }
};