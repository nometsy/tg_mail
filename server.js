require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';
const WEB_APP_URL = 'https://tg-mail-fn55.onrender.com';

app.use(express.json());
app.use(express.static('public'));

// --- 1. API: MAIL.TM INTERFACE ---
app.get('/api/create', async (req, res) => {
    try {
        const domains = await axios.get(`${API_URL}/domains`);
        const domain = domains.data['hydra:member'][0].domain;
        const rnd = Math.random().toString(36).substring(7);
        const address = `user${rnd}@${domain}`;
        const password = `pass${rnd}`;

        await axios.post(`${API_URL}/accounts`, { address, password });
        const tokenRes = await axios.post(`${API_URL}/token`, { address, password });
        res.json({ address, token: tokenRes.data.token });
    } catch (e) {
        res.status(500).json({ error: 'Mail.tm API Error' });
    }
});

app.post('/api/check', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json([]);
    try {
        const msgs = await axios.get(`${API_URL}/messages`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(msgs.data['hydra:member']);
    } catch (e) {
        res.status(500).json({ error: 'Check error' });
    }
});

app.post('/api/read', async (req, res) => {
    const { token, id } = req.body;
    try {
        const msg = await axios.get(`${API_URL}/messages/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(msg.data);
    } catch (e) {
        res.status(500).json({ error: 'Read error' });
    }
});

// --- 2. BOT LOGIC ---
bot.command('start', async (ctx) => {
    try {
        // Установка кнопки меню (Web App)
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: '📧 Открыть Почту',
            web_app: { url: WEB_APP_URL }
        });
    } catch (e) {
        console.error('Menu Button Error:', e.message);
    }

    await ctx.replyWithPhoto(
        'https://cdn-icons-png.flaticon.com/512/9664/9664634.png',
        {
            caption: '<b>Добро пожаловать!</b>\n\n' +
                     '📨 Генерация временного адреса\n' +
                     '⚡ Мгновенный приём писем\n' +
                     '🔐 Без хранения данных\n' +
                     '🕶 Полная анонимность\n\n' +
                     'Нажми кнопку ниже, чтобы начать:',
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                Markup.button.webApp('🚀 ЗАПУСТИТЬ СИСТЕМУ', WEB_APP_URL)
            ])
        }
    );
});

// --- 3. LIFECYCLE ---
bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

