const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const db = require('./db');
const app = express();

// CORS - allow frontend only
app.use(cors({
    origin: ['https://laithalshaood.github.io', 'http://localhost:3000', 'http://localhost:5000'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'كثير من الطلبات، جرّب بعد شوي' }
});
app.use('/api/', limiter);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MISTRAL_KEY) {
    console.error('❌ MISTRAL_API_KEY not set!');
    process.exit(1);
}
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET not set!');
    process.exit(1);
}
if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not set!');
    process.exit(1);
}

// Middleware
function auth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch { return res.status(401).json({ error: 'جلسة منتهية' }); }
}

function adminOnly(req, res, next) {
    (async () => {
        try {
            const user = await db.findUserById(req.user.id);
            if (!user || user.plan !== 'admin') {
                return res.status(403).json({ error: 'ممنوع - صلاحيات المشرف فقط' });
            }
            next();
        } catch (err) {
            next(err);
        }
    })();
}

function checkUsage(req, res, next) {
    (async () => {
        try {
            const userId = req.user?.id;
            const user = await db.findUserById(userId);
            const plan = user?.plan || 'free';

            // Check if subscription expired
            const sub = await db.getUserSubscription(userId);
            if (sub && new Date(sub.expiresAt) < new Date() && plan !== 'free') {
                await db.updateUserPlan(userId, 'free');
                return res.status(403).json({ error: 'الاشتراك منتهي، جدد اشتراكك' });
            }

            const used = await db.getUsage(userId);
            const limit = db.getUsageLimit(plan);
            if (used >= limit) {
                return res.status(429).json({ error: 'استنفذت استخداماتك اليومية', plan, used, limit });
            }
            next();
        } catch (err) {
            next(err);
        }
    })();
}

// Mistral API call (FREE)
async function callAI(systemPrompt, userPrompt) {
    try {
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${MISTRAL_KEY}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({
                model: 'mistral-small',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7,
                max_tokens: 2000
            })
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            console.error('Mistral error:', res.status, errData);
            throw new Error(`Mistral error ${res.status}: ${errData.error?.message || 'Unknown'}`);
        }

        const data = await res.json();
        return data.choices[0].message.content;
    } catch (err) {
        console.error('AI call failed:', err.message);
        throw err;
    }
}

// ==================== AUTH ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
        const user = await db.createUser(email, password, name);
        if (!user) return res.status(400).json({ error: 'الإيميل مستخدم مسبقاً' });
        const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'صار خطأ بالسيرفر' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await db.findUser(email);
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'إيميل أو كلمة مرور غلط' });
        }
        const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'صار خطأ بالسيرفر' });
    }
});

app.get('/api/auth/me', auth, async (req, res) => {
    try {
        const user = await db.findUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'غير موجود' });
        const sub = await db.getUserSubscription(req.user.id);
        res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan }, subscription: sub });
    } catch (err) {
        console.error('Auth me error:', err);
        res.status(500).json({ error: 'صار خطأ' });
    }
});

// ==================== AI APIs ====================
app.post('/api/summarize', auth, checkUsage, async (req, res) => {
    try {
        const { text, length, style } = req.body;
        if (!text?.trim() || text.length < 10) return res.status(400).json({ error: 'النص قصير جداً' });
        const lm = { short: 'جملتين فقط', medium: 'فقرة واحدة', long: '3-4 فقرات' };
        const sm = { academic: 'أكاديمي', simple: 'بسيط', bullet: 'نقاط رئيسية' };
        const sp = `أنت مساعد ذكي متخصص في تلخيص النصوص العربية. لخّص النص بأسلوب ${sm[style]} وطول ${lm[length]}. حافظ على الأفكار الرئيسية.`;
        const result = await callAI(sp, text);
        await db.incrementUsage(req.user.id);
        res.json({ result, usage: await db.getUsage(req.user.id) });
    } catch (err) {
        console.error('Summarize error:', err.message);
        res.status(500).json({ error: 'صار خطأ: ' + err.message });
    }
});

app.post('/api/captions', auth, checkUsage, async (req, res) => {
    try {
        const { topic, tone, audience } = req.body;
        if (!topic?.trim() || topic.length < 5) return res.status(400).json({ error: 'اكتب موضوع' });
        const tm = { motivational: 'تحفيزي', funny: 'مرح وطريف', professional: 'احترافي', emotional: 'عاطفي' };
        const am = { general: 'عام', youth: 'شباب', business: 'أعمال', moms: 'أمهات' };
        const sp = `أكتب 10 كابشنات إنستغرام بالعربية لبوست عن: "${topic}". النمط: ${tm[tone]}. الجمهور: ${am[audience]}. كل كابشن قصير (2-3 سطور)، فيه إيموجي وهاشتاغات. افصل بين الكابشنات بسطر فارغ.`;
        const result = await callAI(sp, topic);
        const captions = result.split(/\n\s*\n/).filter(c => c.trim());
        await db.incrementUsage(req.user.id);
        res.json({ result: captions, usage: await db.getUsage(req.user.id) });
    } catch (err) {
        console.error('Captions error:', err.message);
        res.status(500).json({ error: 'صار خطأ: ' + err.message });
    }
});

app.post('/api/translate', auth, checkUsage, async (req, res) => {
    try {
        const { text, from, to, style } = req.body;
        if (!text?.trim() || text.length < 5) return res.status(400).json({ error: 'اكتب نص' });
        const lm = { ar: 'العربية', en: 'الإنجليزية' };
        const sm = { formal: 'رسمية', casual: 'عامية', literary: 'أدبية' };
        const sp = `ترجم النص من ${lm[from]} إلى ${lm[to]} بأسلوب ${sm[style]}. حافظ على المعنى الدقيق. فقط الترجمة.`;
        const result = await callAI(sp, text);
        await db.incrementUsage(req.user.id);
        res.json({ result, usage: await db.getUsage(req.user.id) });
    } catch (err) {
        console.error('Translate error:', err.message);
        res.status(500).json({ error: 'صار خطأ: ' + err.message });
    }
});

// ==================== PAYMENTS ====================
app.post('/api/payment/shamcash', auth, async (req, res) => {
    try {
        const { plan, reference } = req.body;
        const prices = { pro: 7, business: 15 };
        const amount = prices[plan];
        if (!amount) return res.status(400).json({ error: 'خطة غير صحيحة' });

        // Cancel any existing pending subscriptions for this user
        const { Subscription } = require('./db');
        await Subscription.deleteMany({ userId: req.user.id, status: 'pending' });

        const payment = await db.createPayment(req.user.id, amount, 'shamcash', reference);
        const sub = await db.createSubscription(req.user.id, plan, amount, 'shamcash', 'pending');
        console.log('💰 ShamCash payment created:', { id: payment.id, userId: req.user.id, plan, amount, subId: sub.id });
        res.json({ success: true, paymentId: payment.id, subId: sub.id, message: 'تم إرسال طلب الدفع. سيتم التفعيل خلال 24 ساعة.' });
    } catch (err) {
        console.error('ShamCash error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payment/confirm/:id', auth, adminOnly, async (req, res) => {
    try {
        const payment = await db.confirmPayment(req.params.id);
        if (!payment) return res.status(404).json({ error: 'الدفعة غير موجودة' });

        const sub = await db.getUserSubscription(payment.userId);
        // Find pending subscription for this user
        const { Subscription } = require('./db');
        const pendingSub = await Subscription.findOne({ userId: payment.userId, status: 'pending' }).lean();

        if (!pendingSub) {
            return res.status(404).json({ error: 'لا يوجد اشتراك معلق لهاد المستخدم' });
        }

        const activated = await db.activateSubscription(pendingSub.id);
        console.log('✅ Subscription activated:', { subId: pendingSub.id, userId: payment.userId, plan: pendingSub.plan });

        res.json({ 
            success: true, 
            message: 'تم تأكيد الدفع والتفعيل بنجاح',
            userId: payment.userId,
            plan: pendingSub.plan,
            expiresAt: activated.expiresAt
        });
    } catch (err) {
        console.error('Confirm error:', err);
        res.status(500).json({ error: 'صار خطأ: ' + err.message });
    }
});

// ==================== ADMIN ENDPOINTS (PROTECTED) ====================
app.get('/api/admin/pending-payments', auth, adminOnly, async (req, res) => {
    try {
        const pending = await db.getPendingPayments();
        res.json({ 
            success: true, 
            count: pending.length,
            payments: pending.map(p => ({
                id: p.id,
                userId: p.userId,
                amount: p.amount,
                method: p.method,
                reference: p.reference,
                createdAt: p.createdAt
            }))
        });
    } catch (err) {
        console.error('Admin error:', err);
        res.status(500).json({ error: 'صار خطأ' });
    }
});

app.get('/api/usage', auth, async (req, res) => {
    try {
        const user = await db.findUserById(req.user.id);
        const plan = user?.plan || 'free';
        const used = await db.getUsage(req.user.id);
        const limit = db.getUsageLimit(plan);
        res.json({ used, limit, plan, remaining: Math.max(0, limit - used) });
    } catch (err) {
        console.error('Usage error:', err);
        res.status(500).json({ error: 'صار خطأ' });
    }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ==================== TEMPORARY: Make user admin ====================
app.get('/api/make-admin', async (req, res) => {
    try {
        const user = await db.findUser(req.query.email);
        if (!user) return res.json({ error: 'المستخدم غير موجود. سجّل حساب أولاً من الموقع!' });
        await db.updateUserPlan(user.id, 'admin');
        res.json({ success: true, message: 'تم! هلق صرت مشرف', email: user.email, plan: 'admin' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ==================== END TEMPORARY ====================

// Global error handler - always return JSON
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({ error: 'صار خطأ بالسيرفر' });
});

// 404 handler - return JSON
app.use((req, res) => {
    res.status(404).json({ error: 'المسار غير موجود' });
});

// Start server after DB connects
db.connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 لخّصلي Backend شغال على المنفذ ${PORT}`);
    });
});
