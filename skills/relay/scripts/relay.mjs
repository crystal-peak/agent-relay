#!/usr/bin/env node
// agent-relay: encrypted, pull-based messaging between two Claude Code agents.
// Zero dependencies: Node >= 22.5 (node:sqlite, node:crypto) + cloudflared.

// Silence the node:sqlite experimental warning so output stays clean for agents.
const _emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  const s = String(w?.message ?? w);
  if (s.includes('SQLite')) return;
  return _emit.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const TYPES = ['proposal', 'question', 'answer', 'accept', 'reject', 'update', 'blocked', 'done'];
const MAX_BODY = 60_000;
const CLOCK_SKEW_S = 300;
const FETCH_TIMEOUT_MS = 15_000;

// ---------- state location ----------
function stateDir() {
  if (process.env.RELAY_HOME) return path.resolve(process.env.RELAY_HOME);
  let root = process.cwd();
  try {
    root = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || root;
  } catch {}
  return path.join(root, '.relay');
}
const DIR = stateDir();
const DB_PATH = path.join(DIR, 'relay.db');

function ensureDir() {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    // Keep relay state out of git without touching the tracked .gitignore.
    try {
      const gitDir = execSync('git rev-parse --git-common-dir', { cwd: path.dirname(DIR), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const excl = path.resolve(path.dirname(DIR), gitDir, 'info', 'exclude');
      fs.mkdirSync(path.dirname(excl), { recursive: true });
      const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
      const entry = '/' + path.basename(DIR) + '/';
      if (!cur.split('\n').includes(entry)) fs.appendFileSync(excl, (cur && !cur.endsWith('\n') ? '\n' : '') + entry + '\n');
    } catch {}
  }
}

// ---------- database ----------
let _db;
function db() {
  if (_db) return _db;
  ensureDir();
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, re INTEGER, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY,               -- the peer's outbox id
      type TEXT NOT NULL, re INTEGER, body TEXT NOT NULL,
      created_at TEXT NOT NULL, received_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0);
  `);
  try { fs.chmodSync(DB_PATH, 0o600); } catch {}
  return _db;
}
const get = (k) => db().prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
const set = (k, v) => v === null || v === undefined
  ? db().prepare('DELETE FROM meta WHERE k = ?').run(k)
  : db().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
const now = () => new Date().toISOString();
const touch = () => set('last_activity_at', now());

// ---------- crypto ----------
function deriveKeys(master) {
  const ikm = Buffer.from(master, 'base64url');
  if (ikm.length !== 32) throw new Error('session key must be 32 bytes');
  const k = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
  return { enc: k('agent-relay v1 enc'), mac: k('agent-relay v1 mac') };
}
function seal(key, obj, aad) {
  const n = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, n, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, n: n.toString('base64url'), c: ct.toString('base64url') };
}
function unseal(key, env, aad) {
  if (!env || env.v !== 1) throw new Error('bad envelope');
  const n = Buffer.from(env.n, 'base64url');
  const buf = Buffer.from(env.c, 'base64url');
  if (n.length !== 12 || buf.length < 16) throw new Error('bad envelope');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, n, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const pt = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fresh = (ts) => Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) <= CLOCK_SKEW_S;
const otherRole = (r) => (r === 'host' ? 'guest' : 'host');

function session() {
  const key = get('key'), sid = get('session_id'), role = get('role');
  if (!key || !sid || !role) throw new Error('no session. Run `start` (host) or `join <invite>` (guest) first.');
  return { sid, role, peer: otherRole(role), ...deriveKeys(key) };
}

// ---------- invite ----------
const makeInvite = (url, key, sid) =>
  'relay1.' + Buffer.from(JSON.stringify({ u: url, k: key, s: sid })).toString('base64url');
function parseInvite(s) {
  const m = String(s).trim().match(/^relay1\.([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('not a relay invite (expected relay1.xxxx)');
  const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  if (!o.u || !o.k || !o.s) throw new Error('invite is missing fields');
  return { url: o.u.replace(/\/+$/, ''), key: o.k, sid: o.s };
}

// ---------- HTTP server (runs as a detached child) ----------
function serve(port) {
  const s = session();
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 256_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, s: s.sid.slice(0, 8) });

      if (req.method === 'GET' && u.pathname === '/messages') {
        // Auth: header "<ts>.<hmac>" over the exact request, signed by the peer.
        const after = Math.max(0, parseInt(u.searchParams.get('after') || '0', 10) || 0);
        const [tsStr, sig] = String(req.headers['x-relay-auth'] || '').split('.');
        const ts = Number(tsStr);
        const expect = hmac(s.mac, `${s.sid}|${s.peer}|GET /messages|${after}|${ts}`);
        if (!fresh(ts) || !safeEq(sig, expect)) return json(res, 401, { error: 'unauthorized' });
        const rows = db().prepare('SELECT id, type, re, body, created_at FROM outbox WHERE id > ? ORDER BY id LIMIT 200').all(after);
        const env = seal(s.enc, { messages: rows }, `${s.sid}|messages|${s.role}|${after}|${ts}`);
        return json(res, 200, env);
      }

      if (req.method === 'POST' && u.pathname === '/announce') {
        // Peer tells us its (new) URL. Authenticated by successful decryption.
        const env = JSON.parse(await readBody(req));
        const msg = unseal(s.enc, env, `${s.sid}|announce|${s.peer}`);
        if (!fresh(msg.ts) || !/^https?:\/\//.test(msg.url)) return json(res, 400, { error: 'bad announce' });
        set('peer_url', msg.url.replace(/\/+$/, ''));
        set('peer_seen_at', now());
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: 'bad request' });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(DIR, 'server.pid'), String(process.pid));
  });
}

// ---------- HTTP client ----------
// Fresh trycloudflare hostnames take ~15s to reach public DNS, and an early miss can be
// cached as NXDOMAIN by the local resolver. If the system lookup fails, ask Cloudflare's
// DNS-over-HTTPS directly so a stale negative cache can't block delivery.
async function dohLookup(host) {
  const r = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  const a = (j.Answer || []).filter((x) => x.type === 1).map((x) => x.data);
  if (!a.length) throw Object.assign(new Error('ENOTFOUND ' + host), { code: 'ENOTFOUND' });
  return a[0];
}
function lookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const done = (addr, family) => opts?.all ? cb(null, [{ address: addr, family }]) : cb(null, addr, family);
  dns.lookup(host, { family: 4 }, (err, addr, family) => {
    if (!err) return done(addr, family);
    if (!host.endsWith('.trycloudflare.com')) return cb(err);
    dohLookup(host).then((ip) => done(ip, 4), () => cb(err));
  });
}
function dohOnlyLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dohLookup(host).then((ip) => opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4), cb);
}
function request(url, { method = 'GET', headers = {}, body = null, timeout = FETCH_TIMEOUT_MS, lookup: lk = lookup } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, lookup: lk, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: () => JSON.parse(text) });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const errCode = (e) => e.code || e.cause?.code || e.message;

// ---------- process management ----------
// A pid file can outlive a reboot and point at an unrelated process, so check the command line.
const PID_MARK = { 'server.pid': '_serve', 'tunnel.pid': 'cloudflared' };
const pidAlive = (f) => {
  try {
    const pid = Number(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 1) return 0;
    process.kill(pid, 0);
    const cmd = execSync(`ps -p ${pid} -o command=`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return cmd.includes(PID_MARK[f]) ? pid : 0;
  } catch { return 0; }
};
const killPid = (f) => {
  const pid = pidAlive(f);
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  try { fs.unlinkSync(path.join(DIR, f)); } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on('error', reject);
});

async function localHealthy() {
  const port = get('port');
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return j.ok && j.s === get('session_id').slice(0, 8);
  } catch { return false; }
}

async function startServer() {
  if (await localHealthy()) return;
  killPid('server.pid');
  const port = await freePort();
  set('port', port);
  const log = fs.openSync(path.join(DIR, 'server.log'), 'a');
  const child = spawn(process.execPath, [SCRIPT, '_serve', String(port)], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, RELAY_HOME: DIR },
  });
  child.unref();
  for (let i = 0; i < 50; i++) { if (await localHealthy()) return; await sleep(100); }
  throw new Error('local server failed to start; see ' + path.join(DIR, 'server.log'));
}

async function startTunnel() {
  const port = get('port');
  const logPath = path.join(DIR, 'tunnel.log');
  fs.writeFileSync(logPath, '');
  const log = fs.openSync(logPath, 'a');
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    detached: true, stdio: ['ignore', log, log],
  });
  child.on('error', () => {});
  child.unref();
  fs.writeFileSync(path.join(DIR, 'tunnel.pid'), String(child.pid));
  set('tunnel_port', port);
  // Return only once the URL exists AND cloudflared has registered an edge connection.
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const txt = fs.readFileSync(logPath, 'utf8');
    const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && /Registered tunnel connection/.test(txt)) return m[0];
    if (!pidAlive('tunnel.pid')) break;
  }
  throw new Error('cloudflared did not produce a URL; see ' + logPath + ' (is cloudflared installed?)');
}

const progress = (msg) => process.stderr.write(msg + '\n');
const watchHint = () =>
  `\nTo watch the conversation live, run this in another terminal from this repo:\n  node ${SCRIPT} watch\nA readable transcript is kept at ${TRANSCRIPT}`;

// Block until our own tunnel URL answers /health from the public internet. Uses DNS-over-HTTPS
// only, so an early miss can't get cached as NXDOMAIN by this machine's resolver.
async function waitPublic(url, maxS = 90) {
  const sid8 = get('session_id').slice(0, 8);
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < maxS) {
    try {
      const r = await request(url + '/health', { timeout: 5000, lookup: dohOnlyLookup });
      if (r.ok && r.json().s === sid8) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`tunnel ${url} was not reachable after ${maxS}s; see ${path.join(DIR, 'tunnel.log')}`);
}

// Bring server + tunnel up if needed. Returns { url, changed }.
async function up() {
  await startServer();
  const before = get('own_url');
  if (get('mode') === 'local') {
    const url = `http://127.0.0.1:${get('port')}`;
    set('own_url', url);
    return { url, changed: url !== before };
  }
  if (pidAlive('tunnel.pid') && get('tunnel_port') === get('port') && before) {
    try {
      const r = await request(before + '/health', { timeout: 8000 });
      if (r.ok && r.json().s === get('session_id').slice(0, 8)) return { url: before, changed: false };
    } catch {}
  }
  killPid('tunnel.pid');
  progress('Establishing connection: starting tunnel...');
  const url = await startTunnel();
  progress(`Establishing connection: waiting for ${url} to be reachable (usually 10-30s)...`);
  await waitPublic(url);
  progress('Establishing connection: tunnel is live.');
  set('own_url', url);
  return { url, changed: url !== before };
}

async function announce() {
  const s = session();
  const peerUrl = get('peer_url');
  if (!peerUrl) return { ok: false, error: 'no peer url' };
  const env = seal(s.enc, { url: get('own_url'), ts: Math.floor(Date.now() / 1000) }, `${s.sid}|announce|${s.role}`);
  try {
    const r = await request(peerUrl + '/announce', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
    });
    if (r.ok) { set('announced_url', get('own_url')); return { ok: true }; }
    return { ok: false, error: `peer answered ${r.status}` };
  } catch (e) { return { ok: false, error: errCode(e) }; }
}

// ---------- pull ----------
async function pull() {
  const s = session();
  const peerUrl = get('peer_url');
  if (!peerUrl) return { reachable: false, error: 'peer has not connected yet', received: 0 };
  let received = 0;
  for (let page = 0; page < 50; page++) {
    const after = Number(get('inbox_cursor') || 0);
    const ts = Math.floor(Date.now() / 1000);
    const auth = `${ts}.${hmac(s.mac, `${s.sid}|${s.role}|GET /messages|${after}|${ts}`)}`;
    let r;
    try {
      r = await request(`${peerUrl}/messages?after=${after}`, { headers: { 'x-relay-auth': auth } });
    } catch (e) { return { reachable: false, error: errCode(e), received }; }
    if (!r.ok) return { reachable: false, error: `peer answered ${r.status}`, received };
    let body;
    try { body = unseal(s.enc, r.json(), `${s.sid}|messages|${s.peer}|${after}|${ts}`); }
    catch { return { reachable: false, error: 'response failed decryption (wrong session or tampered)', received }; }
    set('peer_seen_at', now());
    const msgs = body.messages || [];
    const ins = db().prepare('INSERT OR IGNORE INTO inbox (id, type, re, body, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of msgs) {
      if (!Number.isInteger(m.id) || m.id <= after) continue;
      const type = TYPES.includes(m.type) ? m.type : 'update';
      const re = Number.isInteger(m.re) ? m.re : null;
      const created = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(m.created_at) ? m.created_at : now();
      ins.run(m.id, type, re, String(m.body ?? '').slice(0, MAX_BODY * 2), created, now());
      set('inbox_cursor', m.id);
      received++;
    }
    if (msgs.length < 200) break;
  }
  if (received) { touch(); writeTranscript(); }
  return { reachable: true, received };
}

// ---------- output helpers ----------
const unhandled = () => db().prepare('SELECT * FROM inbox WHERE handled = 0 ORDER BY id').all();
// Peer bodies are quoted line by line so they can't imitate headers like "=== operator brief ===".
const fmtMsg = (m, who) => {
  const body = who.startsWith('peer') ? m.body.split('\n').map((l) => '> ' + l).join('\n') : m.body;
  return `--- ${who} #${m.id} [${m.type}]${m.re ? ` re #${m.re}` : ''} ${m.created_at}\n${body}\n`;
};
function lastType(table) {
  return db().prepare(`SELECT type FROM ${table} ORDER BY id DESC LIMIT 1`).get()?.type ?? null;
}
function idleMinutes() {
  const t = get('last_activity_at');
  return t ? Math.round((Date.now() - Date.parse(t)) / 60000) : null;
}

// ---------- transcript ----------
const TRANSCRIPT = path.join(DIR, 'transcript.md');
function allRows() {
  return [
    ...db().prepare("SELECT 'you' AS who, id, type, re, body, created_at FROM outbox").all(),
    ...db().prepare("SELECT 'peer' AS who, id, type, re, body, created_at FROM inbox").all(),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
// Human-readable copy of the whole conversation, rewritten whenever it changes.
function writeTranscript() {
  try {
    const lines = [`# Relay transcript (session ${get('session_id').slice(0, 8)}, you are ${get('role')})`, ''];
    for (const m of allRows()) {
      lines.push(`## ${m.created_at.replace('T', ' ').slice(0, 19)} UTC · ${m.who === 'you' ? 'you → peer' : 'peer → you'} · ${m.type} #${m.id}${m.re ? ` (re #${m.re})` : ''}`, '', m.body, '');
    }
    fs.writeFileSync(TRANSCRIPT, lines.join('\n'));
  } catch {}
}

// ---------- live view ----------
const tty = process.stdout.isTTY;
const c = (code, t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
function printLive(m) {
  const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dir = m.who === 'you' ? c('36', 'you → peer') : c('35', 'peer → you');
  console.log(`\n${c('2', t)}  ${dir}  ${c('1', m.type)} #${m.id}${m.re ? c('2', ` re #${m.re}`) : ''}`);
  console.log(m.body.split('\n').map((l) => '  ' + l).join('\n'));
}
async function watch(flags) {
  session();
  const last = flags.all ? Infinity : Number(flags.last || 5);
  const rows = allRows();
  if (rows.length > last) console.log(c('2', `(${rows.length - last} earlier messages hidden; --all shows everything)`));
  for (const m of rows.slice(-last)) printLive(m);
  let maxOut = db().prepare('SELECT COALESCE(MAX(id), 0) AS n FROM outbox').get().n;
  let maxIn = db().prepare('SELECT COALESCE(MAX(id), 0) AS n FROM inbox').get().n;
  const pullEvery = Math.max(5, Number(flags.every || 15));
  console.log(c('2', `\n— watching. Checks the peer every ${pullEvery}s and shows both sides as messages land. Ctrl-C to stop. —`));
  let lastState = null, lastPull = 0;
  for (;;) {
    if (Date.now() - lastPull >= pullEvery * 1000) {
      lastPull = Date.now();
      const p = await pull().catch((e) => ({ reachable: false, error: e.message }));
      const state = p.reachable ? 'up' : `down: ${p.error}`;
      if (state !== lastState) {
        console.log(c('2', `\n· ${new Date().toLocaleTimeString()} peer ${p.reachable ? 'reachable' : 'unreachable (' + p.error + ')'}`));
        lastState = state;
      }
    }
    const fresh = [
      ...db().prepare("SELECT 'you' AS who, * FROM outbox WHERE id > ?").all(maxOut),
      ...db().prepare("SELECT 'peer' AS who, * FROM inbox WHERE id > ?").all(maxIn),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const m of fresh) {
      printLive(m);
      if (m.who === 'you') maxOut = Math.max(maxOut, m.id); else maxIn = Math.max(maxIn, m.id);
    }
    await sleep(2000);
  }
}

// ---------- CLI ----------
function parseFlags(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const HELP = `agent-relay — encrypted messaging between two Claude Code agents

  start [--local]            Host a new session. Prints an invite to send to your peer.
  join <invite> [--local]    Join a session from a peer's invite.
  tick                       Keep the tunnel alive, pull new messages, print status + unhandled inbox.
  send <type> [--re N] [--body TEXT]   Queue a message (body from --body or stdin).
                             types: ${TYPES.join(', ')}
  inbox [--all]              Show unhandled (or all) received messages.
  ack <id...>                Mark received messages handled.
  brief [TEXT]               Show or append operator instructions (persist across context resets).
  watch [--last N|--all]     Live view of the conversation, both directions, as it happens.
  log                        Full transcript, both directions, in time order.
                             A readable copy is kept current at .relay/transcript.md.
  status                     Session, URLs, process health, counts.
  invite                     Reprint the invite for this session (host only).
  stop                       Stop the server and tunnel. Keeps state.
  close [--purge]            Stop, and with --purge delete all relay state for this repo.

  --local uses http://127.0.0.1 instead of a cloudflared tunnel (same-machine testing).
  State lives in <repo>/.relay (override with RELAY_HOME).`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);

  switch (cmd) {
    case '_serve': return serve(Number(pos[0]));

    case 'start': {
      if (get('session_id') && get('role') !== 'host') throw new Error('this repo already joined a session as guest. Run `close --purge` first.');
      if (!get('session_id')) {
        set('session_id', crypto.randomBytes(12).toString('base64url'));
        set('key', crypto.randomBytes(32).toString('base64url'));
        set('role', 'host');
        set('mode', flags.local ? 'local' : 'tunnel');
        set('created_at', now());
        touch();
      }
      const { url } = await up();
      console.log('Session hosted. Send this invite to your peer over a channel you trust (it contains the session key):\n');
      console.log(makeInvite(url, get('key'), get('session_id')));
      console.log('\nThey run: /relay join <invite>');
      console.log(watchHint());
      return;
    }

    case 'invite': {
      if (get('role') !== 'host') throw new Error('only the host has an invite');
      console.log(makeInvite(get('own_url'), get('key'), get('session_id')));
      return;
    }

    case 'join': {
      const inv = parseInvite(pos[0] || '');
      if (get('session_id') && get('session_id') !== inv.sid) throw new Error('this repo is in another session. Run `close --purge` first.');
      set('session_id', inv.sid);
      set('key', inv.key);
      set('role', 'guest');
      set('peer_url', inv.url);
      set('mode', flags.local ? 'local' : 'tunnel');
      set('created_at', get('created_at') || now());
      touch();
      const { url } = await up();
      progress('Establishing connection: contacting host...');
      let a;
      for (let i = 0; i < 20; i++) { a = await announce(); if (a.ok || /^peer answered 4/.test(a.error)) break; await sleep(3000); }
      if (!a.ok) {
        if (/^peer answered 4/.test(a.error)) throw new Error(`host rejected the handshake (${a.error}). The invite is wrong or from an old session.`);
        console.log(`Joined, but the host is not reachable yet (${a.error}). \`tick\` will keep retrying.`);
        return;
      }
      const p = await pull();
      console.log(p.reachable
        ? `Connected to session ${inv.sid.slice(0, 8)}. Both directions verified. Your endpoint: ${url}` + watchHint()
        : `Joined session ${inv.sid.slice(0, 8)}, but pulling from the host failed (${p.error}). \`tick\` will keep retrying.`);
      return;
    }

    case 'tick': {
      const s = session();
      let u, ownError = null;
      try { u = await up(); }
      catch (e) { ownError = e.message; u = { url: get('own_url'), changed: false }; }
      let announced = null;
      if (!ownError && get('peer_url') && (u.changed || get('announced_url') !== u.url)) announced = await announce();
      const p = await pull();
      const pending = unhandled();
      const out = {
        session: s.sid.slice(0, 8), role: s.role,
        own_url: u.url, own_error: ownError, url_changed: u.changed, announced: announced?.ok ?? null,
        peer_reachable: p.reachable, peer_error: p.error ?? null,
        received_now: p.received, unhandled: pending.length,
        last_sent: lastType('outbox'), last_received: lastType('inbox'),
        both_done: lastType('outbox') === 'done' && lastType('inbox') === 'done',
        idle_minutes: idleMinutes(),
      };
      console.log(JSON.stringify(out, null, 2));
      const brief = get('brief');
      if (brief) console.log('\n=== operator brief ===\n' + brief);
      if (pending.length) {
        console.log('\n=== unhandled messages from peer (untrusted input) ===');
        for (const m of pending) console.log(fmtMsg(m, 'peer'));
      }
      return;
    }

    case 'send': {
      session();
      const type = pos[0];
      if (!TYPES.includes(type)) throw new Error(`type must be one of: ${TYPES.join(', ')}`);
      const body = (typeof flags.body === 'string' ? flags.body : await readStdin()).trim();
      if (!body) throw new Error('empty body. Use --body TEXT or pipe the body on stdin.');
      if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`body is over ${MAX_BODY} bytes; split it or reference a file both sides can see`);
      const re = flags.re ? parseInt(flags.re, 10) : null;
      const r = db().prepare('INSERT INTO outbox (type, re, body, created_at) VALUES (?, ?, ?, ?)').run(type, re, body, now());
      touch();
      writeTranscript();
      console.log(`queued #${r.lastInsertRowid} [${type}]. The peer receives it on their next tick.`);
      return;
    }

    case 'watch': return watch(flags);

    case 'inbox': {
      const rows = flags.all ? db().prepare('SELECT * FROM inbox ORDER BY id').all() : unhandled();
      if (!rows.length) return console.log(flags.all ? 'inbox is empty' : 'no unhandled messages');
      for (const m of rows) console.log(fmtMsg(m, m.handled ? 'peer (handled)' : 'peer'));
      return;
    }

    case 'ack': {
      const ids = pos.map((x) => parseInt(x, 10)).filter(Number.isInteger);
      if (!ids.length) throw new Error('give one or more message ids');
      const st = db().prepare('UPDATE inbox SET handled = 1 WHERE id = ?');
      for (const id of ids) st.run(id);
      console.log(`acked ${ids.join(', ')}`);
      return;
    }

    case 'brief': {
      const text = pos.join(' ').trim() || (await readStdin()).trim();
      if (text) {
        const cur = get('brief');
        set('brief', (cur ? cur + '\n' : '') + `- [${now().slice(0, 16)}] ${text}`);
        console.log('brief updated');
      } else console.log(get('brief') || '(no brief yet)');
      return;
    }

    case 'log': {
      const rows = allRows();
      if (!rows.length) return console.log('no messages yet');
      for (const m of rows) console.log(fmtMsg(m, m.who));
      return;
    }

    case 'status': {
      if (!fs.existsSync(DB_PATH) || !get('session_id')) return console.log('no session in ' + DIR);
      const c = (t, w = '') => db().prepare(`SELECT COUNT(*) AS n FROM ${t} ${w}`).get().n;
      console.log(JSON.stringify({
        state_dir: DIR, session: get('session_id').slice(0, 8), role: get('role'), mode: get('mode'),
        own_url: get('own_url'), peer_url: get('peer_url'),
        server_up: await localHealthy(), tunnel_up: get('mode') === 'local' ? null : !!pidAlive('tunnel.pid'),
        sent: c('outbox'), received: c('inbox'), unhandled: c('inbox', 'WHERE handled = 0'),
        peer_seen_at: get('peer_seen_at'), idle_minutes: idleMinutes(),
        transcript: TRANSCRIPT, watch: `node ${SCRIPT} watch`,
      }, null, 2));
      return;
    }

    case 'stop':
    case 'close': {
      killPid('tunnel.pid');
      killPid('server.pid');
      if (cmd === 'close' && flags.purge) {
        try { _db?.close(); } catch {}
        fs.rmSync(DIR, { recursive: true, force: true });
        console.log('relay stopped and all state deleted (' + DIR + ')');
      } else console.log('relay stopped. State kept in ' + DIR + '. `tick` restarts it.');
      return;
    }

    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
