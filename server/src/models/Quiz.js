import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema(
  {
    qid: { type: String, required: true },
    text: { type: String, required: true },
    options: { type: [String], required: true },
    // Never sent to students - stripped in the delivery projection.
    correctIndex: { type: Number, required: true },
    marks: { type: Number, default: 1 },
  },
  { _id: false }
);

const quizSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    lecture: { type: mongoose.Schema.Types.ObjectId, ref: 'Lecture', default: null },
    title: { type: String, required: true },
    questions: { type: [questionSchema], default: [] },
    timeLimitSec: { type: Number, default: 600 },
    // Quizzes are cached whole on the device, so they carry a version that
    // the client compares before re-downloading.
    version: { type: Number, default: 1 },
    open: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Payload a student downloads: answers removed, a few KB at most.
quizSchema.methods.forStudent = function forStudent() {
  return {
    id: this._id.toString(),
    courseId: this.course.toString(),
    lectureId: this.lecture ? this.lecture.toString() : null,
    title: this.title,
    timeLimitSec: this.timeLimitSec,
    version: this.version,
    open: this.open,
    questions: this.questions.map((q) => ({
      qid: q.qid,
      text: q.text,
      options: q.options,
      marks: q.marks,
    })),
  };
};

quizSchema.methods.grade = function grade(answers = {}) {
  let score = 0;
  let total = 0;
  const perQuestion = this.questions.map((q) => {
    total += q.marks;
    const given = answers[q.qid];
    const correct = Number(given) === q.correctIndex;
    if (correct) score += q.marks;
    return { qid: q.qid, given: given ?? null, correct, marks: correct ? q.marks : 0 };
  });
  const percent = total === 0 ? 0 : Math.round((score / total) * 100);
  return { score, total, percent, perQuestion };
};

export default mongoose.model('Quiz', quizSchema);
