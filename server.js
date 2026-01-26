require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';
const WEB_APP_URL = 'https://tg-mail-fn55.onrender.com';

// Временное хранилище в памяти сервера
const sessions = {}; 

app.use(express.json());
app.use(express.static('public'));

// Создание или получение почты для конкретного userId
app.post('/api/init', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('No ID');

    // Если у пользователя уже есть активная почта в памяти — отдаем её
    if (sessions[userId]) {
        return res.json(sessions[userId]);
    }

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
        res.status(500).json({ error: 'API Error' });
    }
});

// Проверка почты только для владельца userId
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

// Сброс почты (RESET)
app.post('/api/reset', (req, res) => {
    const { userId } = req.body;
    delete sessions[userId];
    res.sendStatus(200);
});

bot.command('start', async (ctx) => {
    await ctx.setChatMenuButton({
        type: 'web_app',
        text: '📧 Открыть Почту',
        web_app: { url: WEB_APP_URL }
    });
    await ctx.reply('<b>Система готова.</b>\nИспользуй кнопку меню для входа.', { 
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([Markup.button.webApp('🚀 ЗАПУСТИТЬ', WEB_APP_URL)])
    });
});

bot.launch();
app.listen(PORT, () => console.log(`Server live on ${PORT}`));
