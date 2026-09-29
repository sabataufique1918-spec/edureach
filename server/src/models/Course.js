import mongoose from 'mongoose';

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    subject: { type: String, trim: true, default: '' },
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    enrolled: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
    // Passing this threshold is what triggers an on-chain completion credential.
    passMarkPercent: { type: Number, default: 40 },
    published: { type: Boolean, default: true },
  },
  { timestamps: true }
);

courseSchema.index({ title: 'text', subject: 'text' });

export default mongoose.model('Course', courseSchema);
