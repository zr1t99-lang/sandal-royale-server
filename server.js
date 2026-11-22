// Sandal Royale online server: serves the game (from game.zip) and runs the multiplayer lobby on the same port (WebSocket).
//  - quick match: per-mode queue, rooms auto-start with 2-6 real players (no fake players, ever)
//  - private rooms with a 4-letter code; the host picks the mode and starts
//  - relay of in-match messages (each client is authoritative for its own fighter; the room host for shared mode state)
//  - resume: a dropped connection can re-attach to its seat within 20 s (mobile network hiccups)
//  - friends: each player has a 6-letter code (generated on the phone). Friend lists live on the phones; the server only
//    routes friend requests / accepts (kept in memory until delivered), answers presence and delivers party invites.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PUB = path.join(__dirname, 'public');
const VERSION = 3;
// ---- minimal unzip (no dependencies) ----
function unzip(file, out) {
  const b = fs.readFileSync(file); let e = b.length - 22; while (e > 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    const lh = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28), raw = b.subarray(lh, lh + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw), dest = path.join(out, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
  }
}
// always unpack the zip that ships with this deploy (so a new game.zip replaces old files)
if (fs.existsSync(path.join(__dirname, 'game.zip'))) { try { fs.rmSync(PUB, { recursive: true, force: true }); } catch (e) { } unzip(path.join(__dirname, 'game.zip'), PUB); }
// the character is stored once (.glb) and served as the 4 base64 parts the game loads
let parts = null;
function getParts() {
  if (parts) return parts;
  const f = path.join(PUB, 'assets', 'sandal_character_v2.glb'); if (!fs.existsSync(f)) return (parts = []);
  const s = fs.readFileSync(f).toString('base64'), n = 4; let q = Math.ceil(s.length / n); q += (4 - q % 4) % 4; parts = [];
  for (let i = 0; i < n; i++) parts.push(Buffer.from(s.slice(i * q, (i + 1) * q)));
  return parts;
}
const gz = new Map();   // gzip cache for text files
const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const MODES = ['classic', 'hot', 'rain', 'gold'];
// MOVED_TO (set only on an old address): the home page forwards players to the new address and hands over the profile saved
// on this site (progress, coins, friend code, friends), since a phone keeps saved data separately for every web address.
const MOVED_TO = (process.env.MOVED_TO || '').replace(/\/+$/, '');
const movedPage = () => Buffer.from(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandal Royale</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;background:#2b1838;color:#ffe9a8;font:700 20px system-ui,sans-serif">
<div>ننقلك لسيرفر أسرع…<br><br><a id="a" style="color:#fff;font-size:16px" href="${MOVED_TO}/">اضغط هنا إذا ما انتقلت</a></div>
<script>(function(){var d={},n=0;try{["sr_profile","sr_name"].forEach(function(k){var v=localStorage.getItem(k);if(v){d[k]=v;n++;}});}catch(e){}
var u=${JSON.stringify(MOVED_TO)}+"/"+location.search;try{if(n)u+="#mig="+encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(d)))));}catch(e){}
document.getElementById("a").href=u;location.replace(u);})();</script>`);
const rooms = new Map(), seats = new Map(); let nextId = 1;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  let buf = null, type = 'text/plain', key = u;
  const m = /^\/assets\/sandal_character\.b64\.(\d)\.txt$/.exec(u);
  if (m) { buf = getParts()[+m[1]]; type = TYPES['.txt']; }
  else if (u === '/health') { buf = Buffer.from('ok v' + VERSION + ' rooms=' + rooms.size + ' online=' + wss.clients.size); key = null; }
  else if (u === '/stats') { buf = Buffer.from(JSON.stringify(stats())); type = TYPES['.json']; key = null; }
  else if (MOVED_TO && (u === '/' || u === '/index.html')) { buf = movedPage(); type = TYPES['.html']; key = null; }
  else {
    const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, ''), f = path.join(PUB, rel);
    if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) { buf = fs.readFileSync(f); type = TYPES[path.extname(f)] || 'application/octet-stream'; }
  }
  if (!buf) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  const h = { 'content-type': type, 'cache-control': key && u !== '/' && !u.endsWith('.html') ? 'public, max-age=86400' : 'no-cache' };
  if (key && /text|javascript|json/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    let z = gz.get(key); if (!z) { z = zlib.gzipSync(buf, { level: 6 }); gz.set(key, z); }
    h['content-encoding'] = 'gzip'; res.writeHead(200, h); return res.end(z);
  }
  res.writeHead(200, h); res.end(buf);
});
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += c[Math.random() * c.length | 0]; } while (rooms.has(s)); return s; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const listOf = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name, on: !p.gone, uid: p.uid || '', lv: p.lv || 1, look: p.look || null, ready: !!p.ready }));
// ---- social state (memory only) ----
const users = new Map(), keys = new Map(), freqs = new Map(), facks = new Map();
const info = ws => ({ uid: ws.uid, name: ws.name, lv: ws.lv || 1 });
const UID = /^[A-Z2-9]{6}$/;
function statusOf(uid) { const w = users.get(uid); if (!w || w.readyState !== 1) return { uid, on: false }; const r = rooms.get(w.room); return { uid, on: true, name: w.name, lv: w.lv || 1, st: r ? (r.started ? 'match' : r.quick ? 'search' : r.players.size > 1 ? 'party' : 'lobby') : 'menu' }; }
function meta(ws, m) { if (m.name) ws.name = String(m.name).replace(/[<>]/g, '').slice(0, 12) || ws.name; if (m.lv) ws.lv = Math.max(1, Math.min(999, m.lv | 0)); if (m.look && typeof m.look === 'object') ws.look = { thobe: String(m.look.thobe || 'white').slice(0, 12), acc: String(m.look.acc || 'none').slice(0, 12), sandal: String(m.look.sandal || 'classic').slice(0, 12), trail: String(m.look.trail || 'none').slice(0, 12) }; }
function stats() { const q = {}; MODES.forEach(m => q[m] = 0); for (const r of rooms.values()) if (r.quick && !r.started) q[r.mode] += r.players.size; return { online: wss.clients.size, playing: [...rooms.values()].filter(r => r.started).reduce((a, r) => a + r.players.size, 0), queue: q }; }
function roomMsg(r) { return { t: 'room', code: r.quick ? '' : r.code, quick: r.quick, host: r.host, list: listOf(r), mode: r.mode, started: r.started, startsAt: r.startsAt ? r.startsAt - Date.now() : 0, online: wss.clients.size }; }
function broadcast(r, o, except) { const s = JSON.stringify(o); for (const p of r.players.values()) if (p !== except && p.readyState === 1) p.send(s); }
function sync(r) { for (const p of r.players.values()) send(p, roomMsg(r)); }
function pickHost(r) { if (!r.players.has(r.host)) { const live = [...r.players.values()].find(p => !p.gone) || r.players.values().next().value; r.host = live ? live.id : 0; } }
function startRoom(r) {
  if (r.started || r.players.size < 2) return;
  clearTimeout(r.timer); r.timer = null; r.startsAt = 0; r.started = true; r.round = (r.round || 0) + 1;
  pickHost(r); broadcast(r, { t: 'start', list: listOf(r).map(p => ({ id: p.id, name: p.name })), mode: r.mode, host: r.host, round: r.round });
}
// quick rooms: start 8 s after the 2nd player arrives (or at once when full)
function armQuick(r) {
  if (!r.quick || r.started) return;
  if (r.players.size >= 6) return startRoom(r);
  if (r.players.size >= 2 && !r.timer) { r.startsAt = Date.now() + 8000; r.timer = setTimeout(() => { r.timer = null; startRoom(r); }, 8000); }
  if (r.players.size < 2 && r.timer) { clearTimeout(r.timer); r.timer = null; r.startsAt = 0; }
}
function leave(ws, quiet) {
  const r = rooms.get(ws.room); ws.room = null; if (!r) return;
  r.players.delete(ws.id); seats.delete(ws.token);
  if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.code); return; }
  pickHost(r);
  if (r.started) broadcast(r, { t: 'left', id: ws.id, host: r.host });
  ws.ready = false;
  armQuick(r); sync(r);
}
function enter(ws, r) { leave(ws); r.players.set(ws.id, ws); ws.room = r.code; seats.set(ws.token, ws.id); if (!r.host) r.host = ws.id; armQuick(r); sync(r); }
wss.on('connection', ws => {
  ws.id = nextId++; ws.name = 'لاعب'; ws.room = null; ws.alive = true; ws.token = crypto.randomBytes(12).toString('hex');
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id, token: ws.token, v: VERSION, online: wss.clients.size });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    const name = () => String(m.name || ws.name || 'لاعب').replace(/[<>]/g, '').slice(0, 12) || 'لاعب';
    const mode = MODES.includes(m.mode) ? m.mode : 'classic';
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, online: wss.clients.size });
    if (m.t === 'stats') return send(ws, Object.assign({ t: 'stats' }, stats()));
    // ---------------- identity / friends / party ----------------
    if (m.t === 'id') {
      const uid = String(m.uid || '').toUpperCase(), key = String(m.key || '');
      if (!UID.test(uid) || key.length < 16) return send(ws, { t: 'error', msg: 'هوية غير صالحة' });
      const h = crypto.createHash('sha256').update(key).digest('hex');
      if (keys.has(uid) && keys.get(uid) !== h) return send(ws, { t: 'idbad' });
      keys.set(uid, h); ws.uid = uid; meta(ws, m); users.set(uid, ws);
      send(ws, { t: 'me', uid });
      const q = freqs.get(uid); if (q) for (const [from, inf] of q) send(ws, { t: 'freq', from: inf });
      const a = facks.get(uid); if (a) { a.forEach(inf => send(ws, { t: 'fok', who: inf })); facks.delete(uid); }
      const r = rooms.get(ws.room); if (r) sync(r);
      return;
    }
    if (m.t === 'meta') { meta(ws, m); const r = rooms.get(ws.room); if (r) sync(r); return; }
    if (m.t === 'ready') { ws.ready = !!m.v; const r = rooms.get(ws.room); if (r) sync(r); return; }
    if (m.t === 'pres') { const l = (Array.isArray(m.uids) ? m.uids : []).slice(0, 200).map(u => statusOf(String(u))); return send(ws, { t: 'pres', list: l, online: wss.clients.size }); }
    if (m.t === 'fadd') {
      const to = String(m.code || '').toUpperCase().trim(); if (!ws.uid) return;
      if (!UID.test(to)) return send(ws, { t: 'ferr', msg: 'الكود لازم 6 حروف/أرقام' });
      if (to === ws.uid) return send(ws, { t: 'ferr', msg: 'هذا كودك أنت 😄' });
      const q = freqs.get(to) || new Map(); q.set(ws.uid, info(ws)); freqs.set(to, q);
      const w = users.get(to); if (w) send(w, { t: 'freq', from: info(ws) });
      return send(ws, { t: 'fsent', uid: to, on: !!w, quiet: !!m.quiet });
    }
    if (m.t === 'facc' || m.t === 'fdec') {
      const from = String(m.uid || '').toUpperCase(); if (!ws.uid) return; const q = freqs.get(ws.uid); if (q) { q.delete(from); if (!q.size) freqs.delete(ws.uid); }
      if (m.t === 'facc') { const w = users.get(from); if (w) send(w, { t: 'fok', who: info(ws) }); else { const a = facks.get(from) || []; a.push(info(ws)); facks.set(from, a); } }
      return;
    }
    if (m.t === 'pinv') {          // party invite: the friend joins my private room
      const to = users.get(String(m.uid || '').toUpperCase()), r = rooms.get(ws.room);
      if (!to) return send(ws, { t: 'ferr', msg: 'صديقك غير متصل الحين' });
      if (!r || r.quick || r.started) return send(ws, { t: 'ferr', msg: 'افتح غرفتك أولًا' });
      if (r.players.size >= 6) return send(ws, { t: 'ferr', msg: 'الفريق مكتمل (6)' });
      send(to, { t: 'pinvite', from: info(ws), code: r.code, mode: r.mode }); return send(ws, { t: 'pinvsent', uid: to.uid });
    }
    if (m.t === 'pdec') { const w = users.get(String(m.uid || '').toUpperCase()); if (w) send(w, { t: 'pdeclined', name: ws.name }); return; }
    if (m.t === 'kick') { const r = rooms.get(ws.room); if (!r || r.host !== ws.id || r.started) return; const p = r.players.get(m.id | 0); if (p && p !== ws) { leave(p); send(p, { t: 'kicked' }); } return; }
    if (m.t === 'create') {
      ws.name = name(); meta(ws, m); ws.ready = false; const c = newCode(), r = { code: c, quick: false, players: new Map(), host: ws.id, mode, started: false };
      rooms.set(c, r); enter(ws, r);
    } else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(), r = rooms.get(c);
      if (!r || r.quick) return send(ws, { t: 'error', msg: 'الكود غير موجود' });
      if (r.players.size >= 6) return send(ws, { t: 'error', msg: 'الغرفة ممتلئة' });
      if (r.started) return send(ws, { t: 'error', msg: 'المباراة بدأت، انتظر تخلص' });
      ws.name = name(); meta(ws, m); ws.ready = false; enter(ws, r);
    } else if (m.t === 'quick') {
      ws.name = name(); meta(ws, m); ws.ready = true;
      let r = [...rooms.values()].find(x => x.quick && !x.started && x.mode === mode && x.players.size < 6);
      if (!r) { const c = newCode(); r = { code: c, quick: true, players: new Map(), host: ws.id, mode, started: false }; rooms.set(c, r); }
      enter(ws, r);
    } else if (m.t === 'mode') {
      const r = rooms.get(ws.room); if (r && !r.quick && r.host === ws.id && !r.started) { r.mode = mode; sync(r); }
    } else if (m.t === 'start') {
      const r = rooms.get(ws.room); if (r && !r.quick && r.host === ws.id) { if (r.players.size < 2) return send(ws, { t: 'error', msg: 'بانتظار لاعب ثاني' }); startRoom(r); }
    } else if (m.t === 'lobby') {           // match finished: private room goes back to its lobby
      const r = rooms.get(ws.room); if (!r) return; if (r.quick) { leave(ws); return; } if (r.started) { r.started = false; for (const p of r.players.values()) p.ready = false; } sync(r);
    } else if (m.t === 'relay') {
      const r = rooms.get(ws.room); if (!r) return;
      broadcast(r, { t: 'relay', from: ws.id, d: m.d }, ws);
    } else if (m.t === 'resume') {         // re-attach to a seat after a dropped connection
      const id = seats.get(String(m.token || '')); let old = null;
      for (const r of rooms.values()) { const p = id && r.players.get(id); if (p) { old = { r, p }; break; } }
      if (!old) return send(ws, { t: 'resume', ok: false });
      const { r, p } = old; clearTimeout(p.goneT); r.players.delete(p.id);
      ws.id = p.id; ws.name = p.name; ws.token = p.token; ws.room = r.code; ws.uid = p.uid; ws.lv = p.lv; ws.look = p.look; r.players.set(ws.id, ws); seats.set(ws.token, ws.id); if (ws.uid && users.get(ws.uid) === p) users.set(ws.uid, ws);
      try { p.terminate(); } catch (e) { }
      send(ws, { t: 'resume', ok: true, id: ws.id }); sync(r);
    } else if (m.t === 'leave') leave(ws);
  });
  ws.on('close', () => {
    if (ws.uid && users.get(ws.uid) === ws) users.delete(ws.uid);
    const r = rooms.get(ws.room); if (!r || !r.players.has(ws.id) || r.players.get(ws.id) !== ws) return;
    if (r.started) { ws.gone = true; sync(r); ws.goneT = setTimeout(() => { if (r.players.get(ws.id) === ws) leave(ws); }, 20000); }   // keep the seat 20 s
    else leave(ws);
  });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }); }, 25000);
server.listen(process.env.PORT || 8080, () => console.log('Sandal Royale server v' + VERSION + ' listening' + (MOVED_TO ? ' (home page forwards to ' + MOVED_TO + ')' : '')));
