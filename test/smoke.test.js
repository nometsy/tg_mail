const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server');

let server;
let baseUrl;

test.before(async () => {
    server = startServer(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
});

test('POST /api/init returns 400 without userId', async () => {
    const res = await fetch(`${baseUrl}/api/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });

    const text = await res.text();
    assert.equal(res.status, 400);
    assert.equal(text, 'Unauthorized');
});

test('POST /api/check returns empty array for unknown user session', async () => {
    const res = await fetch(`${baseUrl}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 1 })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
});

test('POST /api/message returns 401 for unknown user session', async () => {
    const res = await fetch(`${baseUrl}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 1, msgId: 'abc' })
    });

    const text = await res.text();
    assert.equal(res.status, 401);
    assert.equal(text, 'Unauthorized');
});

test('POST /api/reset returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 1 })
    });

    assert.equal(res.status, 200);
});
