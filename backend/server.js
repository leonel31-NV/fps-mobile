'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

// Regras (o servidor é a autoridade sobre vida, munição, cadência, recarga, dano, respawn e placar).
// Quem foi atingido é detectado pela câmera do atirador (ver README, "Limitações").
const C = { HP: 100, MAG: 12, DMG: 25, FIRE_MS: 250, FIRE_TOL: 40, RELOAD_MS: 1800, RESPAWN_MS: 3000,
  MAX_PLAYERS: 6, COLORS: 6, TICK_MS: 100, MAX_EVT_PER_S: 40 };

const app = express();
app.get('/health', (_q, r) => r.send('ok'));
if (process.env.SERVE_FRONTEND === 'true') app.use(express.static(path.join(__dirname, '..', 'frontend')));
const server = http.createServer(app);

// Bloqueia origens não autorizadas (vale também para WebSocket). Mesma origem (dev local) é aceita.
const originOk = req => {
  const o = req.headers.origin; if (!o) return true;
  if (origins.includes(o.replace(/\/$/, ''))) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};
const io = new Server(server, {
  cors: { origin: origins.length ? origins : false },
  allowRequest: (req, cb) => cb(null, originOk(req)),
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e4,
});

const rooms = new Map(); // código -> { code, players: Map(socket.id -> jogador) }
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 12) || 'Jogador';
const newCode = () => { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(c)); return c; };
const pickColor = (room, want) => { // cada jogador tem uma cor única na sala
  const used = new Set([...room.players.values()].map(p => p.c));
  if (Number.isInteger(want) && want >= 0 && want < C.COLORS && !used.has(want)) return want;
  for (let i = 0; i < C.COLORS; i++) if (!used.has(i)) return i;
  return 0;
};
function spawn(p) { p.hp = C.HP; p.ammo = C.MAG; p.reloadAt = 0; p.deadAt = 0; p.dead = false; }
function addPlayer(room, socket, name, color) {
  const p = { id: socket.id, name: cleanName(name), c: pickColor(room, color), kills: 0, deaths: 0, lastShot: 0 };
  spawn(p); room.players.set(socket.id, p); socket.join(room.code); socket.data.code = room.code; return p;
}
function leave(socket) {
  const code = socket.data.code; const room = rooms.get(code); if (!room) return;
  room.players.delete(socket.id); socket.leave(code); socket.data.code = null;
  if (room.players.size === 0) rooms.delete(code); else io.to(code).emit('left', socket.id);
}
function startReload(p, now) { if (!p.dead && !p.reloadAt && p.ammo < C.MAG) p.reloadAt = now + C.RELOAD_MS; }

io.on('connection', socket => {
  let count = 0, windowStart = Date.now();
  const allowed = () => { const t = Date.now(); if (t - windowStart > 1000) { windowStart = t; count = 0; } return ++count <= C.MAX_EVT_PER_S; };
  const me = () => { const r = rooms.get(socket.data.code); return r && r.players.get(socket.id); };
  const opts = d => (d && typeof d === 'object') ? d : { name: d }; // aceita string (legado) ou objeto

  socket.on('create', (d, cb) => {
    if (typeof cb !== 'function' || !allowed() || socket.data.code) return;
    d = opts(d); const code = newCode(); const room = { code, players: new Map() }; rooms.set(code, room);
    const p = addPlayer(room, socket, d.name, d.color); cb({ ok: true, code, color: p.c });
  });
  socket.on('join', (d, cb) => {
    if (typeof cb !== 'function' || !allowed() || socket.data.code) return;
    d = opts(d); const code = String(d.code || '').toUpperCase().trim(); const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Sala não encontrada.' });
    if (room.players.size >= C.MAX_PLAYERS) return cb({ ok: false, error: 'Sala cheia.' });
    const p = addPlayer(room, socket, d.name, d.color); cb({ ok: true, code, color: p.c });
  });
  socket.on('reload', () => { const p = me(); if (p && allowed()) startReload(p, Date.now()); });
  socket.on('shoot', d => {
    const p = me(); const room = rooms.get(socket.data.code); if (!p || !room || !allowed()) return;
    const now = Date.now();
    if (p.dead || p.reloadAt || p.ammo <= 0 || now - p.lastShot < C.FIRE_MS - C.FIRE_TOL) return; // cadência, munição, recarga
    p.lastShot = now; p.ammo--; if (p.ammo === 0) startReload(p, now);
    // O celular do atirador diz quem a câmera viu sob a mira; o servidor valida o alvo.
    const t = d && typeof d.target === 'string' ? room.players.get(d.target) : null;
    const hit = t && t.id !== p.id && !t.dead ? t : null; // sem dano em si mesmo nem em quem já caiu
    if (hit) {
      hit.hp = Math.max(0, hit.hp - C.DMG);
      if (hit.hp === 0) { hit.dead = true; hit.deadAt = now + C.RESPAWN_MS; hit.deaths++; p.kills++;
        io.to(room.code).emit('kill', { by: p.id, victim: hit.id, byName: p.name, victimName: hit.name }); }
    }
    io.to(room.code).emit('shot', { id: p.id, hit: hit ? hit.id : null });
  });
  socket.on('leave', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.dead && now >= p.deadAt) spawn(p);
      if (p.reloadAt && now >= p.reloadAt) { p.ammo = C.MAG; p.reloadAt = 0; }
    }
    io.to(room.code).volatile.emit('state', [...room.players.values()].map(p => ({ id: p.id, n: p.name, c: p.c,
      hp: p.hp, ammo: p.ammo, rl: !!p.reloadAt, d: p.dead, k: p.kills, de: p.deaths })));
  }
}, C.TICK_MS);

server.listen(PORT, '0.0.0.0', () => console.log('Servidor FPS na porta ' + PORT));
