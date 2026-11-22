'use strict';

// Client for WAHA (WhatsApp HTTP API, https://waha.devlike.pro), a self-hosted server that runs a
// WhatsApp session and sends messages from it. The dashboard uses it to send notifications.
//
// Endpoints used: GET /api/sessions/{session} (is the session signed in?), POST /api/sendText,
// GET /api/contacts/check-exists (is a number on WhatsApp?), GET /api/{session}/groups and
// GET /api/server/version. Every request carries the API key in X-Api-Key when one is set.

const TIMEOUT_MS = 20000;

class WahaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** A WhatsApp chat ID from what someone typed: a phone number, or an ID as WAHA writes it. */
function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s.replace(/\s+/g, '');
  const digits = s.replace(/[^\d]/g, '').replace(/^00/, '');
  return digits.length >= 6 ? `${digits}@c.us` : '';
}

/** "+961 70 123 456" for 96170123456@c.us; group and other IDs as they are. */
function describeChat(chatId) {
  const m = /^(\d+)@(c\.us|s\.whatsapp\.net)$/.exec(String(chatId || ''));
  return m ? `+${m[1]}` : String(chatId || '');
}

async function request(cfg, method, path, body) {
  if (!cfg || !cfg.url) throw new WahaError('Enter the WAHA server address first');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { Accept: 'application/json' };
  if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${cfg.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    const why = err.name === 'AbortError' ? 'no answer within 20 s' : (err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new WahaError(`Cannot reach the WAHA server (${why})`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && typeof data === 'object' ? data.message || data.error || (data.exception && data.exception.message) : String(text || '').slice(0, 200);
    // 401: no key or a wrong one. 403: a real key that may not do this (e.g. a session key used
    // for another session, or with its read/send permission turned off).
    if (res.status === 401) {
      throw new WahaError(
        cfg.apiKey
          ? 'WAHA says the API key is wrong (401). Copy the whole key again from WAHA (use its copy button, not the masked text) and paste it here.'
          : 'WAHA needs an API key (401). Enter it on this page.',
        401
      );
    }
    if (res.status === 403) {
      throw new WahaError(`WAHA accepted the API key but it isn't allowed to do this (403${detail ? `: ${detail}` : ''}). If it is a session key, check that it is for session "${cfg.session}" and allows reading and sending.`, 403);
    }
    if (res.status === 404 && /\/api\/sessions\//.test(path)) throw new WahaError(`WAHA has no session called "${cfg.session}"`, 404);
    throw new WahaError(`WAHA answered ${res.status}${detail ? `: ${Array.isArray(detail) ? detail.join(', ') : detail}` : ''}`, res.status);
  }
  return data;
}

const session = (cfg) => encodeURIComponent(cfg.session || 'default');

/** { name, status, me: { id, pushName } | null, engine } of the configured session. */
async function sessionStatus(cfg) {
  const s = await request(cfg, 'GET', `/api/sessions/${session(cfg)}`);
  const engine = s && s.engine && typeof s.engine === 'object' ? s.engine.engine : s && s.engine;
  return { name: (s && s.name) || cfg.session, status: (s && s.status) || 'UNKNOWN', me: (s && s.me) || null, engine: engine || null };
}

async function version(cfg) {
  return request(cfg, 'GET', '/api/server/version').catch(() => null);
}

/** Sends a text message. Returns WAHA's answer (the message it sent). */
async function sendText(cfg, chatId, text) {
  const id = toChatId(chatId);
  if (!id) throw new WahaError('Invalid WhatsApp number or chat ID');
  return request(cfg, 'POST', '/api/sendText', { session: cfg.session || 'default', chatId: id, text: String(text), linkPreview: false });
}

/** { exists, chatId } for a phone number. */
async function checkNumber(cfg, phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '').replace(/^00/, '');
  if (digits.length < 6) throw new WahaError('Enter the number with its country code');
  const r = await request(cfg, 'GET', `/api/contacts/check-exists?phone=${digits}&session=${session(cfg)}`);
  return { exists: Boolean(r && r.numberExists), chatId: (r && r.chatId) || `${digits}@c.us` };
}

/** [{ id, name }] of the groups the session's account is in. */
async function groups(cfg) {
  const r = await request(cfg, 'GET', `/api/${session(cfg)}/groups`);
  // Engines differ: a list, or an object keyed by group ID.
  const list = Array.isArray(r) ? r : r && typeof r === 'object' ? Object.entries(r).map(([id, g]) => ({ id, ...(g || {}) })) : [];
  return list
    .map((g) => {
      const id = typeof g.id === 'object' && g.id ? g.id._serialized || g.id.id : g.id || g.JID || g.jid;
      return { id: String(id || ''), name: g.subject || g.name || (g.groupMetadata && g.groupMetadata.subject) || g.Name || String(id || '') };
    })
    .filter((g) => /@g\.us$/.test(g.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { sessionStatus, version, sendText, checkNumber, groups, toChatId, describeChat, WahaError };
