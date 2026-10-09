// Servidor HTTP + WebSockets (Socket.IO) de Tuti Fruti Online
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');
const { registerSocket } = require('./handlers');
const { storeKind } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, rooms: game._rooms.size, store: storeKind }));
app.get('/api/meta', (req, res) =>
  res.json({
    categories: game.DEFAULT_CATEGORIES,
    defaultLetters: game.DEFAULT_LETTERS,
    allLetters: game.ALL_LETTERS,
    avatars: game.AVATARS,
  })
);
// Sin caché: tras actualizar el juego, todos reciben la versión nueva al recargar
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, index: 'index.html' }));
// Cualquier otra ruta (ej. /sala/ABC123) devuelve la app
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 32 * 1024,
  cors: { origin: process.env.CORS_ORIGIN || false },
});

game.init(io);

io.on('connection', registerSocket);

server.listen(PORT, () => {
  console.log(`🍉 Tuti Fruti Online escuchando en http://localhost:${PORT}  (almacenamiento: ${storeKind})`);
});

module.exports = { server };
