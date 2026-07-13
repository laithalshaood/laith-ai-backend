const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ==================== CONNECT ====================
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (err) {
    console.error('❌ MongoDB Error:', err.message);
    process.exit(1);
  }
}

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  plan: { type: String, default: 'free' },
  createdAt: { type: String, default: () => new Date().toISOString() },
  shamCashPhone: { type: String, default: null }
});

const subscriptionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  plan: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  status: { type: String, default: 'pending' },
  createdAt: { type: String, default: () => new Date().toISOString() },
  expiresAt: { type: String },
  activatedAt: { type: String }
});

const paymentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  reference: { type: String },
  status: { type: String, default: 'pending' },
  createdAt: { type: String, default: () => new Date().toISOString() },
  confirmedAt: { type: String }
});

const usageSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 }
});

// ==================== MODELS ====================
const User = mongoose.model('User', userSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Usage = mongoose.model('Usage', usageSchema);

// ==================== USERS ====================
async function createUser(email, password, name) {
  const existing = await User.findOne({ email });
  if (existing) return null;

  const user = new User({
    id: uuidv4(),
    email,
    password: bcrypt.hashSync(password, 10),
    name,
    plan: 'free',
    createdAt: new Date().toISOString(),
    shamCashPhone: null
  });
  await user.save();
  console.log('✅ User created:', user.id);
  return { id: user.id, email: user.email, name: user.name, plan: user.plan };
}

async function findUser(email) {
  return await User.findOne({ email }).lean();
}

async function findUserById(id) {
  return await User.findOne({ id }).lean();
}

async function updateUserPlan(userId, plan) {
  await User.updateOne({ id: userId }, { plan });
  console.log('✅ User plan updated:', userId, '->', plan);
}

// ==================== SUBSCRIPTIONS ====================
async function createSubscription(userId, plan, amount, method, status) {
  status = status || 'pending';
  const sub = new Subscription({
    id: uuidv4(),
    userId,
    plan,
    amount,
    method,
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });
  await sub.save();
  console.log('✅ Subscription created:', sub.id);
  return sub.toObject();
}

async function getUserSubscription(userId) {
  const subs = await Subscription.find({ userId, status: 'active' }).sort({ createdAt: -1 }).lean();
  return subs[0] || null;
}

async function activateSubscription(subId) {
  const sub = await Subscription.findOne({ id: subId });
  if (sub) {
    sub.status = 'active';
    sub.activatedAt = new Date().toISOString();
    await sub.save();

    const user = await User.findOne({ id: sub.userId });
    if (user) {
      user.plan = sub.plan;
      await user.save();
      console.log('✅ User plan changed:', user.id, '->', sub.plan);
    }
    console.log('✅ Subscription activated:', subId);
  } else {
    console.log('❌ Subscription not found:', subId);
  }
  return sub;
}

// ==================== USAGE ====================
async function getUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = userId + '_' + today;
  const usage = await Usage.findOne({ key }).lean();
  return usage ? usage.count : 0;
}

async function incrementUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = userId + '_' + today;
  await Usage.findOneAndUpdate(
    { key },
    { $inc: { count: 1 } },
    { upsert: true, new: true }
  );
  const usage = await Usage.findOne({ key }).lean();
  return usage.count;
}

function getUsageLimit(plan) {
  const limits = { free: 5, pro: 999999, business: 999999, admin: 999999 };
  return limits[plan] || 5;
}

// ==================== PAYMENTS ====================
async function createPayment(userId, amount, method, reference) {
  const payment = new Payment({
    id: uuidv4(),
    userId,
    amount,
    method,
    reference,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  await payment.save();
  console.log('✅ Payment created:', payment.id);
  return payment.toObject();
}

async function getPayment(id) {
  return await Payment.findOne({ id }).lean();
}

async function confirmPayment(id) {
  const payment = await Payment.findOne({ id });
  if (payment) {
    payment.status = 'confirmed';
    payment.confirmedAt = new Date().toISOString();
    await payment.save();
    console.log('✅ Payment confirmed:', id);
  } else {
    console.log('❌ Payment not found:', id);
  }
  return payment;
}

// ==================== ADMIN ====================
async function getPendingPayments() {
  return await Payment.find({ status: 'pending' }).lean();
}

// ==================== BACKWARD COMPAT ====================
async function readDB() {
  const users = await User.find().lean();
  const subscriptions = await Subscription.find().lean();
  const payments = await Payment.find().lean();
  const usage = {};
  const usages = await Usage.find().lean();
  usages.forEach(u => { usage[u.key] = u.count; });
  return { users, subscriptions, payments, usage };
}

async function writeDB(data) {
  // MongoDB writes directly, no need for this
}

module.exports = {
  connectDB,
  createUser, findUser, findUserById, updateUserPlan,
  createSubscription, getUserSubscription, activateSubscription,
  getUsage, incrementUsage, getUsageLimit,
  createPayment, getPayment, confirmPayment,
  getPendingPayments,
  readDB, writeDB
};
