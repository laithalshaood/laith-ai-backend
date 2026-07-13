const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'data.json');

function initDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({
            users: [],
            subscriptions: [],
            payments: [],
            usage: {}
        }, null, 2));
    }
}

function readDB() {
    initDB();
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading DB:', err);
        return { users: [], subscriptions: [], payments: [], usage: {} };
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Error writing DB:', err);
    }
}

// Users
function createUser(email, password, name) {
    const db = readDB();
    const existing = db.users.find(u => u.email === email);
    if (existing) return null;

    const user = {
        id: uuidv4(),
        email,
        password: bcrypt.hashSync(password, 10),
        name,
        plan: 'free',
        createdAt: new Date().toISOString(),
        shamCashPhone: null
    };
    db.users.push(user);
    writeDB(db);
    console.log('✅ User created:', user.id, user.email);
    return { id: user.id, email: user.email, name: user.name, plan: user.plan };
}

function findUser(email) {
    const db = readDB();
    return db.users.find(u => u.email === email);
}

function findUserById(id) {
    const db = readDB();
    return db.users.find(u => u.id === id);
}

function updateUserPlan(userId, plan) {
    const db = readDB();
    const user = db.users.find(u => u.id === userId);
    if (user) {
        user.plan = plan;
        writeDB(db);
        console.log('✅ User plan updated:', userId, '->', plan);
    }
}

// Subscriptions
function createSubscription(userId, plan, amount, method, status) {
    status = status || 'pending';
    const db = readDB();
    const sub = {
        id: uuidv4(),
        userId,
        plan,
        amount,
        method,
        status,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    db.subscriptions.push(sub);
    writeDB(db);
    console.log('✅ Subscription created:', sub.id, 'for user', userId, 'plan:', plan);
    return sub;
}

function getUserSubscription(userId) {
    const db = readDB();
    return db.subscriptions
        .filter(s => s.userId === userId && s.status === 'active')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function activateSubscription(subId) {
    const db = readDB();
    const sub = db.subscriptions.find(s => s.id === subId);
    if (sub) {
        sub.status = 'active';
        sub.activatedAt = new Date().toISOString();
        const user = db.users.find(u => u.id === sub.userId);
        if (user) {
            user.plan = sub.plan;
            console.log('✅ User plan changed:', user.id, '->', sub.plan);
        }
        writeDB(db);
        console.log('✅ Subscription activated:', subId);
    } else {
        console.log('❌ Subscription not found:', subId);
    }
    return sub;
}

// Usage tracking
function getUsage(userId) {
    const db = readDB();
    const today = new Date().toISOString().split('T')[0];
    const key = userId + '_' + today;
    return db.usage[key] || 0;
}

function incrementUsage(userId) {
    const db = readDB();
    const today = new Date().toISOString().split('T')[0];
    const key = userId + '_' + today;
    db.usage[key] = (db.usage[key] || 0) + 1;
    writeDB(db);
    return db.usage[key];
}

function getUsageLimit(plan) {
    const limits = { free: 5, pro: 999999, business: 999999, admin: 999999 };
    return limits[plan] || 5;
}

// Payments
function createPayment(userId, amount, method, reference) {
    const db = readDB();
    const payment = {
        id: uuidv4(),
        userId,
        amount,
        method,
        reference,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    db.payments.push(payment);
    writeDB(db);
    console.log('✅ Payment created:', payment.id, 'for user', userId);
    return payment;
}

function getPayment(id) {
    const db = readDB();
    return db.payments.find(p => p.id === id);
}

function confirmPayment(id) {
    const db = readDB();
    const payment = db.payments.find(p => p.id === id);
    if (payment) {
        payment.status = 'confirmed';
        payment.confirmedAt = new Date().toISOString();
        writeDB(db);
        console.log('✅ Payment confirmed:', id);
    } else {
        console.log('❌ Payment not found:', id);
    }
    return payment;
}

module.exports = {
    createUser, findUser, findUserById, updateUserPlan,
    createSubscription, getUserSubscription, activateSubscription,
    getUsage, incrementUsage, getUsageLimit,
    createPayment, getPayment, confirmPayment,
    readDB, writeDB
};
