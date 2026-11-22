#!/usr/bin/env node
'use strict';

/**
 * Mock WAHA (WhatsApp HTTP API) server for trying WhatsApp notifications without a WhatsApp
 * account. It answers the endpoints the dashboard uses and shows every message it "sent" on a page.
 *
 *   npm run mock:waha        (http://localhost:4300, API key "demo", session "default")
 *
 * On the Notifications page enter the server http://localhost:4300, API key demo and session
 * default, then add a recipient with any number (numbers starting with 999 are "not on WhatsApp").
 * Open http://localhost:4300 to see the messages. GET /mock/down?seconds=120 makes the server
 * answer 503 for a while, to see messages wait and go out once it is back; GET /mock/session?status=
 * SCAN_QR_CODE changes the session's status.
 */

const http = require('http');

const PORT = Number(process.env.MOCK_WAHA_PORT) || 4300;
const API_KEY = process.env.MOCK_WAHA_API_KEY === undefined ? 'demo' : process.env.MOCK_WAHA_API_KEY;
const SESSION = { name: 'default', status: 'WORKING', me: { id: '96170000000@c.us', pushName: 'Mock WAHA' }, engine: { engine: 'NOWEB' } };
const GROUPS = [
  { id: '120363000000000001@g.us', subject: 'Home' },
  { id: '120363000000000002@g.us', subject: 'Family' },
];
const messages = [];
let downUntil = 0;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// WhatsApp's *bold* and _italic_.
const wa = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>');

function page() {
  const list = messages
    .slice()
    .reverse()
    .map((m) => `<div class="msg"><div class="to">To ${esc(m.chatId)} · ${esc(new Date(m.ts).toLocaleString())}</div><div class="text">${wa(m.text)}</div></div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock WAHA</title><meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui,sans-serif;background:#0b141a;color:#e9edef;margin:0;padding:16px}h1{font-size:18px}.msg{background:#005c4b;border-radius:8px;padding:8px 12px;margin:10px 0;max-width:560px;margin-left:auto}.to{font-size:12px;opacity:.7;margin-bottom:4px}.text{white-space:pre-wrap;line-height:1.4}.empty{opacity:.6}</style></head>
<body><h1>Mock WAHA · session “${esc(SESSION.name)}” is ${esc(SESSION.status)}${Date.now() < downUntil ? ' · DOWN' : ''}</h1>${list || '<p class="empty">No messages yet. The page refreshes every 5 seconds.</p>'}</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (p === '/' && req.method === 'GET') return send(res, 200, page(), 'text/html; charset=utf-8');
  if (p === '/mock/messages') return send(res, 200, messages);
  if (p === '/mock/down') {
    downUntil = Date.now() + (Number(url.searchParams.get('seconds')) || 60) * 1000;
    return send(res, 200, { downUntil });
  }
  if (p === '/mock/session') {
    SESSION.status = url.searchParams.get('status') || 'WORKING';
    return send(res, 200, SESSION);
  }
  if (!p.startsWith('/api/')) return send(res, 404, { message: 'Not found' });
  if (Date.now() < downUntil) return send(res, 503, { message: 'Service unavailable (mock outage)' });
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return send(res, 401, { message: 'Unauthorized' });

  if (p === '/api/server/version') return send(res, 200, { version: '2025.1.0-mock', engine: 'NOWEB', tier: 'CORE' });
  if (p === '/api/sessions' && req.method === 'GET') return send(res, 200, [SESSION]);
  let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') return decodeURIComponent(m[1]) === SESSION.name ? send(res, 200, SESSION) : send(res, 404, { message: 'Session not found' });
  m = /^\/api\/([^/]+)\/groups$/.exec(p);
  if (m && req.method === 'GET') return decodeURIComponent(m[1]) === SESSION.name ? send(res, 200, GROUPS) : send(res, 404, { message: 'Session not found' });
  if (p === '/api/contacts/check-exists') {
    const phone = String(url.searchParams.get('phone') || '');
    return send(res, 200, { numberExists: !phone.startsWith('999'), chatId: `${phone}@c.us` });
  }
  if (p === '/api/sendText' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.chatId || !body.text) return send(res, 400, { message: 'chatId and text are required' });
    if ((body.session || 'default') !== SESSION.name) return send(res, 404, { message: 'Session not found' });
    if (SESSION.status !== 'WORKING') return send(res, 422, { message: `Session status is not as expected. Try again later or restart the session. (status: ${SESSION.status})` });
    if (!/^\d+@c\.us$|@g\.us$|@lid$|@s\.whatsapp\.net$/.test(body.chatId)) return send(res, 400, { message: `Invalid chatId: ${body.chatId}` });
    if (/^999/.test(body.chatId)) return send(res, 400, { message: 'The number is not on WhatsApp' });
    const msg = { id: `true_${body.chatId}_${Date.now().toString(16).toUpperCase()}`, chatId: body.chatId, text: body.text, ts: Date.now() };
    messages.push(msg);
    if (messages.length > 500) messages.shift();
    console.log(`[mock-waha] → ${body.chatId}\n${body.text.replace(/^/gm, '    ')}`);
    return send(res, 201, { id: { fromMe: true, remote: body.chatId, id: msg.id, _serialized: msg.id }, body: body.text, timestamp: Math.floor(msg.ts / 1000), fromMe: true, to: body.chatId });
  }
  return send(res, 404, { message: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[mock-waha] Mock WAHA server on http://localhost:${PORT} (API key "${API_KEY}", session "${SESSION.name}")`);
  console.log(`[mock-waha] Open http://localhost:${PORT} to see the messages it "sent".`);
});
