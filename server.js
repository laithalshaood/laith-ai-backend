const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const db = require('./db');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'laith-secret-2026';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_KEY) {
    console.error('❌ OPENAI_API_KEY not set!');
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

function checkUsage(req, res, next) {
    const userId = req.user?.id;
    const user = db.findUserById(userId);
    const plan = user?.plan || 'free';
    const used = db.getUsage(userId);
    const limit = db.getUsageLimit(plan);
    if (used >= limit) {
        return res.status(429).json({ error: 'استنفذت استخداماتك اليومية', plan, used, limit });
    }
    next();
}

// OpenAI call
async function callOpenAI(systemPrompt, userPrompt) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 2000
        })
    });
    if (!res.ok) throw new Error('OpenAI error');
    const data = await res.json();
    return data.choices[0].message.content;
}

// Auth
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    const user = db.createUser(email, password, name);
    if (!user) return res.status(400).json({ error: 'الإيميل مستخدم مسبقاً' });
    const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.findUser(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'إيميل أو كلمة مرور غلط' });
    }
    const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
});

app.get('/api/auth/me', auth, (req, res) => {
    const user = db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'غير موجود' });
    const sub = db.getUserSubscription(req.user.id);
    res.json({ user: { id: user.id, email: user.email, name: user.name, plan: user.plan }, subscription: sub });
});

// AI APIs
app.post('/api/summarize', auth, checkUsage, async (req, res) => {
    try {
        const { text, length, style } = req.body;
        if (!text?.trim() || text.length < 10) return res.status(400).json({ error: 'النص قصير جداً' });
        const lm = { short: 'جملتين فقط', medium: 'فقرة واحدة', long: '3-4 فقرات' };
        const sm = { academic: 'أكاديمي', simple: 'بسيط', bullet: 'نقاط رئيسية' };
        const sp = `أنت مساعد ذكي متخصص في تلخيص النصوص العربية. لخّص النص بأسلوب ${sm[style]} وطول ${lm[length]}. حافظ على الأفكار الرئيسية.`;
        const result = await callOpenAI(sp, text);
        db.incrementUsage(req.user.id);
        res.json({ result, usage: db.getUsage(req.user.id) });
    } catch (err) { res.status(500).json({ error: 'صار خطأ' }); }
});

app.post('/api/captions', auth, checkUsage, async (req, res) => {
    try {
        const { topic, tone, audience } = req.body;
        if (!topic?.trim() || topic.length < 5) return res.status(400).json({ error: 'اكتب موضوع' });
        const tm = { motivational: 'تحفيزي', funny: 'مرح وطريف', professional: 'احترافي', emotional: 'عاطفي' };
        const am = { general: 'عام', youth: 'شباب', business: 'أعمال', moms: 'أمهات' };
        const sp = `أكتب 10 كابشنات إنستغرام بالعربية لبوست عن: "${topic}". النمط: ${tm[tone]}. الجمهور: ${am[audience]}. كل كابشن قصير (2-3 سطور)، فيه إيموجي وهاشتاغات. افصل بين الكابشنات بسطر فارغ.`;
        const result = await callOpenAI(sp, topic);
        const captions = result.split(/\n\n/).filter(c => c.trim());
        db.incrementUsage(req.user.id);
        res.json({ result: captions, usage: db.getUsage(req.user.id) });
    } catch (err) { res.status(500).json({ error: 'صار خطأ' }); }
});

app.post('/api/translate', auth, checkUsage, async (req, res) => {
    try {
        const { text, from, to, style } = req.body;
        if (!text?.trim() || text.length < 5) return res.status(400).json({ error: 'اكتب نص' });
        const lm = { ar: 'العربية', en: 'الإنجليزية' };
        const sm = { formal: 'رسمية', casual: 'عامية', literary: 'أدبية' };
        const sp = `ترجم النص من ${lm[from]} إلى ${lm[to]} بأسلوب ${sm[style]}. حافظ على المعنى الدقيق. فقط الترجمة.`;
        const result = await callOpenAI(sp, text);
        db.incrementUsage(req.user.id);
        res.json({ result, usage: db.getUsage(req.user.id) });
    } catch (err) { res.status(500).json({ error: 'صار خطأ' }); }
});

// Payments
app.post('/api/payment/shamcash', auth, async (req, res) => {
    try {
        const { plan, reference } = req.body;
        const prices = { pro: 7, business: 15 };
        const amount = prices[plan];
        if (!amount) return res.status(400).json({ error: 'خطة غير صحيحة' });
        const payment = db.createPayment(req.user.id, amount, 'shamcash', reference);
        db.createSubscription(req.user.id, plan, amount, 'shamcash', 'pending');
        res.json({ success: true, paymentId: payment.id, message: 'تم إرسال طلب الدفع. سيتم التفعيل خلال 24 ساعة.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/payment/confirm/:id', async (req, res) => {
    const payment = db.confirmPayment(req.params.id);
    if (!payment) return res.status(404).json({ error: 'غير موجود' });
    const dbData = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data.json')));
    const sub = dbData.subscriptions.find(s => s.userId === payment.userId && s.status === 'pending');
    if (sub) db.activateSubscription(sub.id);
    res.json({ success: true, message: 'تم تأكيد الدفع والتفعيل' });
});

app.get('/api/usage', auth, (req, res) => {
    const user = db.findUserById(req.user.id);
    const plan = user?.plan || 'free';
    const used = db.getUsage(req.user.id);
    const limit = db.getUsageLimit(plan);
    res.json({ used, limit, plan, remaining: Math.max(0, limit - used) });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
    console.log(`🚀 لخّصلي Backend شغال على المنفذ ${PORT}`);
});
