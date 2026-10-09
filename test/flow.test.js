// Prueba automática del flujo completo con 3 jugadores reales vía WebSockets.
// Uso: npm test
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');
const { DICT_SETS } = require('../server/validation');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-'));
let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error('FALLÓ: ' + msg);
  passed++;
  console.log('  ✔', msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT, DATA_DIR: dataDir },
    });
    proc.stdout.on('data', (d) => d.toString().includes('escuchando') && resolve(proc));
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}

function client(label) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.label = label;
  s.state = null;
  s.on('state', (st) => (s.state = st));
  s.call = (ev, payload = {}) => new Promise((res) => s.emit(ev, payload, res));
  s.waitPhase = async (phase, timeout = 8000) => {
    const t0 = Date.now();
    while (!s.state || s.state.phase !== phase) {
      if (Date.now() - t0 > timeout) throw new Error(`${label}: timeout esperando ${phase} (actual ${s.state && s.state.phase})`);
      await sleep(50);
    }
    return s.state;
  };
  return new Promise((res) => s.on('connect', () => res(s)));
}

const wordFor = (dict, letter, skip = 0) => {
  const l = letter.toLowerCase();
  const list = [...(DICT_SETS[dict] || [])].filter((w) => w.startsWith(l));
  return list[skip] || list[0] || `${l}zzz`;
};

async function main() {
  const server = await startServer();
  try {
    console.log('\n1) CREAR SALA');
    const juan = await client('Juan');
    const created = await juan.call('room:create', {
      name: 'Juan',
      avatar: '🍎',
      settings: {
        rounds: 2,
        roundTime: 20,
        stopRequiresAll: true,
        categories: [
          { id: 'nombre', active: true },
          { id: 'animal', active: true },
          { id: 'fruta_verdura', active: true },
          { id: 'pais_ciudad', active: true },
          { id: 'c_abc123', name: 'Superhéroe', active: true },
          { id: 'cosa', active: false },
        ],
      },
    });
    ok(created.ok && /^[A-Z0-9]{6}$/.test(created.code), `sala creada con código ${created.code}`);
    const code = created.code;

    console.log('\n2) UNIR JUGADORES');
    const bad = await (await client('X')).call('room:join', { code: 'ZZZZZZ', name: 'X' });
    ok(!bad.ok, 'código inexistente es rechazado: ' + bad.error);
    const carlos = await client('Carlos');
    const maria = await client('María');
    const pedro = await client('Pedro');
    const jc = await carlos.call('room:join', { code: code.toLowerCase(), name: 'Carlos' });
    const jm = await maria.call('room:join', { code, name: 'María' });
    const jp = await pedro.call('room:join', { code, name: 'Juan' });
    ok(jc.ok && jm.ok && jp.ok, 'tres jugadores se unen (código sin distinguir mayúsculas)');
    await sleep(150);
    ok(juan.state.players.length === 4, 'el lobby muestra 4 jugadores');
    ok(juan.state.players.some((p) => p.name === 'Juan 2'), 'nombres repetidos se diferencian ("Juan 2")');

    const kNo = await carlos.call('room:kick', { playerId: jp.playerId });
    ok(!kNo.ok, 'un no-anfitrión no puede expulsar');
    let kicked = false;
    pedro.on('kicked', () => (kicked = true));
    const k = await juan.call('room:kick', { playerId: jp.playerId });
    await sleep(150);
    ok(k.ok && kicked && juan.state.players.length === 3, 'el anfitrión expulsa a un jugador');
    const rejKicked = await pedro.call('room:rejoin', { code, playerId: jp.playerId, token: jp.token });
    ok(!rejKicked.ok, 'el expulsado no puede volver con su sesión');

    console.log('\n3) RECONEXIÓN (simula refrescar la página)');
    maria.disconnect();
    await sleep(200);
    ok(juan.state.players.find((p) => p.id === jm.playerId).status === 'reconnecting', 'María aparece "reconectando"');
    const maria2 = await client('María');
    const rj = await maria2.call('room:rejoin', { code, playerId: jm.playerId, token: jm.token });
    await sleep(150);
    ok(rj.ok && juan.state.players.find((p) => p.id === jm.playerId).status === 'connected', 'María reconecta con su sesión');
    const fake = await maria2.call('room:rejoin', { code, playerId: jm.playerId, token: 'hack' });
    ok(!fake.ok, 'token falso es rechazado');

    console.log('\n4) INICIAR');
    const sNo = await carlos.call('game:start');
    ok(!sNo.ok, 'solo el anfitrión inicia');
    ok((await juan.call('game:start')).ok, 'anfitrión inicia la partida');
    let st = await juan.waitPhase('CHOOSING_LETTER');
    ok(st.chooserId === created.playerId, 'ronda 1: le toca elegir la letra a Juan (primer jugador)');
    ok(!(await carlos.call('letter:choose', { letter: 'M' })).ok, 'otro jugador no puede elegir la letra');
    ok(!(await juan.call('letter:choose', { letter: '7' })).ok, 'un carácter que no es letra es rechazado');
    ok((await juan.call('letter:choose', { letter: 'm' })).ok, 'Juan escribe la letra "m"');
    st = await juan.waitPhase('STARTING');
    ok(st.current.letter === 'M' && st.current.chosenBy === created.playerId, 'cuenta regresiva muestra la letra M elegida por Juan');
    st = await juan.waitPhase('PLAYING');
    const L = st.current.letter;
    ok(L === 'M', `LETRA de la ronda 1: ${L}`);
    ok(st.current.categories.map((c) => c.name).join(',') === 'Nombre,Animal,Fruta o Verdura,País o Ciudad,Superhéroe', 'categorías activas en orden');

    console.log('\n5) RESPUESTAS');
    const A = (dict, skip) => wordFor(dict, L, skip);
    const ansJuan = { nombre: A('nombre'), animal: A('animal'), fruta_verdura: A('verdura'), pais_ciudad: A('ciudad'), c_abc123: L + 'uperman' };
    const ansCarlos = { nombre: A('nombre', 1), animal: A('animal'), fruta_verdura: 'Zanahoria', pais_ciudad: '', c_abc123: L + 'atmanx' };
    const ansMaria = { nombre: A('nombre', 2), animal: L + 'qwertyanimal', fruta_verdura: A('fruta', 1), pais_ciudad: A('pais', 1), c_abc123: '' };
    carlos.emit('answers:update', { answers: ansCarlos });
    maria2.emit('answers:update', { answers: ansMaria });
    await sleep(150);
    ok(!JSON.stringify(juan.state).includes(ansCarlos.c_abc123), 'las respuestas de otros NO llegan durante la ronda');

    const stopIncomplete = await carlos.call('round:stop', { answers: ansCarlos });
    ok(!stopIncomplete.ok, '¡TIEMPO! rechazado si faltan categorías: ' + stopIncomplete.error);

    console.log('\n6) ¡TIEMPO!');
    const stop = await juan.call('round:stop', { answers: ansJuan });
    ok(stop.ok, 'Juan presiona ¡TIEMPO!');
    // los demás clientes envían su respuesta final al ver ROUND_FINISHED
    await carlos.waitPhase('ROUND_FINISHED').catch(() => {});
    carlos.emit('answers:final', { answers: ansCarlos });
    maria2.emit('answers:final', { answers: ansMaria });
    const late = await carlos.call('answers:update', { answers: { nombre: 'TRAMPA' } });
    st = await juan.waitPhase('SHOWING_RESULTS');

    console.log('\n7) RESULTADOS Y PUNTUACIÓN');
    const r = st.lastResult;
    ok(r && r.round === 1 && r.letter === L, 'se muestra la tabla de resultados de la ronda 1');
    const a = (pid, cat) => r.answers[pid][cat];
    const J = created.playerId, C = jc.playerId, M = jm.playerId;
    ok(a(C, 'nombre').text !== 'TRAMPA', 'no se aceptan cambios después de ¡TIEMPO!');
    ok(a(J, 'nombre').points === 10, `Nombre único "${a(J, 'nombre').text}" → +10`);
    ok(a(J, 'animal').points === 5 && a(C, 'animal').points === 5, `Animal repetido "${a(J, 'animal').text}" → +5 cada uno`);
    ok(a(J, 'fruta_verdura').status === 'ok' && a(M, 'fruta_verdura').status === 'ok', `"Fruta o Verdura" reconoce verdura (${a(J, 'fruta_verdura').text}) y fruta (${a(M, 'fruta_verdura').text})`);
    ok(a(J, 'pais_ciudad').status === 'ok' && a(M, 'pais_ciudad').status === 'ok', `"País o Ciudad" reconoce ciudad (${a(J, 'pais_ciudad').text}) y país (${a(M, 'pais_ciudad').text})`);
    ok(a(C, 'fruta_verdura').status === 'bad_letter' && a(C, 'fruta_verdura').points === 0, 'Fruta o Verdura con otra letra → 0');
    ok(a(C, 'pais_ciudad').status === 'empty' && a(C, 'pais_ciudad').points === 0, 'Respuesta vacía → 0');
    ok(a(M, 'animal').status === 'review' && a(M, 'animal').points === 10, 'Palabra no reconocida NO se elimina: queda "por revisar" (+10 provisional)');
    ok(a(J, 'c_abc123').status === 'free' && a(J, 'c_abc123').points === 10, 'Categoría personalizada acepta respuestas');
    const sumJ = Object.values(r.answers[J]).reduce((s, x) => s + x.points, 0);
    ok(r.scores[J] === sumJ, `TOTAL RONDA Juan = ${sumJ} calculado en servidor`);

    console.log('\n8) IMPUGNAR RESPUESTA');
    const ch = await juan.call('challenge:open', { playerId: M, catId: 'animal' });
    ok(ch.ok, 'Juan impugna el animal de María');
    const selfVote = await maria2.call('challenge:vote', { key: `${M}|animal`, valid: true });
    ok(!selfVote.ok, 'María no puede votar su propia respuesta');
    await carlos.call('challenge:vote', { key: `${M}|animal`, valid: false });
    await sleep(150);
    const r2 = juan.state.lastResult;
    ok(r2.challenges[`${M}|animal`].outcome === 'rejected' && r2.answers[M].animal.points === 0, 'votación mayoritaria rechaza → 0 puntos');
    await carlos.call('challenge:open', { playerId: J, catId: 'c_abc123' });
    await maria2.call('challenge:vote', { key: `${J}|c_abc123`, valid: true });
    await sleep(150);
    ok(juan.state.lastResult.challenges[`${J}|c_abc123`].outcome === 'accepted', 'empate 1-1 → se mantiene la respuesta');

    console.log('\n8b) EL ANFITRIÓN ANULA UNA PALABRA MAL ESCRITA');
    const before = juan.state.lastResult.scores[C];
    ok(!(await carlos.call('answer:judge', { playerId: M, catId: 'nombre', valid: false })).ok, 'un jugador que no es anfitrión no puede anular');
    ok((await juan.call('answer:judge', { playerId: C, catId: 'nombre', valid: false })).ok, 'Juan (anfitrión) anula el nombre de Carlos');
    await sleep(150);
    let rr = juan.state.lastResult;
    ok(rr.answers[C].nombre.status === 'rejected' && rr.answers[C].nombre.points === 0, 'la palabra anulada vale 0');
    ok(rr.scores[C] === before - 10, `el total de Carlos baja de ${before} a ${rr.scores[C]}`);
    ok((await juan.call('answer:judge', { playerId: C, catId: 'fruta_verdura', valid: true })).ok, 'el anfitrión también puede validar una respuesta');
    await sleep(150);
    rr = juan.state.lastResult;
    ok(rr.answers[C].fruta_verdura.points === 10, 'respuesta validada por el anfitrión suma +10');

    console.log('\n9) RANKING');
    const rank = [...juan.state.players].sort((x, y) => y.total - x.total);
    rank.forEach((p, i) => console.log(`     ${i + 1}. ${p.name} — ${p.total} pts (última ronda +${p.lastRound})`));
    ok(rank.every((p) => p.total === juan.state.lastResult.scores[p.id]), 'puntaje acumulado actualizado');

    console.log('\n10) SIGUIENTE RONDA');
    ok(!(await carlos.call('round:next')).ok, 'solo el anfitrión avanza');
    await juan.call('round:next');
    st = await juan.waitPhase('CHOOSING_LETTER');
    ok(st.chooserId === C, 'ronda 2: el turno de elegir pasa a Carlos');
    ok(st.usedLetters.includes('M'), 'la M queda marcada como usada');
    const reused = await carlos.call('letter:choose', { letter: 'M' });
    ok(!reused.ok, 'no se puede repetir una letra: ' + reused.error);
    ok((await carlos.call('letter:choose', { letter: 'P' })).ok, 'Carlos elige la P');
    st = await juan.waitPhase('PLAYING');
    ok(st.round === 2 && st.current.letter === 'P', `RONDA 2 DE 2 con la letra ${st.current.letter}`);
    const L2 = st.current.letter;
    carlos.emit('answers:update', { answers: { nombre: wordFor('nombre', L2) } });
    console.log('     (esperando que el temporizador llegue a cero...)');
    await juan.waitPhase('ROUND_FINISHED', 25000);
    ok(true, 'la ronda termina sola cuando el tiempo llega a 0');
    for (const s of [juan, carlos, maria2]) s.emit('answers:final', { answers: {} });
    st = await juan.waitPhase('SHOWING_RESULTS');
    ok(st.lastResult.answers[C].nombre.points === 10, 'respuesta enviada durante la ronda se puntúa');

    console.log('\n11) GANADOR');
    await juan.call('round:next');
    st = await juan.waitPhase('FINAL_RESULTS');
    const final = [...st.players].sort((x, y) => y.total - x.total);
    console.log(`     🏆 GANADOR: ${final[0].name} — ${final[0].total} PUNTOS`);
    ok(final[0].total >= final[1].total, 'pantalla final con ganador');
    ok(st.history.length === 2, 'historial de 2 rondas');

    console.log('\n12) JUGAR NUEVAMENTE');
    ok((await juan.call('game:again')).ok, 'anfitrión reinicia');
    st = await juan.waitPhase('LOBBY');
    ok(st.players.every((p) => p.total === 0), 'puntajes en cero y de vuelta al lobby');

    console.log('\n13) SEGURIDAD');
    const forged = await carlos.call('room:settings', { settings: { rounds: 99 } });
    ok(!forged.ok, 'un jugador no puede cambiar ajustes');
    ok(!(await juan.call('room:settings', { settings: { categories: [{ id: 'nombre', active: true }] } })).ok, 'mínimo 2 categorías');

    console.log('\n14) PERSISTENCIA (reinicio del servidor)');
    await sleep(500);
    server.kill();
    const server2 = await startServer();
    const again = await client('Juan');
    const rjj = await again.call('room:rejoin', { code, playerId: J, token: created.token });
    ok(rjj.ok, 'la sala sobrevive a un reinicio del servidor (base de datos)');
    server2.kill();

    console.log(`\n✅ ${passed} comprobaciones superadas.\n`);
    process.exit(0);
  } catch (e) {
    console.error('\n❌', e.message);
    server.kill();
    process.exit(1);
  }
}

main();
