// Lógica del juego: salas, estados, rondas, puntuación e impugnaciones.
// Toda la puntuación se calcula aquí, en el servidor. El navegador solo envía texto.
const crypto = require('crypto');
const { evaluate, isValidStatus } = require('./validation');
const store = require('./store');

// ---------------- Constantes ----------------
const PHASES = {
  LOBBY: 'LOBBY', // = WAITING_FOR_PLAYERS
  STARTING: 'STARTING', // cuenta regresiva 3-2-1
  PLAYING: 'PLAYING',
  ROUND_FINISHED: 'ROUND_FINISHED', // recolectando respuestas finales
  SHOWING_RESULTS: 'SHOWING_RESULTS', // resultados + impugnaciones + ranking
  FINAL_RESULTS: 'FINAL_RESULTS', // ganador
};

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const COUNTDOWN_MS = 3500;
const COLLECT_MS = 2000;
const RECONNECT_GRACE_MS = 15000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // salas inactivas se borran a las 6 h
const MAX_ANSWER_LEN = 40;

const DEFAULT_CATEGORIES = [
  { id: 'nombre', name: 'Nombre', dict: 'nombre', active: true },
  { id: 'apellido', name: 'Apellido', dict: 'apellido', active: true },
  { id: 'animal', name: 'Animal', dict: 'animal', active: true },
  { id: 'cosa', name: 'Cosa', dict: null, active: true },
  { id: 'color', name: 'Color', dict: 'color', active: true },
  { id: 'fruta', name: 'Fruta', dict: 'fruta', active: true },
  { id: 'verdura', name: 'Verdura', dict: 'verdura', active: true },
  { id: 'pais', name: 'País', dict: 'pais', active: true },
  { id: 'ciudad', name: 'Ciudad', dict: 'ciudad', active: true },
  { id: 'marca', name: 'Marca', dict: 'marca', active: true },
  { id: 'profesion', name: 'Profesión', dict: 'profesion', active: false },
  { id: 'pelicula', name: 'Película', dict: null, active: false },
];
const BUILTIN = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c]));

const ALL_LETTERS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.split('');
const DEFAULT_LETTERS = 'ABCDEFGHIJLMNOPRSTUV'.split('');
const AVATARS = ['🍎', '🍌', '🍇', '🍉', '🍓', '🍍', '🥭', '🍑', '🍒', '🥝', '🍋', '🥥', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐙', '🦄', '🐧', '🐢', '🦉'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------- Estado en memoria ----------------
const rooms = new Map(); // code -> room (persistido)
const runtime = new Map(); // code -> { sockets: Map<pid, Set<socketId>>, timers: {} } (no persistido)
let io = null;

function rt(code) {
  if (!runtime.has(code)) runtime.set(code, { sockets: new Map(), timers: {}, statusTimers: {} });
  return runtime.get(code);
}

class GameError extends Error {}
const fail = (msg) => {
  throw new GameError(msg);
};

// ---------------- Utilidades ----------------
const randomId = (n = 8) => crypto.randomBytes(n).toString('hex');
const cleanText = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function newCode() {
  for (let i = 0; i < 1000; i++) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let j = 0; j < 6; j++) code += CODE_CHARS[bytes[j] % CODE_CHARS.length];
    if (!rooms.has(code)) return code;
  }
  fail('No se pudo generar un código de sala.');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function sanitizeName(name) {
  const n = cleanText(name, 16);
  if (n.length < 1) fail('Escribe tu nombre.');
  return n;
}

function sanitizeAvatar(a) {
  return AVATARS.includes(a) ? a : AVATARS[crypto.randomInt(AVATARS.length)];
}

function uniqueName(room, name, exceptId) {
  const taken = new Set(Object.values(room.players).filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 50; i++) {
    const candidate = `${name.slice(0, 13)} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

function sanitizeSettings(input = {}) {
  const rounds = Math.round(Number(input.rounds));
  const roundTime = Math.round(Number(input.roundTime));
  const s = {
    rounds: Number.isFinite(rounds) ? Math.min(15, Math.max(1, rounds)) : 5,
    roundTime: Number.isFinite(roundTime) ? Math.min(300, Math.max(20, roundTime)) : 60,
    stopRequiresAll: input.stopRequiresAll !== false,
    categories: [],
    letters: [],
  };

  const cats = Array.isArray(input.categories) ? input.categories.slice(0, 30) : DEFAULT_CATEGORIES;
  const seenIds = new Set();
  const seenNames = new Set();
  for (const c of cats) {
    if (!c) continue;
    let id = String(c.id || '');
    const builtin = BUILTIN[id];
    const name = builtin ? builtin.name : cleanText(c.name, 20);
    if (!name || seenNames.has(name.toLowerCase())) continue;
    if (!builtin) id = /^c_[a-f0-9]{6,16}$/.test(id) ? id : `c_${randomId(4)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    seenNames.add(name.toLowerCase());
    s.categories.push({ id, name, dict: builtin ? builtin.dict : null, active: !!c.active, custom: !builtin });
  }
  const activeCount = s.categories.filter((c) => c.active).length;
  if (activeCount < 2) fail('Activa al menos 2 categorías.');
  if (activeCount > 15) fail('Máximo 15 categorías activas.');

  const letters = Array.isArray(input.letters) ? input.letters : DEFAULT_LETTERS;
  s.letters = ALL_LETTERS.filter((l) => letters.map((x) => String(x).toUpperCase()).includes(l));
  if (s.letters.length < 3) fail('Selecciona al menos 3 letras.');
  return s;
}

function connectedPlayers(room) {
  return Object.values(room.players).filter((p) => p.status !== 'disconnected');
}

function totals(room) {
  const t = {};
  for (const pid of Object.keys(room.players)) t[pid] = 0;
  for (const r of room.results) for (const [pid, pts] of Object.entries(r.scores)) t[pid] = (t[pid] || 0) + pts;
  return t;
}

// ---------------- Vista pública (lo que ve cada jugador) ----------------
function stateFor(room, pid) {
  const t = totals(room);
  const last = room.results[room.results.length - 1];
  const showLetter = room.phase !== PHASES.STARTING;
  const cur = room.current;
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: pid,
    serverNow: Date.now(),
    settings: room.settings,
    round: room.round,
    totalRounds: room.settings.rounds,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.order
      .filter((id) => room.players[id])
      .map((id) => {
        const p = room.players[id];
        return {
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          status: p.status,
          isHost: p.id === room.hostId,
          total: t[p.id] || 0,
          lastRound: last ? last.scores[p.id] || 0 : 0,
        };
      }),
    current: cur
      ? {
          letter: showLetter ? cur.letter : null,
          startsAt: cur.startsAt,
          endsAt: cur.endsAt,
          categories: cur.categories,
          stoppedBy: cur.stoppedBy || null,
          reason: cur.reason || null,
          myAnswers: (cur.answers && cur.answers[pid]) || {},
        }
      : null,
    // Las respuestas de los demás SOLO se envían cuando la ronda ya terminó y fue puntuada
    lastResult: [PHASES.SHOWING_RESULTS, PHASES.FINAL_RESULTS].includes(room.phase) && last ? last : null,
    history: room.results.map((r) => ({ round: r.round, letter: r.letter, scores: r.scores })),
  };
}

function broadcast(room) {
  room.updatedAt = Date.now();
  store.saveRoom(room);
  if (!io) return;
  const r = rt(room.code);
  for (const [pid, sockets] of r.sockets) {
    if (!room.players[pid]) continue;
    const state = stateFor(room, pid);
    for (const sid of sockets) io.to(sid).emit('state', state);
  }
}

function emitToPlayer(room, pid, event, payload) {
  const set = rt(room.code).sockets.get(pid);
  if (!set || !io) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

// ---------------- Sesión / conexión ----------------
function attachSocket(room, pid, socketId) {
  const r = rt(room.code);
  if (!r.sockets.has(pid)) r.sockets.set(pid, new Set());
  r.sockets.get(pid).add(socketId);
  clearTimeout(r.statusTimers[pid]);
  const p = room.players[pid];
  p.status = 'connected';
  p.lastSeen = Date.now();
}

function detachSocket(code, pid, socketId) {
  const room = rooms.get(code);
  if (!room || !room.players[pid]) return;
  const r = rt(code);
  const set = r.sockets.get(pid);
  if (set) {
    set.delete(socketId);
    if (set.size > 0) return;
    r.sockets.delete(pid);
  }
  const p = room.players[pid];
  p.status = 'reconnecting';
  p.lastSeen = Date.now();
  broadcast(room);
  clearTimeout(r.statusTimers[pid]);
  r.statusTimers[pid] = setTimeout(() => {
    const room2 = rooms.get(code);
    if (!room2 || !room2.players[pid] || room2.players[pid].status === 'connected') return;
    room2.players[pid].status = 'disconnected';
    if (room2.hostId === pid) transferHost(room2);
    // Si estaban esperando respuestas finales, ya no esperar a este jugador
    maybeFinishCollect(room2);
    broadcast(room2);
  }, RECONNECT_GRACE_MS);
}

function transferHost(room) {
  const next = room.order.map((id) => room.players[id]).find((p) => p && p.status === 'connected' && p.id !== room.hostId);
  if (next) room.hostId = next.id;
}

// ---------------- Acciones de sala ----------------
function createRoom({ name, avatar, settings }) {
  const s = sanitizeSettings(settings);
  const code = newCode();
  const pid = randomId(6);
  const token = randomId(16);
  const room = {
    code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostId: pid,
    settings: s,
    phase: PHASES.LOBBY,
    players: {},
    order: [],
    banned: [],
    round: 0,
    usedLetters: [],
    current: null,
    results: [],
  };
  room.players[pid] = { id: pid, name: sanitizeName(name), avatar: sanitizeAvatar(avatar), token, status: 'connected', joinedAt: Date.now() };
  room.order.push(pid);
  rooms.set(code, room);
  return { room, pid, token };
}

function getRoom(code) {
  const room = rooms.get(normalizeCode(code));
  if (!room) fail('No existe una sala con ese código.');
  return room;
}

function joinRoom({ code, name, avatar }) {
  const room = getRoom(code);
  if (room.phase === PHASES.FINAL_RESULTS) fail('Esta partida ya terminó. Pide al anfitrión que inicie otra.');
  const active = Object.values(room.players).filter((p) => p.status !== 'disconnected');
  if (active.length >= MAX_PLAYERS) fail(`La sala está llena (máximo ${MAX_PLAYERS} jugadores).`);
  const pid = randomId(6);
  const token = randomId(16);
  const clean = sanitizeName(name);
  room.players[pid] = {
    id: pid,
    name: uniqueName(room, clean),
    avatar: sanitizeAvatar(avatar),
    token,
    status: 'connected',
    joinedAt: Date.now(),
  };
  room.order.push(pid);
  return { room, pid, token };
}

function auth(code, pid, token) {
  const room = getRoom(code);
  const p = room.players[pid];
  if (!p || !token || p.token !== token) {
    if (room.banned.includes(token)) fail('Fuiste retirado de esta sala por el anfitrión.');
    fail('Tu sesión en esta sala ya no es válida.');
  }
  return { room, player: p };
}

function requireHost(room, pid) {
  if (room.hostId !== pid) fail('Solo el anfitrión puede hacer esto.');
}

function updateSettings(room, pid, settings) {
  requireHost(room, pid);
  if (room.phase !== PHASES.LOBBY) fail('Solo se pueden cambiar los ajustes antes de iniciar.');
  room.settings = sanitizeSettings(settings);
}

function kick(room, pid, targetId) {
  requireHost(room, pid);
  if (room.phase !== PHASES.LOBBY) fail('Solo puedes expulsar jugadores antes de iniciar la partida.');
  if (targetId === pid) fail('No puedes expulsarte a ti mismo.');
  const target = room.players[targetId];
  if (!target) fail('Ese jugador ya no está en la sala.');
  room.banned.push(target.token);
  emitToPlayer(room, targetId, 'kicked', { message: 'El anfitrión te retiró de la sala.' });
  removePlayer(room, targetId);
}

function removePlayer(room, targetId) {
  const r = rt(room.code);
  if (io) for (const sid of r.sockets.get(targetId) || []) io.sockets.sockets.get(sid)?.leave(room.code);
  r.sockets.delete(targetId);
  clearTimeout(r.statusTimers[targetId]);
  delete room.players[targetId];
  room.order = room.order.filter((id) => id !== targetId);
}

function leave(room, pid) {
  if (room.phase === PHASES.LOBBY) {
    removePlayer(room, pid);
  } else {
    // Durante la partida se conserva su puntaje, pero queda desconectado
    const r = rt(room.code);
    r.sockets.delete(pid);
    room.players[pid].status = 'disconnected';
    room.players[pid].left = true;
  }
  if (room.hostId === pid || !room.players[room.hostId]) transferHost(room);
  if (!room.players[room.hostId] && room.order.length) room.hostId = room.order[0];
  if (room.order.length === 0 || connectedPlayers(room).length === 0) {
    if (room.order.length === 0) deleteRoom(room.code);
  }
  maybeFinishCollect(room);
}

function deleteRoom(code) {
  const r = runtime.get(code);
  if (r) {
    Object.values(r.timers).forEach(clearTimeout);
    Object.values(r.statusTimers).forEach(clearTimeout);
  }
  runtime.delete(code);
  rooms.delete(code);
  store.removeRoom(code);
}

// ---------------- Rondas ----------------
function startGame(room, pid) {
  requireHost(room, pid);
  if (room.phase !== PHASES.LOBBY) fail('La partida ya comenzó.');
  if (connectedPlayers(room).length < MIN_PLAYERS) fail(`Se necesitan al menos ${MIN_PLAYERS} jugadores conectados.`);
  // Limpiar jugadores que abandonaron en el lobby
  for (const p of Object.values(room.players)) if (p.status === 'disconnected') removePlayer(room, p.id);
  room.round = 0;
  room.results = [];
  room.usedLetters = [];
  startRound(room);
}

function pickLetter(room) {
  let pool = room.settings.letters.filter((l) => !room.usedLetters.includes(l));
  if (pool.length === 0) {
    room.usedLetters = [];
    pool = room.settings.letters.slice();
  }
  const letter = pool[crypto.randomInt(pool.length)];
  room.usedLetters.push(letter);
  return letter;
}

function startRound(room) {
  room.round += 1;
  const now = Date.now();
  const startsAt = now + COUNTDOWN_MS;
  room.current = {
    letter: pickLetter(room),
    startsAt,
    endsAt: startsAt + room.settings.roundTime * 1000,
    categories: room.settings.categories.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, dict: c.dict })),
    answers: {},
    submitted: {},
    stoppedBy: null,
    reason: null,
  };
  room.phase = PHASES.STARTING;
  scheduleTimers(room);
  broadcast(room);
}

function scheduleTimers(room) {
  const r = rt(room.code);
  clearTimeout(r.timers.phase);
  const now = Date.now();
  if (room.phase === PHASES.STARTING) {
    r.timers.phase = setTimeout(() => {
      if (room.phase !== PHASES.STARTING) return;
      room.phase = PHASES.PLAYING;
      scheduleTimers(room);
      broadcast(room);
    }, Math.max(0, room.current.startsAt - now));
  } else if (room.phase === PHASES.PLAYING) {
    r.timers.phase = setTimeout(() => {
      if (room.phase === PHASES.PLAYING) endRound(room, null, 'timeout');
    }, Math.max(0, room.current.endsAt - now));
  } else if (room.phase === PHASES.ROUND_FINISHED) {
    r.timers.phase = setTimeout(() => scoreRound(room), COLLECT_MS);
  }
}

function sanitizeAnswers(room, answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const c of room.current.categories) {
    if (typeof answers[c.id] === 'string') out[c.id] = cleanText(answers[c.id], MAX_ANSWER_LEN);
  }
  return out;
}

// Durante PLAYING se aceptan actualizaciones; tras ¡TIEMPO! solo UNA entrega final
// (lo último que el jugador tenía escrito al bloquearse la pantalla).
function canWriteAnswers(room, pid, final) {
  if (room.current.submitted[pid]) return false;
  if (room.phase === PHASES.PLAYING) return Date.now() <= room.current.endsAt + 1500;
  return final && room.phase === PHASES.ROUND_FINISHED;
}

function updateAnswers(room, pid, answers, final = false) {
  if (!room.current || !canWriteAnswers(room, pid, final)) return false;
  room.current.answers[pid] = { ...(room.current.answers[pid] || {}), ...sanitizeAnswers(room, answers) };
  store.saveRoom(room);
  return true;
}

function stopRound(room, pid, answers) {
  if (room.phase !== PHASES.PLAYING) fail('La ronda no está en juego.');
  updateAnswers(room, pid, answers);
  if (room.settings.stopRequiresAll) {
    const mine = room.current.answers[pid] || {};
    const missing = room.current.categories.filter((c) => !mine[c.id]);
    if (missing.length) fail(`Completa todas las categorías antes de decir ¡TIEMPO! (faltan ${missing.length}).`);
  }
  room.current.submitted[pid] = true;
  endRound(room, pid, 'stop');
}

function endRound(room, pid, reason) {
  if (room.phase !== PHASES.PLAYING) return;
  room.phase = PHASES.ROUND_FINISHED;
  room.current.stoppedBy = pid;
  room.current.reason = reason;
  room.current.endedAt = Date.now();
  scheduleTimers(room);
  broadcast(room);
}

function submitFinal(room, pid, answers) {
  if (room.phase !== PHASES.ROUND_FINISHED) return;
  updateAnswers(room, pid, answers, true);
  room.current.submitted[pid] = true;
  maybeFinishCollect(room);
}

function maybeFinishCollect(room) {
  if (!room || room.phase !== PHASES.ROUND_FINISHED) return;
  const waiting = connectedPlayers(room).filter((p) => !room.current.submitted[p.id]);
  if (waiting.length === 0) scoreRound(room);
}

function scoreRound(room) {
  if (room.phase !== PHASES.ROUND_FINISHED) return;
  clearTimeout(rt(room.code).timers.phase);
  const cur = room.current;
  const participants = room.order.filter((id) => room.players[id]);
  const result = {
    round: room.round,
    letter: cur.letter,
    categories: cur.categories.map((c) => ({ id: c.id, name: c.name })),
    stoppedBy: cur.stoppedBy,
    reason: cur.reason,
    players: participants,
    answers: {},
    challenges: {},
    scores: {},
  };
  for (const pid of participants) {
    result.answers[pid] = {};
    const given = cur.answers[pid] || {};
    for (const c of cur.categories) {
      const text = given[c.id] || '';
      const ev = evaluate(text, cur.letter, c.dict);
      result.answers[pid][c.id] = { text, status: ev.status, auto: ev.status, key: ev.key, points: 0, shared: false };
    }
  }
  rescore(result);
  room.results.push(result);
  room.phase = PHASES.SHOWING_RESULTS;
  broadcast(room);
}

/** Recalcula los puntos de una ronda: 10 única, 5 repetida, 0 inválida/vacía. */
function rescore(result) {
  for (const c of result.categories) {
    const counts = {};
    for (const pid of result.players) {
      const a = result.answers[pid][c.id];
      if (isValidStatus(a.status)) counts[a.key] = (counts[a.key] || 0) + 1;
    }
    for (const pid of result.players) {
      const a = result.answers[pid][c.id];
      if (isValidStatus(a.status)) {
        a.shared = counts[a.key] > 1;
        a.points = a.shared ? 5 : 10;
      } else {
        a.shared = false;
        a.points = 0;
      }
    }
  }
  for (const pid of result.players) {
    result.scores[pid] = result.categories.reduce((sum, c) => sum + result.answers[pid][c.id].points, 0);
  }
}

// ---------------- Impugnaciones / revisión manual ----------------
function currentResult(room) {
  if (room.phase !== PHASES.SHOWING_RESULTS) fail('Solo se puede revisar durante los resultados.');
  return room.results[room.results.length - 1];
}

function eligibleVoters(room, result, authorId) {
  return result.players.filter((id) => id !== authorId && room.players[id] && room.players[id].status !== 'disconnected');
}

function openChallenge(room, pid, { playerId, catId }) {
  const result = currentResult(room);
  const ans = result.answers[playerId] && result.answers[playerId][catId];
  if (!ans) fail('Respuesta no encontrada.');
  if (ans.status === 'empty') fail('No hay nada que revisar en una respuesta vacía.');
  const key = `${playerId}|${catId}`;
  const existing = result.challenges[key];
  if (existing) fail(existing.open ? 'Esa respuesta ya está en votación.' : 'Esa respuesta ya fue revisada.');
  if (ans.status === 'bad_letter') fail('Esa respuesta no empieza con la letra de la ronda.');
  result.challenges[key] = { key, playerId, catId, by: pid, votes: {}, open: true, outcome: null };
  // Quien impugna vota "no válida" automáticamente (si no es el autor)
  if (pid !== playerId) result.challenges[key].votes[pid] = false;
  maybeCloseChallenge(room, result, key);
}

function vote(room, pid, { key, valid }) {
  const result = currentResult(room);
  const ch = result.challenges[key];
  if (!ch || !ch.open) fail('Esa votación ya terminó.');
  if (pid === ch.playerId) fail('No puedes votar tu propia respuesta.');
  if (!result.players.includes(pid)) fail('No participaste en esta ronda.');
  ch.votes[pid] = !!valid;
  maybeCloseChallenge(room, result, key);
}

function maybeCloseChallenge(room, result, key, force = false) {
  const ch = result.challenges[key];
  if (!ch || !ch.open) return;
  const voters = eligibleVoters(room, result, ch.playerId);
  const allVoted = voters.every((id) => id in ch.votes);
  if (!allVoted && !force) return;
  const yes = Object.values(ch.votes).filter(Boolean).length;
  const no = Object.values(ch.votes).length - yes;
  ch.open = false;
  // Empate o sin votos → se mantiene la respuesta (beneficio de la duda)
  ch.outcome = no > yes ? 'rejected' : 'accepted';
  result.answers[ch.playerId][ch.catId].status = ch.outcome;
  rescore(result);
}

function closeChallenge(room, pid, { key }) {
  requireHost(room, pid);
  const result = currentResult(room);
  maybeCloseChallenge(room, result, key, true);
}

function nextRound(room, pid) {
  requireHost(room, pid);
  if (room.phase !== PHASES.SHOWING_RESULTS) fail('Aún no se puede avanzar.');
  const result = room.results[room.results.length - 1];
  for (const key of Object.keys(result.challenges)) maybeCloseChallenge(room, result, key, true);
  if (room.round >= room.settings.rounds) {
    room.phase = PHASES.FINAL_RESULTS;
    room.current = null;
    broadcast(room);
  } else {
    startRound(room);
  }
}

function playAgain(room, pid) {
  requireHost(room, pid);
  if (room.phase !== PHASES.FINAL_RESULTS) fail('La partida aún no termina.');
  for (const p of Object.values(room.players)) if (p.status === 'disconnected') removePlayer(room, p.id);
  room.phase = PHASES.LOBBY;
  room.round = 0;
  room.results = [];
  room.usedLetters = [];
  room.current = null;
}

// ---------------- Arranque / limpieza ----------------
function restoreRooms() {
  const now = Date.now();
  for (const room of store.loadRooms()) {
    if (!room || !room.code || now - (room.updatedAt || 0) > ROOM_TTL_MS) {
      if (room && room.code) store.removeRoom(room.code);
      continue;
    }
    // Tras un reinicio nadie está conectado aún; se marcan "reconectando"
    for (const p of Object.values(room.players)) {
      p.status = 'reconnecting';
      const r = rt(room.code);
      r.statusTimers[p.id] = setTimeout(() => {
        if (room.players[p.id] && room.players[p.id].status !== 'connected') {
          room.players[p.id].status = 'disconnected';
          if (room.hostId === p.id) transferHost(room);
          maybeFinishCollect(room);
          broadcast(room);
        }
      }, RECONNECT_GRACE_MS * 2);
    }
    rooms.set(room.code, room);
    if (room.phase === PHASES.ROUND_FINISHED) scoreRound(room);
    else scheduleTimers(room);
  }
  if (rooms.size) console.log(`Salas restauradas: ${rooms.size}`);
}

function cleanup() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = connectedPlayers(room).length > 0;
    if (!anyone && now - room.updatedAt > 1000 * 60 * 30) deleteRoom(room.code);
    else if (now - room.updatedAt > ROOM_TTL_MS) deleteRoom(room.code);
  }
}

function init(ioInstance) {
  io = ioInstance;
  restoreRooms();
  setInterval(cleanup, 1000 * 60 * 5).unref();
}

module.exports = {
  init,
  PHASES,
  DEFAULT_CATEGORIES,
  DEFAULT_LETTERS,
  ALL_LETTERS,
  AVATARS,
  GameError,
  normalizeCode,
  createRoom,
  joinRoom,
  getRoom,
  auth,
  attachSocket,
  detachSocket,
  stateFor,
  broadcast,
  updateSettings,
  kick,
  leave,
  startGame,
  updateAnswers,
  stopRound,
  submitFinal,
  openChallenge,
  vote,
  closeChallenge,
  nextRound,
  playAgain,
  _rooms: rooms,
};
