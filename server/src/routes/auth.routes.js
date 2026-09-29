import express from 'express';
import Joi from 'joi';
import User from '../models/User.js';
import { signToken, requireAuth, loadUser } from '../middleware/auth.js';
import env from '../config/env.js';
import { wrap } from '../middleware/error.js';

const router = express.Router();

const registerSchema = Joi.object({
  phone: Joi.string().pattern(/^[0-9]{10,15}$/).required(),
  name: Joi.string().min(2).max(80).required(),
  password: Joi.string().min(6).max(128).required(),
  role: Joi.string().valid('student', 'teacher').default('student'),
  institute: Joi.string().max(120).allow('').default(''),
});

// Demo accounts, for the login screen to offer as one-tap sign-in.
//
// Two guards, both required, so this can never hand out credentials on a real
// deployment: the server must not be in production, and the seeded users must
// actually exist. An institute running this for real has neither.
const DEMO_ACCOUNTS = [
  { phone: '9000000001', password: 'teach1234', label: 'Teacher', name: 'Dr. Anita Rao' },
  { phone: '9000000011', password: 'learn1234', label: 'Student', name: 'Rahul Kamble' },
  { phone: '9000000013', password: 'learn1234', label: 'Student at risk', name: 'Imran Shaikh' },
];

router.get(
  '/demo-accounts',
  wrap(async (req, res) => {
    if (env.nodeEnv === 'production') return res.json({ demo: false, accounts: [] });

    const seeded = await User.find({ phone: { $in: DEMO_ACCOUNTS.map((a) => a.phone) } })
      .select('phone name role institute')
      .lean();
    if (seeded.length === 0) return res.json({ demo: false, accounts: [] });

    const byPhone = Object.fromEntries(seeded.map((u) => [u.phone, u]));
    return res.json({
      demo: true,
      institute: seeded[0].institute || '',
      accounts: DEMO_ACCOUNTS.filter((a) => byPhone[a.phone]).map((a) => ({
        ...a,
        name: byPhone[a.phone].name,
        role: byPhone[a.phone].role,
      })),
    });
  })
);

router.post(
  '/register',
  wrap(async (req, res) => {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    if (await User.exists({ phone: value.phone })) {
      return res.status(409).json({ error: 'this phone number is already registered' });
    }

    const user = new User({
      phone: value.phone,
      name: value.name,
      role: value.role,
      institute: value.institute,
    });
    await user.setPassword(value.password);
    await user.save();

    return res.status(201).json({ token: signToken(user), user: user.toPublic() });
  })
);

router.post(
  '/login',
  wrap(async (req, res) => {
    const { phone, password } = req.body || {};
    if (!phone || !password) {
      return res.status(400).json({ error: 'phone and password are required' });
    }

    const user = await User.findOne({ phone }).select('+passwordHash');
    if (!user || !(await user.verifyPassword(password))) {
      return res.status(401).json({ error: 'incorrect phone number or password' });
    }

    user.lastSeenAt = new Date();
    await user.save();
    return res.json({ token: signToken(user), user: user.toPublic() });
  })
);

router.get(
  '/me',
  requireAuth,
  loadUser,
  wrap(async (req, res) => res.json({ user: req.user.toPublic() }))
);

// Remembered client preferences. Kept server-side so a student who reinstalls
// the app is not dropped back onto a video default.
router.patch(
  '/me',
  requireAuth,
  loadUser,
  wrap(async (req, res) => {
    const { preferredMode, dataBudgetMb, name } = req.body || {};
    if (preferredMode) req.user.preferredMode = preferredMode;
    if (typeof dataBudgetMb === 'number') req.user.dataBudgetMb = dataBudgetMb;
    if (name) req.user.name = name;
    await req.user.save();
    return res.json({ user: req.user.toPublic() });
  })
);

export default router;
