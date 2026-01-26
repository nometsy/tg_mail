require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';
const WEB_APP_URL = 'https://tg-mail-fn55.onrender.com';

// Isolated In-Memory Storage
const sessions = {}; 

app.use(express.json());
app.use(express.static('public'));

// --- API LAYER (WEB APP INTERFACE) ---

app.post('/api/init', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');
    
    // Возврат существующей сессии для конкретного User ID
    if (sessions[userId]) return res.json(sessions[userId]);

    try {
        const domains = await axios.get(`${API_URL}/domains`);
        const domain = domains.data['hydra:member'][0].domain;
        const rnd = Math.random().toString(36).substring(7);
        const address = `user${rnd}@${domain}`;
        const password = `pass${rnd}`;

        await axios.post(`${API_URL}/accounts`, { address, password });
        const tokenRes = await axios.post(`${API_URL}/token`, { address, password });
        
        sessions[userId] = { address, token: tokenRes.data.token };
        res.json(sessions[userId]);
    } catch (e) {
        res.status(500).json({ error: 'MailAPI unreachable' });
    }
});

app.post('/api/check', async (req, res) => {
    const { userId } = req.body;
    const user = sessions[userId];
    if (!user) return res.json([]);

    try {
        const msgs = await axios.get(`${API_URL}/messages`, {
            headers: { Authorization: `Bearer ${user.token}` }
        });
        res.json(msgs.data['hydra:member']);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/api/reset', (req, res) => {
    const { userId } = req.body;
    delete sessions[userId];
    res.sendStatus(200);
});

// --- BOT LAYER (TELEGRAM UI) ---

bot.command('start', async (ctx) => {
    try {
        // Уменьшенная кнопка меню
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: '📧 Почта',
            web_app: { url: WEB_APP_URL }
        });

        // Парадное приветствие с обновленной кнопкой
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
                    Markup.button.webApp('Получить email 📧', WEB_APP_URL)
                ])
            }
        );
    } catch (e) {
        console.error('Bot Start Error:', e.message);
    }
});

// --- RUNTIME ---

bot.launch();
app.listen(PORT, () => console.log(`Server performance optimized on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

