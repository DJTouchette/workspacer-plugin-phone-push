#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The hub injects the bus URL + this plugin's scoped token. Accept the common
// conventions so the scaffold runs however your hub wires it.
const BUS_URL = process.env.WKS_BUS_URL || 'ws://127.0.0.1:7895/bus';
function readToken() {
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try { return fs.readFileSync(path.join(DIR, '.bus-token'), 'utf8').trim(); } catch { return ''; }
}
// Host-injected settings (from manifest `settings`), passed as JSON in env.
let settings = {};
try { settings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

const TOPICS = manifest.consumes || [];
const recent = [];
let ws = null, connected = false, callSeq = 0;
const pending = new Map();

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Call a hub capability (must be declared in plugin.json `capabilities`).
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error('not connected'));
    const id = 'c' + (++callSeq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 'call', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
  });
}
// Publish an event/command (must be declared in `emits`).
function publish(type, data) {
  if (connected) ws.send(JSON.stringify({ op: 'publish', event: { type, source: manifest.id, data: data || {} } }));
}

function connect() {
  const tok = readToken();
  ws = new WebSocket(BUS_URL + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  ws.addEventListener('open', () => {
    connected = true;
    if (TOPICS.length) ws.send(JSON.stringify({ op: 'subscribe', topics: TOPICS }));
    log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)'));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.op === 'event' && f.event) onEvent(f.event).catch((e) => log('onEvent error: ' + e.message));
    else if (f.op === 'result' && pending.has(f.id)) { pending.get(f.id).resolve(f.result); pending.delete(f.id); }
    else if (f.op === 'error' && pending.has(f.id)) { pending.get(f.id).reject(new Error(f.error)); pending.delete(f.id); }
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, 1500); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

// ── Your plugin logic ─────────────────────────────────────────────────────────
// Push "needs-you" moments to your phone. On agent.state_changed with a mode in
// {approval, question, stopped} we compose a short title/body and send it via the
// configured provider (ntfy / pushover / webhook), while also mirroring to the
// desktop `notifications.post` capability. Dedup keeps a flapping state quiet.

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
    // Never let a transport failure crash the sidecar — just log it.
    log('push failed (' + provider + '): ' + e.message);
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

  // Fire the phone push and the desktop mirror concurrently; both are guarded.
  await Promise.allSettled([
    pushToPhone(title, body, sessionId, mode),
    (async () => {
      try { await call('notifications.post', { title, body }); }
      catch (e) { log('notifications.post failed: ' + e.message); }
    })(),
  ]);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
    + '<p style="color:var(--wks-text-faint,#777);font-size:.7rem">Scaffold — edit '
    + '<code>server.js</code> (onEvent) to implement.</p>');
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
connect();
