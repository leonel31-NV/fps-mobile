'use strict';
const $ = id => document.getElementById(id);
const BACKEND = (window.BACKEND_URL || '').replace(/\/$/, '') || location.origin;
const FOV = Math.PI / 3, ARENA = 25;
let socket, myId, roomCode = '', myName = '';
let players = new Map(); // id -> { ...estado do servidor, dx, dy (posição suavizada) }
let yaw = 0, mx = 0, my = 0, firing = false, lastFire = 0, hitFlash = 0, camStream = null;
const keys = {};
const cv = $('view'), ctx = cv.getContext('2d'), rctx = $('radar').getContext('2d');

function msg(t) { $('msg').textContent = t || ''; }
function resize() { const d = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * d; cv.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); }
addEventListener('resize', resize); resize();

function loadSocketLib() {
  return new Promise((ok, fail) => {
    if (window.io) return ok();
    const s = document.createElement('script'); s.src = BACKEND + '/socket.io/socket.io.js';
    s.onload = ok; s.onerror = () => fail(new Error('Não foi possível alcançar o servidor.')); document.head.appendChild(s);
  });
}
async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    $('cam').srcObject = camStream;
  } catch (e) {
    const m = { NotAllowedError: 'Permissão da câmera negada. Jogando sem câmera.', NotFoundError: 'Nenhuma câmera encontrada. Jogando sem câmera.' };
    feed((window.isSecureContext ? (m[e.name] || 'Câmera indisponível. Jogando sem câmera.') : 'A câmera exige HTTPS. Jogando sem câmera.'));
  }
}
async function connect() {
  if (socket) return socket;
  await loadSocketLib();
  socket = io(BACKEND, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { myId = socket.id; if (roomCode && !$('hud').hidden) rejoin(); });
  socket.on('state', list => {
    const seen = new Set();
    for (const s of list) { seen.add(s.id); const o = players.get(s.id);
      players.set(s.id, Object.assign(s, { dx: o ? o.dx : s.x, dy: o ? o.dy : s.y, ryaw: s.yaw })); }
    for (const id of players.keys()) if (!seen.has(id)) players.delete(id);
    updateHud();
  });
  socket.on('shot', e => { if (e.hit === myId) { hitFlash = 1; navigator.vibrate && navigator.vibrate(60); } });
  socket.on('kill', e => feed(e.byName + ' eliminou ' + e.victimName));
  return socket;
}
function enter(code) {
  roomCode = code; $('lobby').hidden = true; $('hud').hidden = false; $('roomcode').textContent = 'Sala ' + code;
  startCamera(); requestAnimationFrame(loop);
}
function rejoin() { // reconexão: entra de novo na mesma sala se ela ainda existir
  socket.emit('join', { code: roomCode, name: myName }, r => { if (!r.ok) { feed(r.error); leaveRoom(); } });
}
async function lobbyAction(kind) {
  myName = $('name').value.trim() || 'Jogador'; msg('Conectando…');
  try { await connect(); } catch (e) { return msg(e.message); }
  const done = r => { if (!r.ok) return msg(r.error); msg(''); enter(r.code); };
  if (kind === 'create') socket.emit('create', myName, done);
  else socket.emit('join', { code: $('code').value, name: myName }, done);
}
function leaveRoom() {
  socket && socket.emit('leave'); roomCode = ''; players.clear();
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  $('hud').hidden = true; $('lobby').hidden = false;
}
$('create').onclick = () => lobbyAction('create');
$('join').onclick = () => lobbyAction('join');
$('quit').onclick = leaveRoom;

function feed(t) { const d = document.createElement('div'); d.textContent = t; $('feed').appendChild(d); setTimeout(() => d.remove(), 4000); }
function updateHud() {
  const me = players.get(myId); if (!me) return;
  $('hpfill').style.width = me.hp + '%'; $('ammo').textContent = me.rl ? 'Recarregando…' : me.ammo + ' / 12';
  $('dead').hidden = !me.d;
  $('board').innerHTML = [...players.values()].sort((a, b) => b.k - a.k).map(p =>
    `<li class="${p.id === myId ? 'me' : ''}"><span></span><b>${p.k}/${p.de}</b></li>`).join('');
  [...$('board').children].forEach((li, i) => li.firstChild.textContent = [...players.values()].sort((a, b) => b.k - a.k)[i].n);
}

// Controles
const stick = $('stick'), knob = $('knob'); let stickId = null, lookId = null, lx = 0;
stick.addEventListener('pointerdown', e => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); moveStick(e); });
stick.addEventListener('pointermove', e => { if (e.pointerId === stickId) moveStick(e); });
const endStick = e => { if (e.pointerId === stickId) { stickId = null; mx = my = 0; knob.style.transform = ''; } };
stick.addEventListener('pointerup', endStick); stick.addEventListener('pointercancel', endStick);
function moveStick(e) {
  const r = stick.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / 45, y = (e.clientY - r.top - r.height / 2) / 45;
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  mx = x; my = -y; knob.style.transform = `translate(${x * 45}px,${y * 45}px)`;
}
cv.addEventListener('pointerdown', e => { if (lookId === null) { lookId = e.pointerId; lx = e.clientX; cv.setPointerCapture(e.pointerId); } });
cv.addEventListener('pointermove', e => { if (e.pointerId === lookId) { yaw += (e.clientX - lx) * 0.006; lx = e.clientX; } });
const endLook = e => { if (e.pointerId === lookId) lookId = null; };
cv.addEventListener('pointerup', endLook); cv.addEventListener('pointercancel', endLook);
const fire = $('fire');
fire.addEventListener('pointerdown', e => { firing = true; fire.setPointerCapture(e.pointerId); });
['pointerup', 'pointercancel'].forEach(t => fire.addEventListener(t, () => firing = false));
$('rld').addEventListener('pointerdown', () => socket && socket.emit('reload'));
addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'KeyR') socket && socket.emit('reload'); if (e.code === 'Space') firing = true; });
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Space') firing = false; });

setInterval(() => { // envia entrada ao servidor
  if (!socket || $('hud').hidden) return;
  let kx = mx, ky = my;
  if (keys.KeyW) ky = 1; if (keys.KeyS) ky = -1; if (keys.KeyD) kx = 1; if (keys.KeyA) kx = -1;
  if (keys.ArrowLeft) yaw -= 0.06; if (keys.ArrowRight) yaw += 0.06;
  socket.emit('input', { mx: kx, my: ky, yaw });
}, 50);

// Desenho
function loop(t) {
  if ($('hud').hidden) return;
  if (firing && t - lastFire > 260) { lastFire = t; socket.emit('shoot'); }
  const W = innerWidth, H = innerHeight, tf = Math.tan(FOV / 2); ctx.clearRect(0, 0, W, H);
  const me = players.get(myId);
  if (me) {
    const list = [];
    for (const p of players.values()) {
      p.dx += (p.x - p.dx) * 0.35; p.dy += (p.y - p.dy) * 0.35;
      if (p.id === myId) continue;
      const ex = p.dx - me.dx, ey = p.dy - me.dy, dist = Math.hypot(ex, ey);
      let rel = Math.atan2(ex, ey) - yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (p.d || Math.abs(rel) > FOV / 2 + 0.4 || dist < 0.5) continue;
      list.push({ p, rel, dist });
    }
    list.sort((a, b) => b.dist - a.dist).forEach(({ p, rel, dist }) => {
      const sx = W / 2 + Math.tan(rel) / tf * (W / 2), w = Math.min(W, 1.2 * W / (2 * dist * tf)), h = w * 2, top = H / 2 - h * 0.45;
      ctx.fillStyle = '#ff5a4d'; ctx.globalAlpha = .9; ctx.fillRect(sx - w / 2, top + h * 0.2, w, h * 0.8);
      ctx.beginPath(); ctx.arc(sx, top + h * 0.1, w * 0.3, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(sx - w / 2, top - 14, w, 6);
      ctx.fillStyle = '#5ad19a'; ctx.fillRect(sx - w / 2, top - 14, w * p.hp / 100, 6);
      ctx.fillStyle = '#f2efe6'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(p.n, sx, top - 20);
    });
    drawRadar(me);
  }
  const cx = W / 2, cy = H / 2; ctx.strokeStyle = hitFlash > 0 ? '#ff5a4d' : '#ffb020'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 14, cy);
  ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 14); ctx.stroke();
  if (hitFlash > 0) { ctx.fillStyle = `rgba(255,60,50,${hitFlash * 0.35})`; ctx.fillRect(0, 0, W, H); hitFlash -= 0.04; }
  requestAnimationFrame(loop);
}
function drawRadar(me) {
  const s = 200, k = s / 2 / ARENA; rctx.clearRect(0, 0, s, s); rctx.save(); rctx.translate(s / 2, s / 2); rctx.rotate(-yaw);
  rctx.strokeStyle = 'rgba(242,239,230,.4)'; rctx.strokeRect((-ARENA - me.dx) * k, (-ARENA - me.dy) * -k - 2 * ARENA * k, 2 * ARENA * k, 2 * ARENA * k);
  for (const p of players.values()) { if (p.id === myId || p.d) continue;
    rctx.fillStyle = '#ff5a4d'; rctx.beginPath(); rctx.arc((p.dx - me.dx) * k, -(p.dy - me.dy) * k, 5, 0, 7); rctx.fill(); }
  rctx.restore(); rctx.fillStyle = '#ffb020'; rctx.beginPath(); rctx.moveTo(s / 2, s / 2 - 9); rctx.lineTo(s / 2 - 6, s / 2 + 6); rctx.lineTo(s / 2 + 6, s / 2 + 6); rctx.fill();
}
