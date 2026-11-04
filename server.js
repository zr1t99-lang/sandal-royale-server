const http = require('http');
const { WebSocketServer } = require('ws');
const rooms = new Map();
let nextId = 1;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('Sandal Royale server OK. rooms=' + rooms.size);
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const code = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += c[Math.random() * c.length | 0]; } while (rooms.has(s)); return s; };
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const names = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name }));
function leave(ws) {
  const r = rooms.get(ws.room); if (!r) return;
  r.players.delete(ws.id);
  if (!r.players.size) { rooms.delete(ws.room); return; }
  if (r.host === ws.id) r.host = r.players.keys().next().value;
  for (const p of r.players.values()) send(p, { t: 'players', host: r.host, list: names(r) });
  ws.room = null;
}
wss.on('connection', ws => {
  ws.id = nextId++; ws.name = 'لاعب'; ws.room = null; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (m.t === 'create') {
      leave(ws); ws.name = String(m.name || 'لاعب').slice(0, 12); const c = code();
      rooms.set(c, { players: new Map([[ws.id, ws]]), host: ws.id }); ws.room = c;
      send(ws, { t: 'joined', code: c, host: ws.id, list: names(rooms.get(c)) });
    } else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(), r = rooms.get(c);
      if (!r) return send(ws, { t: 'error', msg: 'الكود غير موجود' });
      if (r.players.size >= 6) return send(ws, { t: 'error', msg: 'الغرفة ممتلئة' });
      leave(ws); ws.name = String(m.name || 'لاعب').slice(0, 12); r.players.set(ws.id, ws); ws.room = c;
      for (const p of r.players.values()) send(p, { t: p === ws ? 'joined' : 'players', code: c, host: r.host, list: names(r) });
    } else if (m.t === 'relay' && ws.room) {
      const r = rooms.get(ws.room); if (!r) return;
      const out = JSON.stringify({ t: 'relay', from: ws.id, d: m.d });
      for (const p of r.players.values()) if (p !== ws && p.readyState === 1) p.send(out);
    } else if (m.t === 'leave') leave(ws);
  });
  ws.on('close', () => leave(ws));
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }); }, 25000);
server.listen(process.env.PORT || 8080, () => console.log('listening'));
