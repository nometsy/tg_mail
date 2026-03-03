require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';
const WEB_APP_URL = 'https://tg-mail-fn55.onrender.com';
const MAIL_LIFETIME_MS = 20 * 60 * 1000;

// Изолированное хранилище сессий (User ID -> Account Data)
const sessions = {};
const stats = {
    totalMailboxesCreated: 0,
    totalUniqueMessagesSeen: 0
};
const globalSeenMessageIds = new Set();

app.use(express.json());
app.use(express.static('public'));

function toText(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('\n\n');
    return value || '';
}

function isExpired(session) {
    return !session || (Date.now() - session.createdAt) >= MAIL_LIFETIME_MS;
}

async function createMailbox() {
    const domains = await axios.get(`${API_URL}/domains`);
    const domain = domains.data['hydra:member'][0].domain;
    const rnd = Math.random().toString(36).substring(2, 10);
    const address = `user${rnd}@${domain}`;
    const password = `pass${rnd}`;

    await axios.post(`${API_URL}/accounts`, { address, password });
    const tokenRes = await axios.post(`${API_URL}/token`, { address, password });

    stats.totalMailboxesCreated += 1;
    return {
        address,
        token: tokenRes.data.token,
        createdAt: Date.now(),
        seenMessageIds: new Set(),
        openedMessageIds: new Set()
    };
}

function sessionPayload(session) {
    return {
        address: session.address,
        createdAt: session.createdAt,
        expiresInMs: Math.max(0, MAIL_LIFETIME_MS - (Date.now() - session.createdAt))
    };
}

function trackMessages(session, messages) {
    for (const message of messages) {
        if (!message || !message.id) continue;
        session.seenMessageIds.add(message.id);
        if (!globalSeenMessageIds.has(message.id)) {
            globalSeenMessageIds.add(message.id);
            stats.totalUniqueMessagesSeen += 1;
        }
    }
}

// --- API ЭНДПОИНТЫ ---

// Инициализация/получение адреса для конкретного пользователя
app.post('/api/init', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    try {
        const existing = sessions[userId];
        if (existing && !isExpired(existing)) return res.json(sessionPayload(existing));

        sessions[userId] = await createMailbox();
        res.json(sessionPayload(sessions[userId]));
    } catch (e) {
        res.status(500).json({ error: 'MailAPI Error' });
    }
});

app.post('/api/rotate', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    try {
        sessions[userId] = await createMailbox();
        res.json(sessionPayload(sessions[userId]));
    } catch (e) {
        res.status(500).json({ error: 'MailAPI Error' });
    }
});

// Проверка списка писем
app.post('/api/check', async (req, res) => {
    const { userId } = req.body;
    const user = sessions[userId];
    if (!user) return res.json([]);
    if (isExpired(user)) {
        delete sessions[userId];
        return res.status(410).json({ error: 'SessionExpired' });
    }
    try {
        const msgs = await axios.get(`${API_URL}/messages`, {
            headers: { Authorization: `Bearer ${user.token}` }
        });
        const list = msgs.data['hydra:member'] || [];
        trackMessages(user, list);
        res.json(list);
    } catch (e) { res.status(500).json([]); }
});

// Получение содержимого конкретного письма
app.post('/api/message', async (req, res) => {
    const { userId, msgId } = req.body;
    const user = sessions[userId];
    if (!user) return res.status(401).send('Unauthorized');
    if (isExpired(user)) {
        delete sessions[userId];
        return res.status(410).json({ error: 'SessionExpired' });
    }

    try {
        const response = await axios.get(`${API_URL}/messages/${msgId}`, {
            headers: { Authorization: `Bearer ${user.token}` }
        });
        user.openedMessageIds.add(msgId);
        const plainText = toText(response.data.text);
        const htmlText = toText(response.data.html);

        res.json({
            text: plainText || htmlText,
            textPlain: plainText,
            html: htmlText,
            from: response.data.from?.address || 'unknown',
            subject: response.data.subject || '(без темы)',
            date: response.data.createdAt || null
        });
    } catch (e) {
        res.status(500).json({ error: 'Read Error' });
    }
});

app.post('/api/stats', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');
    const user = sessions[userId];

    res.json({
        totalMailboxesCreated: stats.totalMailboxesCreated,
        totalUniqueMessagesSeen: stats.totalUniqueMessagesSeen,
        currentMailboxSeen: user ? user.seenMessageIds.size : 0,
        currentMailboxOpened: user ? user.openedMessageIds.size : 0
    });
});

// Сброс (удаление сессии)
app.post('/api/reset', (req, res) => {
    const { userId } = req.body;
    delete sessions[userId];
    res.sendStatus(200);
});

// --- ЛОГИКА БОТА ---

function startBot() {
    if (!bot) {
        console.warn('BOT_TOKEN is missing, Telegram bot launch skipped.');
        return;
    }

    bot.command('start', async (ctx) => {
        try {
            await ctx.setChatMenuButton({
                type: 'web_app',
                text: '📧 Почта',
                web_app: { url: WEB_APP_URL }
            });

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
        } catch (e) { console.error(e); }
    });

    bot.launch();
}

function startServer(port = PORT) {
    return app.listen(port, () => console.log(`Server live on ${port}`));
}

if (require.main === module) {
    startBot();
    startServer();
}

module.exports = { app, startServer, startBot };
