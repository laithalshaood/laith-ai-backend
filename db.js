const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==================== INIT DB ====================
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        plan TEXT DEFAULT 'free',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        sham_cash_phone TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        plan TEXT NOT NULL,
        amount INTEGER NOT NULL,
        method TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        activated_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL,
        method TEXT NOT NULL,
        reference TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        usage_date DATE NOT NULL,
        count INTEGER DEFAULT 0,
        UNIQUE(user_id, usage_date)
      )
    `);

    console.log('✅ PostgreSQL tables created');
  } finally {
    client.release();
  }
}

// ==================== USERS ====================
async function createUser(email, password, name) {
  try {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return null;

    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);

    await pool.query(
      'INSERT INTO users (id, email, password, name, plan) VALUES ($1, $2, $3, $4, $5)',
      [id, email, hashedPassword, name, 'free']
    );

    console.log('✅ User created:', id);
    return { id, email, name, plan: 'free' };
  } catch (err) {
    console.error('Create user error:', err);
    return null;
  }
}

async function findUser(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function updateUserPlan(userId, plan) {
  await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, userId]);
  console.log('✅ User plan updated:', userId, '->', plan);
}

// ==================== SUBSCRIPTIONS ====================
async function createSubscription(userId, plan, amount, method, status) {
  status = status || 'pending';
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await pool.query(
    'INSERT INTO subscriptions (id, user_id, plan, amount, method, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, userId, plan, amount, method, status, expiresAt]
  );

  console.log('✅ Subscription created:', id);
  return { id, userId, plan, amount, method, status, expiresAt };
}

async function getUserSubscription(userId) {
  const result = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
    [userId, 'active']
  );
  return result.rows[0] || null;
}

async function activateSubscription(subId) {
  const result = await pool.query(
    'UPDATE subscriptions SET status = $1, activated_at = $2 WHERE id = $3 RETURNING *',
    ['active', new Date(), subId]
  );

  if (result.rows.length > 0) {
    const sub = result.rows[0];
    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [sub.plan, sub.user_id]);
    console.log('✅ Subscription activated:', subId);
    return sub;
  }
  return null;
}

// ==================== USAGE ====================
async function getUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    'SELECT count FROM usage_log WHERE user_id = $1 AND usage_date = $2',
    [userId, today]
  );
  return result.rows[0]?.count || 0;
}

async function incrementUsage(userId) {
  const today = new Date().toISOString().split('T')[0];

  await pool.query(`
    INSERT INTO usage_log (user_id, usage_date, count) 
    VALUES ($1, $2, 1)
    ON CONFLICT (user_id, usage_date) 
    DO UPDATE SET count = usage_log.count + 1
  `, [userId, today]);

  const result = await pool.query(
    'SELECT count FROM usage_log WHERE user_id = $1 AND usage_date = $2',
    [userId, today]
  );

  return result.rows[0].count;
}

function getUsageLimit(plan) {
  const limits = { free: 5, pro: 999999, business: 999999, admin: 999999 };
  return limits[plan] || 5;
}

// ==================== PAYMENTS ====================
async function createPayment(userId, amount, method, reference) {
  const id = uuidv4();

  await pool.query(
    'INSERT INTO payments (id, user_id, amount, method, reference) VALUES ($1, $2, $3, $4, $5)',
    [id, userId, amount, method, reference]
  );

  console.log('✅ Payment created:', id);
  return { id, userId, amount, method, reference, status: 'pending' };
}

async function getPayment(id) {
  const result = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function confirmPayment(id) {
  const result = await pool.query(
    'UPDATE payments SET status = $1, confirmed_at = $2 WHERE id = $3 RETURNING *',
    ['confirmed', new Date(), id]
  );

  if (result.rows.length > 0) {
    console.log('✅ Payment confirmed:', id);
    return result.rows[0];
  }
  return null;
}

// ==================== ADMIN ====================
async function getPendingPayments() {
  const result = await pool.query('SELECT * FROM payments WHERE status = $1 ORDER BY created_at DESC', ['pending']);
  return result.rows;
}

// ==================== BACKWARD COMPAT ====================
async function readDB() {
  const users = await pool.query('SELECT * FROM users').then(r => r.rows);
  const subscriptions = await pool.query('SELECT * FROM subscriptions').then(r => r.rows);
  const payments = await pool.query('SELECT * FROM payments').then(r => r.rows);
  return { users, subscriptions, payments, usage: {} };
}

async function writeDB(data) {
  // No-op for PostgreSQL
}

module.exports = {
  pool, initDB,
  createUser, findUser, findUserById, updateUserPlan,
  createSubscription, getUserSubscription, activateSubscription,
  getUsage, incrementUsage, getUsageLimit,
  createPayment, getPayment, confirmPayment,
  getPendingPayments,
  readDB, writeDB
};
