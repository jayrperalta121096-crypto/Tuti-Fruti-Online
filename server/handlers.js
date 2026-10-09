// Eventos en tiempo real (Socket.IO). Cada evento valida la sesión y delega en game.js.
const game = require('./game');

// Límite simple de mensajes por socket (protege contra spam)
function rateLimiter() {
  let tokens = 40;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(40, tokens + ((now - last) / 1000) * 20);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function registerSocket(socket) {
  const allow = rateLimiter();
  socket.data.session = null;

  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };

  // Envuelve cada handler: control de errores + límite de mensajes
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      if (typeof payload === 'function') {
        ack = payload;
        payload = {};
      }
      if (!allow()) return reply(ack, { ok: false, error: 'Vas muy rápido, espera un momento.' });
      try {
        const out = handler(payload || {});
        reply(ack, { ok: true, ...(out || {}) });
      } catch (err) {
        if (!(err instanceof game.GameError)) console.error(`[${event}]`, err);
        reply(ack, { ok: false, error: err instanceof game.GameError ? err.message : 'Error inesperado.' });
      }
    });
  };

  const session = () => {
    const s = socket.data.session;
    if (!s) throw new game.GameError('No estás en una sala.');
    const room = game.getRoom(s.code);
    if (!room.players[s.pid]) throw new game.GameError('Ya no estás en esta sala.');
    return { room, pid: s.pid };
  };

  const bind = (room, pid) => {
    const prev = socket.data.session;
    if (prev && (prev.code !== room.code || prev.pid !== pid)) {
      socket.leave(prev.code);
      game.detachSocket(prev.code, prev.pid, socket.id);
    }
    socket.data.session = { code: room.code, pid };
    socket.join(room.code);
    game.attachSocket(room, pid, socket.id);
    game.broadcast(room);
  };

  on('room:create', ({ name, avatar, settings }) => {
    const { room, pid, token } = game.createRoom({ name, avatar, settings });
    bind(room, pid);
    return { code: room.code, playerId: pid, token };
  });

  on('room:check', ({ code }) => {
    const room = game.getRoom(code);
    return { code: room.code, phase: room.phase, players: Object.keys(room.players).length };
  });

  on('room:join', ({ code, name, avatar }) => {
    const { room, pid, token } = game.joinRoom({ code, name, avatar });
    bind(room, pid);
    return { code: room.code, playerId: pid, token };
  });

  on('room:rejoin', ({ code, playerId, token }) => {
    const { room } = game.auth(code, playerId, token);
    room.players[playerId].left = false;
    bind(room, playerId);
    return { code: room.code, playerId };
  });

  on('room:leave', () => {
    const { room, pid } = session();
    socket.leave(room.code);
    socket.data.session = null;
    game.leave(room, pid);
    if (game._rooms.has(room.code)) game.broadcast(room);
  });

  on('room:settings', ({ settings }) => {
    const { room, pid } = session();
    game.updateSettings(room, pid, settings);
    game.broadcast(room);
  });

  on('room:kick', ({ playerId }) => {
    const { room, pid } = session();
    game.kick(room, pid, playerId);
    game.broadcast(room);
  });

  on('game:start', () => {
    const { room, pid } = session();
    game.startGame(room, pid);
  });

  on('answers:update', ({ answers }) => {
    const { room, pid } = session();
    game.updateAnswers(room, pid, answers);
  });

  on('round:stop', ({ answers }) => {
    const { room, pid } = session();
    game.stopRound(room, pid, answers);
  });

  on('answers:final', ({ answers }) => {
    const { room, pid } = session();
    game.submitFinal(room, pid, answers);
  });

  on('letter:choose', ({ letter }) => {
    const { room, pid } = session();
    game.chooseLetter(room, pid, letter);
  });

  on('answer:judge', ({ playerId, catId, valid }) => {
    const { room, pid } = session();
    game.judgeAnswer(room, pid, { playerId, catId, valid });
    game.broadcast(room);
  });

  on('challenge:open', ({ playerId, catId }) => {
    const { room, pid } = session();
    game.openChallenge(room, pid, { playerId, catId });
    game.broadcast(room);
  });

  on('challenge:vote', ({ key, valid }) => {
    const { room, pid } = session();
    game.vote(room, pid, { key, valid });
    game.broadcast(room);
  });

  on('challenge:close', ({ key }) => {
    const { room, pid } = session();
    game.closeChallenge(room, pid, { key });
    game.broadcast(room);
  });

  on('round:next', () => {
    const { room, pid } = session();
    game.nextRound(room, pid);
  });

  on('game:again', () => {
    const { room, pid } = session();
    game.playAgain(room, pid);
    game.broadcast(room);
  });

  socket.on('disconnect', () => {
    const s = socket.data.session;
    if (s) game.detachSocket(s.code, s.pid, socket.id);
  });
}

module.exports = { registerSocket };
