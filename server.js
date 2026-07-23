#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// Connect to the hub bus via the vendored plugin SDK (wks.js). It reads the
// scoped token (HUB_TOKEN / WKS_BUS_TOKEN / .bus-token), subscribes, delivers
// events, and reconnects if the hub goes away. Settings come from the SDK too.
const wks = connect({ source: manifest.id });
const settings = wks.settings;

const TOPICS = manifest.consumes || [];
const recent = [];

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Route each consumed topic to onEvent (the SDK subscribes to '*' internally).
for (const t of TOPICS) wks.on(t, (data, event) => onEvent(event).catch((e) => log('onEvent error: ' + e.message)));
// Log once per (re)connect, mirroring the old open handler.
wks.onStatus((c) => { if (c) log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)')); });

// ── Your plugin logic ─────────────────────────────────────────────────────────
// Push "needs-you" moments to your phone. On agent.state_changed with a mode in
// {approval, question, stopped} we compose a short title/body and send it via the
// configured provider (ntfy / pushover / webhook). Dedup keeps a flapping state
// quiet. Successful pushes raise NO desktop notification (the app already
// surfaces needs-you moments natively) — but a FAILED push does: the user
// thinks they're covered on their phone precisely when they're away, so a
// silent delivery failure is the worst case. See notifyPushFailure().

// mode → human phrase for the notification body.
const MODE_PHRASE = {
  approval: 'needs approval',
  question: 'asked a question',
  stopped: 'finished / stopped',
};

// Dedup: remember the last mode we pushed per session so a state that flaps
// (e.g. approval → responding → approval) doesn't spam the phone. We only push
// when (sessionId, mode) differs from what we last sent for that session.
const lastMode = new Map(); // sessionId -> mode

function basename(p) {
  if (!p || typeof p !== 'string') return '';
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// A friendly label for the agent: prefer an explicit label if the event ever
// carries one, else the cwd basename, else a short sessionId.
function agentLabel(data) {
  const label = data.label || data.name || data.agentLabel;
  if (label && typeof label === 'string') return label;
  const base = basename(data.cwd);
  if (base) return base;
  const sid = data.sessionId || '';
  return sid ? sid.slice(0, 8) : 'agent';
}

async function sendNtfy(target, title, body) {
  const res = await fetch('https://ntfy.sh/' + encodeURIComponent(target), {
    method: 'POST',
    headers: { 'Title': title, 'Content-Type': 'text/plain; charset=utf-8' },
    body,
  });
  if (!res.ok) throw new Error('ntfy ' + res.status);
}

async function sendPushover(userKey, token, title, body) {
  if (!token) throw new Error('missing pushoverToken setting');
  const form = new URLSearchParams({ token, user: userKey, title, message: body });
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) throw new Error('pushover ' + res.status);
}

async function sendWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('webhook ' + res.status);
}

// A push we owed the user did not reach their phone — say so in the app, loud
// (level:'error', OS-escalating). One key means repeated failures replace the
// previous entry instead of stacking; sessionId points the click at the agent
// whose needs-you moment was dropped. Guarded: a dead host side only logs.
async function notifyPushFailure(provider, errMessage, title, sessionId) {
  try {
    await wks.call('notifications.post', {
      title: 'Phone push failed',
      body: provider + ' delivery failed (' + errMessage + ') — "' + title + '" never reached your phone.',
      level: 'error',
      source: 'plugin:' + manifest.id,
      key: 'phone-push:error',
      sessionId: sessionId || undefined,
    });
  } catch (e) {
    log('notifications.post failed: ' + e.message);
  }
}

async function pushToPhone(title, body, sessionId, mode) {
  const provider = (settings.provider || 'ntfy').toLowerCase();
  const target = (settings.target || '').trim();
  if (!target) { log('no target configured — skipping ' + provider + ' push'); return; }
  try {
    if (provider === 'pushover') {
      await sendPushover(target, (settings.pushoverToken || '').trim(), title, body);
    } else if (provider === 'webhook') {
      await sendWebhook(target, { title, body, sessionId, mode });
    } else {
      await sendNtfy(target, title, body);
    }
    log('pushed via ' + provider + ': ' + title);
  } catch (e) {
    // Never let a transport failure crash the sidecar — log it AND surface it
    // in the desktop notification center (e.message carries the provider's
    // HTTP status, e.g. "ntfy 502").
    log('push failed (' + provider + '): ' + e.message);
    await notifyPushFailure(provider, e.message, title, sessionId);
  }
}

async function onEvent(event) {
  if (event.type !== 'agent.state_changed') return;
  const data = event.data || {};
  const mode = data.mode;
  const sessionId = data.sessionId || '';
  if (!MODE_PHRASE[mode]) {
    // Not a needs-you moment; keep dedup state so we re-notify on the next entry.
    if (sessionId) lastMode.set(sessionId, mode);
    return;
  }

  // Dedup per (sessionId, mode): skip if we already pushed this exact state.
  if (sessionId && lastMode.get(sessionId) === mode) return;
  if (sessionId) lastMode.set(sessionId, mode);

  const label = agentLabel(data);
  const phrase = MODE_PHRASE[mode];
  const title = label + ' ' + phrase;
  const body = 'Agent "' + label + '" ' + phrase
    + (data.cwd ? ' (' + data.cwd + ')' : '') + '.';

  // Phone push only — no desktop mirror for routine needs-you moments (the app
  // already surfaces those natively; mirroring them just doubled the noise).
  await pushToPhone(title, body, sessionId, mode);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (wks.connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
);
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
