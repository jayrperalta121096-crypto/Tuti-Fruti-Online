// Persistencia de salas.
// Usa SQLite integrado en Node (node:sqlite, Node >= 22.5). Si no está disponible,
// usa un archivo JSON. Así las partidas sobreviven a un reinicio del servidor.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Silenciar el aviso "ExperimentalWarning: SQLite..."
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning).includes('SQLite')) return;
  return originalEmit.call(process, warning, ...args);
};

let impl;

try {
  if (process.env.STORE === 'json') throw new Error('json forzado');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'tutifruti.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const upsert = db.prepare(
    'INSERT INTO rooms (code, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  );
  const del = db.prepare('DELETE FROM rooms WHERE code = ?');
  const all = db.prepare('SELECT data FROM rooms');
  impl = {
    kind: 'sqlite',
    save: (room) => upsert.run(room.code, JSON.stringify(room), Date.now()),
    remove: (code) => del.run(code),
    loadAll: () => all.all().map((r) => JSON.parse(r.data)),
  };
} catch (err) {
  const file = path.join(DATA_DIR, 'rooms.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  let timer = null;
  const flush = () => {
    timer = null;
    fs.writeFile(file, JSON.stringify(cache), () => {});
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 300);
  };
  impl = {
    kind: 'json',
    save: (room) => {
      cache[room.code] = JSON.parse(JSON.stringify(room));
      schedule();
    },
    remove: (code) => {
      delete cache[code];
      schedule();
    },
    loadAll: () => Object.values(cache),
  };
}

// Guardado con "debounce" por sala para no escribir en cada tecla
const pending = new Map();
function saveRoom(room) {
  if (pending.has(room.code)) return;
  pending.set(
    room.code,
    setTimeout(() => {
      pending.delete(room.code);
      try {
        impl.save(room);
      } catch (e) {
        console.error('Error guardando sala', room.code, e.message);
      }
    }, 250)
  );
}

function removeRoom(code) {
  clearTimeout(pending.get(code));
  pending.delete(code);
  try {
    impl.remove(code);
  } catch (_) {}
}

function loadRooms() {
  try {
    return impl.loadAll();
  } catch (e) {
    console.error('No se pudieron cargar las salas:', e.message);
    return [];
  }
}

module.exports = { saveRoom, removeRoom, loadRooms, storeKind: impl.kind };
