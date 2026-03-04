require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;
const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.mail.tm';
const WEB_APP_URL = 'https://tg-mail-fn55.onrender.com';
const MAIL_LIFETIME_MS = 20 * 60 * 1000;
const STREAM_POLL_MS = 15000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS global_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_mailboxes_created INTEGER NOT NULL DEFAULT 0,
    total_unique_messages_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT 'init'
);

CREATE TABLE IF NOT EXISTS active_sessions (
    user_id TEXT PRIMARY KEY,
    mailbox_id INTEGER NOT NULL,
    FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mailbox_seen_messages (
    mailbox_id INTEGER NOT NULL,
    msg_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (mailbox_id, msg_id)
);

CREATE TABLE IF NOT EXISTS mailbox_opened_messages (
    mailbox_id INTEGER NOT NULL,
    msg_id TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    subject TEXT,
    from_addr TEXT,
    sent_at TEXT,
    text_plain TEXT,
    html TEXT,
    PRIMARY KEY (mailbox_id, msg_id)
);

CREATE TABLE IF NOT EXISTS global_seen_messages (
    msg_id TEXT PRIMARY KEY
);
`);

db.prepare(`
INSERT INTO global_stats(id, total_mailboxes_created, total_unique_messages_seen)
VALUES (1, 0, 0)
ON CONFLICT(id) DO NOTHING
`).run();

app.use(express.json());
app.use(express.static('public'));

function nowMs() {
    return Date.now();
}

function toText(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('\n\n');
    return value || '';
}

function toHtml(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('\n<hr/>\n');
    return value || '';
}

function extractOtpCodes(input) {
    const text = String(input || '');
    const matches = text.match(/\b\d{4,8}\b/g) || [];
    const strong = [];

    for (const code of matches) {
        const near = new RegExp(`.{0,24}${code}.{0,24}`, 'i').exec(text);
        const ctx = near ? near[0] : '';
        if (/code|otp|парол|подтверж|verify|verification|login|sign/i.test(ctx)) {
            strong.push(code);
        }
    }

    const merged = [...strong, ...matches];
    const unique = [];
    const seen = new Set();
    for (const code of merged) {
        if (seen.has(code)) continue;
        seen.add(code);
        unique.push(code);
        if (unique.length >= 6) break;
    }

    return unique;
}

function getActiveSession(userId) {
    const row = db.prepare(`
        SELECT m.id, m.user_id, m.address, m.token, m.created_at, m.expires_at, m.reason
        FROM active_sessions s
        JOIN mailboxes m ON m.id = s.mailbox_id
        WHERE s.user_id = ?
    `).get(String(userId));

    if (!row) return null;
    return {
        mailboxId: row.id,
        userId: row.user_id,
        address: row.address,
        token: row.token,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        reason: row.reason
    };
}

function sessionPayload(session) {
    return {
        mailboxId: session.mailboxId,
        address: session.address,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        expiresInMs: Math.max(0, session.expiresAt - nowMs())
    };
}

function isExpired(session) {
    return !session || nowMs() >= session.expiresAt;
}

function clearSession(userId) {
    db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(String(userId));
}

function incrementGlobalStat(field, amount = 1) {
    db.prepare(`UPDATE global_stats SET ${field} = ${field} + ? WHERE id = 1`).run(amount);
}

async function createMailboxAccount() {
    const domains = await axios.get(`${API_URL}/domains`);
    const domain = domains.data['hydra:member'][0].domain;
    const rnd = Math.random().toString(36).substring(2, 10);
    const address = `user${rnd}@${domain}`;
    const password = `pass${rnd}`;

    await axios.post(`${API_URL}/accounts`, { address, password });
    const tokenRes = await axios.post(`${API_URL}/token`, { address, password });

    return { address, token: tokenRes.data.token };
}

async function rotateMailbox(userId, reason = 'manual') {
    const { address, token } = await createMailboxAccount();
    const createdAt = nowMs();
    const expiresAt = createdAt + MAIL_LIFETIME_MS;

    const insert = db.prepare(`
        INSERT INTO mailboxes (user_id, address, token, created_at, expires_at, reason)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(userId), address, token, createdAt, expiresAt, reason);

    const mailboxId = Number(insert.lastInsertRowid);
    db.prepare(`
        INSERT INTO active_sessions (user_id, mailbox_id)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET mailbox_id = excluded.mailbox_id
    `).run(String(userId), mailboxId);

    incrementGlobalStat('total_mailboxes_created', 1);

    return {
        mailboxId,
        userId: String(userId),
        address,
        token,
        createdAt,
        expiresAt,
        reason
    };
}

function getMailboxStats(mailboxId) {
    const seen = db.prepare('SELECT COUNT(*) AS c FROM mailbox_seen_messages WHERE mailbox_id = ?').get(mailboxId).c;
    const opened = db.prepare('SELECT COUNT(*) AS c FROM mailbox_opened_messages WHERE mailbox_id = ?').get(mailboxId).c;
    return { seen, opened };
}

function trackSeenMessages(mailboxId, messages) {
    const addMailbox = db.prepare(`
        INSERT INTO mailbox_seen_messages (mailbox_id, msg_id, first_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(mailbox_id, msg_id) DO NOTHING
    `);
    const addGlobal = db.prepare(`
        INSERT INTO global_seen_messages (msg_id)
        VALUES (?)
        ON CONFLICT(msg_id) DO NOTHING
    `);

    const newlySeenIds = [];
    let newGlobal = 0;

    for (const msg of messages) {
        if (!msg || !msg.id) continue;
        const mailboxInsert = addMailbox.run(mailboxId, msg.id, nowMs());
        if (mailboxInsert.changes > 0) newlySeenIds.push(msg.id);

        const globalInsert = addGlobal.run(msg.id);
        if (globalInsert.changes > 0) newGlobal += 1;
    }

    if (newGlobal > 0) incrementGlobalStat('total_unique_messages_seen', newGlobal);
    return newlySeenIds;
}

function saveOpenedMessage(mailboxId, msgId, payload) {
    db.prepare(`
        INSERT INTO mailbox_opened_messages (
            mailbox_id, msg_id, opened_at, subject, from_addr, sent_at, text_plain, html
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mailbox_id, msg_id) DO UPDATE SET
            opened_at = excluded.opened_at,
            subject = excluded.subject,
            from_addr = excluded.from_addr,
            sent_at = excluded.sent_at,
            text_plain = excluded.text_plain,
            html = excluded.html
    `).run(
        mailboxId,
        msgId,
        nowMs(),
        payload.subject,
        payload.from,
        payload.date,
        payload.textPlain,
        payload.html
    );
}

function buildStats(userId) {
    const global = db.prepare('SELECT total_mailboxes_created, total_unique_messages_seen FROM global_stats WHERE id = 1').get();
    const session = getActiveSession(userId);
    const activeSessions = db.prepare('SELECT COUNT(*) AS c FROM active_sessions').get().c;

    if (!session) {
        return {
            totalMailboxesCreated: global.total_mailboxes_created,
            totalUniqueMessagesSeen: global.total_unique_messages_seen,
            currentMailboxSeen: 0,
            currentMailboxOpened: 0,
            activeSessions
        };
    }

    const mailboxStats = getMailboxStats(session.mailboxId);
    return {
        totalMailboxesCreated: global.total_mailboxes_created,
        totalUniqueMessagesSeen: global.total_unique_messages_seen,
        currentMailboxSeen: mailboxStats.seen,
        currentMailboxOpened: mailboxStats.opened,
        activeSessions
    };
}

function sendSse(res, event, payload) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function requireAdmin(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(403).json({ error: 'AdminDisabled' });
    }

    const token = req.get('x-admin-token') || '';
    if (token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'AdminUnauthorized' });
    }

    return next();
}

app.post('/api/init', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    try {
        let session = getActiveSession(userId);

        if (!session) {
            session = await rotateMailbox(userId, 'init');
        } else if (isExpired(session)) {
            session = await rotateMailbox(userId, 'expired');
        }

        return res.json(sessionPayload(session));
    } catch (_) {
        return res.status(500).json({ error: 'MailAPI Error' });
    }
});

app.post('/api/rotate', async (req, res) => {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    try {
        const session = await rotateMailbox(userId, reason || 'manual');
        return res.json(sessionPayload(session));
    } catch (_) {
        return res.status(500).json({ error: 'MailAPI Error' });
    }
});

app.post('/api/extend', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    const session = getActiveSession(userId);
    if (!session) return res.status(401).send('Unauthorized');
    if (isExpired(session)) {
        clearSession(userId);
        return res.status(410).json({ error: 'SessionExpired' });
    }

    const nextExpiresAt = session.expiresAt + MAIL_LIFETIME_MS;
    db.prepare('UPDATE mailboxes SET expires_at = ? WHERE id = ?').run(nextExpiresAt, session.mailboxId);

    const updated = getActiveSession(userId);
    return res.json(sessionPayload(updated));
});

app.post('/api/check', async (req, res) => {
    const { userId } = req.body;
    const session = getActiveSession(userId);
    if (!session) return res.json([]);

    if (isExpired(session)) {
        clearSession(userId);
        return res.status(410).json({ error: 'SessionExpired' });
    }

    try {
        const msgs = await axios.get(`${API_URL}/messages`, {
            headers: { Authorization: `Bearer ${session.token}` }
        });
        const list = msgs.data['hydra:member'] || [];
        trackSeenMessages(session.mailboxId, list);
        return res.json(list);
    } catch (_) {
        return res.status(500).json([]);
    }
});

app.post('/api/message', async (req, res) => {
    const { userId, msgId } = req.body;
    if (!msgId) return res.status(400).json({ error: 'msgId is required' });

    const session = getActiveSession(userId);
    if (!session) return res.status(401).send('Unauthorized');

    if (isExpired(session)) {
        clearSession(userId);
        return res.status(410).json({ error: 'SessionExpired' });
    }

    try {
        const response = await axios.get(`${API_URL}/messages/${msgId}`, {
            headers: { Authorization: `Bearer ${session.token}` }
        });

        const textPlain = toText(response.data.text);
        const html = toHtml(response.data.html);
        const fallbackText = textPlain || html || '';

        const payload = {
            text: fallbackText,
            textPlain,
            html,
            from: response.data.from?.address || 'unknown',
            subject: response.data.subject || '(без темы)',
            date: response.data.createdAt || null,
            otpCodes: extractOtpCodes(`${fallbackText}\n${response.data.subject || ''}`)
        };

        saveOpenedMessage(session.mailboxId, msgId, payload);
        return res.json(payload);
    } catch (_) {
        return res.status(500).json({ error: 'Read Error' });
    }
});

app.post('/api/stats', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    return res.json(buildStats(userId));
});

app.post('/api/history', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    const rows = db.prepare(`
        SELECT
            m.id,
            m.address,
            m.created_at,
            m.expires_at,
            m.reason,
            (SELECT COUNT(*) FROM mailbox_seen_messages s WHERE s.mailbox_id = m.id) AS seen_count,
            (SELECT COUNT(*) FROM mailbox_opened_messages o WHERE o.mailbox_id = m.id) AS opened_count
        FROM mailboxes m
        WHERE m.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT 15
    `).all(String(userId));

    return res.json(rows.map((r) => ({
        mailboxId: r.id,
        address: r.address,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        reason: r.reason,
        seenCount: r.seen_count,
        openedCount: r.opened_count
    })));
});

app.post('/api/reset', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('Unauthorized');

    clearSession(userId);
    return res.sendStatus(200);
});

app.get('/api/export', (req, res) => {
    const userId = req.query.userId;
    const msgId = req.query.msgId;
    const format = String(req.query.format || 'txt').toLowerCase();

    if (!userId || !msgId) return res.status(400).send('Missing params');

    const row = db.prepare(`
        SELECT o.subject, o.from_addr, o.sent_at, o.text_plain, o.html
        FROM mailbox_opened_messages o
        JOIN mailboxes m ON m.id = o.mailbox_id
        WHERE m.user_id = ? AND o.msg_id = ?
        ORDER BY o.opened_at DESC
        LIMIT 1
    `).get(String(userId), String(msgId));

    if (!row) return res.status(404).send('Message not found');

    const safeMsg = String(msgId).replace(/[^a-zA-Z0-9_-]/g, '_');

    if (format === 'html') {
        const html = row.html || `<pre>${row.text_plain || ''}</pre>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="mail-${safeMsg}.html"`);
        return res.send(html);
    }

    const txt = [
        `From: ${row.from_addr || ''}`,
        `Subject: ${row.subject || ''}`,
        `Date: ${row.sent_at || ''}`,
        '',
        row.text_plain || ''
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mail-${safeMsg}.txt"`);
    return res.send(txt);
});

app.get('/api/stream', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let closed = false;
    let busy = false;

    const tick = async () => {
        if (closed || busy) return;
        busy = true;

        try {
            const session = getActiveSession(userId);

            if (!session) {
                sendSse(res, 'no_session', { ok: true });
                busy = false;
                return;
            }

            if (isExpired(session)) {
                clearSession(userId);
                sendSse(res, 'session_expired', { expired: true });
                busy = false;
                return;
            }

            const response = await axios.get(`${API_URL}/messages`, {
                headers: { Authorization: `Bearer ${session.token}` }
            });

            const list = response.data['hydra:member'] || [];
            trackSeenMessages(session.mailboxId, list);
            sendSse(res, 'inbox', {
                messages: list,
                session: sessionPayload(session),
                stats: buildStats(userId)
            });
        } catch (_) {
            sendSse(res, 'error', { error: true });
        }

        busy = false;
    };

    sendSse(res, 'connected', { ok: true, at: nowMs() });
    await tick();
    const interval = setInterval(tick, STREAM_POLL_MS);

    req.on('close', () => {
        closed = true;
        clearInterval(interval);
    });
});

app.get('/api/admin/summary', requireAdmin, (req, res) => {
    const global = db.prepare('SELECT total_mailboxes_created, total_unique_messages_seen FROM global_stats WHERE id = 1').get();
    const activeSessions = db.prepare('SELECT COUNT(*) AS c FROM active_sessions').get().c;

    const recent = db.prepare(`
        SELECT user_id, address, created_at, expires_at, reason
        FROM mailboxes
        ORDER BY created_at DESC
        LIMIT 20
    `).all();

    const topUsers = db.prepare(`
        SELECT user_id, COUNT(*) AS mailbox_count
        FROM mailboxes
        GROUP BY user_id
        ORDER BY mailbox_count DESC
        LIMIT 10
    `).all();

    return res.json({
        uptimeSec: Math.floor(process.uptime()),
        activeSessions,
        totalMailboxesCreated: global.total_mailboxes_created,
        totalUniqueMessagesSeen: global.total_unique_messages_seen,
        recentMailboxes: recent,
        topUsers
    });
});

app.get('/admin', (req, res) => {
    if (!ADMIN_TOKEN) {
        return res.status(403).type('html').send('<h1>Admin panel is disabled: ADMIN_TOKEN is not set</h1>');
    }

    res.type('html').send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>MINE MAIL ADMIN</title>
<style>
body{font-family:monospace;background:#111;color:#eee;margin:0;padding:16px}
.box{border:2px solid #444;padding:12px;margin-bottom:12px;background:#1b1b1b}
h1{margin:0 0 12px;color:#ffd24a}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.stat{border:1px solid #555;background:#151515;padding:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #444;padding:6px;text-align:left}
button{padding:8px 12px;background:#333;color:#fff;border:1px solid #555;cursor:pointer}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>MINE MAIL ADMIN</h1>
<div class="box">
  <label for="token">ADMIN TOKEN:</label>
  <input id="token" type="password" style="margin-left:8px;padding:6px;background:#0f0f0f;color:#fff;border:1px solid #555;" />
  <button id="save">Сохранить токен</button>
  <button id="reload">Обновить</button>
</div>
<div class="box grid">
  <div class="stat">Uptime: <span id="u"></span></div>
  <div class="stat">Active sessions: <span id="a"></span></div>
  <div class="stat">Mailboxes: <span id="m"></span></div>
  <div class="stat">Unique messages: <span id="msg"></span></div>
</div>
<div class="box"><h3>Последние ротации</h3><table><thead><tr><th>User</th><th>Address</th><th>Created</th><th>Reason</th></tr></thead><tbody id="recent"></tbody></table></div>
<div class="box"><h3>Топ пользователей</h3><table><thead><tr><th>User</th><th>Mailboxes</th></tr></thead><tbody id="users"></tbody></table></div>
<script>
const tokenInput=document.getElementById('token');
tokenInput.value=localStorage.getItem('admin_token')||'';
document.getElementById('save').onclick=()=>{
 localStorage.setItem('admin_token', tokenInput.value || '');
};

async function load(){
 const token=localStorage.getItem('admin_token')||'';
 const r=await fetch('/api/admin/summary',{headers:{'x-admin-token':token}});
 if(!r.ok){document.body.innerHTML='<h1>Access denied</h1>';return;}
 const d=await r.json();
 document.getElementById('u').textContent=d.uptimeSec+'s';
 document.getElementById('a').textContent=d.activeSessions;
 document.getElementById('m').textContent=d.totalMailboxesCreated;
 document.getElementById('msg').textContent=d.totalUniqueMessagesSeen;
 document.getElementById('recent').innerHTML=d.recentMailboxes.map(x=>'<tr><td>'+x.user_id+'</td><td>'+x.address+'</td><td>'+new Date(x.created_at).toLocaleString('ru-RU')+'</td><td>'+x.reason+'</td></tr>').join('');
 document.getElementById('users').innerHTML=d.topUsers.map(x=>'<tr><td>'+x.user_id+'</td><td>'+x.mailbox_count+'</td></tr>').join('');
}
document.getElementById('reload').onclick=load;
load();
</script>
</body>
</html>`);
});

function startBot() {
    if (!bot) {
        console.warn('BOT_TOKEN is missing, Telegram bot launch skipped.');
        return;
    }

    bot.command('start', async (ctx) => {
        try {
            await ctx.setChatMenuButton({
                type: 'web_app',
                text: '⛏ Почтовый верстак',
                web_app: { url: WEB_APP_URL }
            });

            await ctx.replyWithPhoto(
                'https://cdn-icons-png.flaticon.com/512/9664/9664634.png',
                {
                    caption: '<b>⛏ MINE MAIL: Почтовый верстак</b>\n\n' +
                             '📮 Интерфейс miniapp полностью на русском\n' +
                             '📊 Статистика и история ротаций\n' +
                             '📖 Красивое чтение писем + OTP\n' +
                             '♻️ Автосмена и продление сессии\n\n' +
                             'Нажми кнопку ниже и открой верстак:',
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        Markup.button.webApp('Открыть MINE MAIL ⛏', WEB_APP_URL)
                    ])
                }
            );
        } catch (e) {
            console.error(e);
        }
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
