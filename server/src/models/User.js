import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Phone number is the primary identifier: rural students reliably have one,
// and email addresses are far less universal.
const userSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['student', 'teacher', 'admin'], default: 'student', index: true },
    institute: { type: String, trim: true, default: '' },
    // Remembered client preference so a returning student is not dropped
    // straight into a video stream on a 2G link.
    preferredMode: {
      type: String,
      enum: ['audio', 'slides', 'low', 'medium', 'high'],
      default: 'audio',
    },
    dataBudgetMb: { type: Number, default: 500 },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    phone: this.phone,
    name: this.name,
    role: this.role,
    institute: this.institute,
    preferredMode: this.preferredMode,
    dataBudgetMb: this.dataBudgetMb,
  };
};

export default mongoose.model('User', userSchema);
