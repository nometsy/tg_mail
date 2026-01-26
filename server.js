require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';

app.use(express.json());
app.use(express.static('public'));

// --- 1. API: СОЗДАНИЕ ПОЧТЫ ---
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
        console.error('Create Error:', e.message);
        res.status(500).json({ error: 'Create error' });
    }
});

// --- 2. API: СПИСОК ПИСЕМ ---
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

// --- 3. API: ЧТЕНИЕ ПИСЬМА ---
app.post('/api/read', async (req, res) => {
    const { token, id } = req.body;
    if (!token || !id) return res.status(400).json({ error: 'No data' });

    try {
        const msg = await axios.get(`${API_URL}/messages/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        res.json(msg.data);
    } catch (e) {
        res.status(500).json({ error: 'Read error' });
    }
});

// --- БОТ: СТАРТ ---
bot.command('start', async (ctx) => {
    // 1. Кнопка меню
    try {
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: '📧 Открыть Почту',
            web_app: { url: process.env.APP_URL }
        });
    } catch (e) {
        console.log('Menu Error');
    }

    // 2. Красивое сообщение
    await ctx.replyWithPhoto(
        // Ссылка на картинку (можешь заменить на свою)
        'https://cdn-icons-png.flaticon.com/512/9664/9664634.png', 
        {
            caption: `<b>Добро пожаловать!</b>

📨 Генерация временного адреса
⚡ Мгновенный приём писем
🔐 Без хранения данных
🕶 Полная анонимность

Нажми кнопку ниже, чтобы начать:`,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                Markup.button.webApp('🚀 ЗАПУСТИТЬ СИСТЕМУ', process.env.APP_URL)
            ])
        }
    );
});

// --- ЗАПУСК ---
bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
