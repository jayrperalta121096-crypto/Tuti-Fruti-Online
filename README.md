# 🍉 Tuti Fruti Online

El clásico juego de palabras, ahora online. Salas privadas con código, de 2 a 12 jugadores, en tiempo real desde el celular o la computadora. No hace falta registrarse ni instalar nada.

---

## 1. Ejecutar en tu computadora

**Requisito:** [Node.js](https://nodejs.org) versión 22 o superior (la versión 18 también funciona, pero guarda las salas en un archivo JSON en lugar de SQLite).

```bash
cd tuti-fruti-online
npm install
npm start
```

Abre **http://localhost:3000**.

Para probarlo tú solo, abre una ventana normal y otra de incógnito (o un segundo navegador): en una creas la sala y en la otra te unes con el código.

### Jugar con amigos en la misma red WiFi

1. Busca la IP local de tu PC (Windows: `ipconfig`, la línea "Dirección IPv4", por ejemplo `192.168.1.25`).
2. Desde los celulares conectados al mismo WiFi, abre `http://192.168.1.25:3000`.
3. Si no carga, permite Node.js en el Firewall de Windows.

### Prueba automática

```bash
npm install   # instala también socket.io-client para las pruebas
npm test
```

Simula 3 jugadores reales por WebSocket y comprueba todo el flujo (44 comprobaciones): crear sala, unir jugadores, expulsar, reconexión, iniciar, letra, respuestas privadas, ¡TIEMPO!, puntuación 10/5/0, impugnaciones, ranking, siguiente ronda, fin por tiempo, ganador, jugar nuevamente, seguridad y persistencia tras reiniciar el servidor.

---

## 2. Publicarlo en Internet (para enviar un enlace)

### Opción A: Render (gratis, recomendado)

1. Crea una cuenta en [github.com](https://github.com) y sube esta carpeta a un repositorio nuevo. Puedes arrastrar los archivos desde la web de GitHub: **Add file → Upload files**. No subas `node_modules` ni `data`.
2. Crea una cuenta en [render.com](https://render.com) (puedes entrar con GitHub).
3. **New → Blueprint** y elige tu repositorio. Render lee el archivo `render.yaml` y configura todo solo.
   - Otra forma: **New → Web Service** → tu repositorio → Build command `npm install --omit=dev` → Start command `npm start` → plan **Free**.
4. En 2 o 3 minutos tendrás un enlace como `https://tuti-fruti-online.onrender.com`. Envíalo a tus amigos.

> En el plan gratuito, el servidor "se duerme" tras 15 minutos sin uso. La primera visita después tarda unos 30 a 60 segundos en despertar; luego va normal. Ábrelo tú un minuto antes de jugar.

### Opción B: Railway

[railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → elige el repositorio. Detecta Node.js y usa `npm start` automáticamente. Luego, en **Settings → Networking → Generate Domain**, obtienes el enlace.

### Opción C: Docker (Fly.io, un VPS, etc.)

```bash
docker build -t tuti-fruti .
docker run -p 3000:3000 -v tutidata:/app/data tuti-fruti
```

### Opción D: enlace temporal desde tu PC (sin cuenta)

Con el juego corriendo (`npm start`), en otra terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Te da un enlace `https://….trycloudflare.com` que funciona mientras tu PC esté encendida.

### Variables de entorno (opcionales)

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `DATA_DIR` | Carpeta de la base de datos | `./data` |
| `STORE` | Pon `json` para forzar almacenamiento en archivo JSON | SQLite |

---

## 3. Cómo se juega

1. **Crear partida**: escribe tu nombre, elige avatar, rondas, tiempo, categorías (puedes activarlas, desactivarlas, ordenarlas y crear las tuyas) y las letras permitidas.
2. Comparte el **código** (📋 Copiar o 🔗 Compartir, que abre WhatsApp y otras apps en el celular). También se puede compartir el enlace directo `/?sala=CÓDIGO`.
3. Los amigos entran con **Unirme**, el código y su nombre.
4. El anfitrión (👑) presiona **INICIAR PARTIDA**. También puede expulsar jugadores y editar ajustes antes de empezar.
5. Cuenta regresiva 3-2-1, aparece la **letra** y todos escriben.
6. Quien termina presiona **🔴 ¡TIEMPO!** (con confirmación) y la ronda se cierra para todos. Si nadie lo presiona, termina al llegar a cero.
7. **Resultados**: tabla comparativa con los puntos de cada respuesta, el total de la ronda y la **clasificación**.
8. **Impugnar**: toca cualquier respuesta, elige "Impugnar respuesta" y todos votan ✅ / ❌.
9. Al final aparece el **ganador**, con **Jugar nuevamente** (mismo grupo) o **Volver al inicio**.

### Puntuación (calculada en el servidor)

| Puntos | Caso |
|---|---|
| **10** | Respuesta válida que nadie más puso |
| **5** | Respuesta válida que otro jugador también usó |
| **0** | Vacía, no empieza con la letra, o rechazada por votación |

Las respuestas se comparan sin distinguir mayúsculas ni tildes ("Perú" = "peru").

### Validación automática

1. Que no esté vacía.
2. Que empiece con la letra de la ronda.
3. Que corresponda a la categoría, según diccionarios en español (nombres, apellidos, animales, colores, frutas, verduras, países, ciudades, marcas y profesiones). Acepta plurales y errores de 1 letra.

**Una palabra que el sistema no reconoce NO se elimina.** Se marca ⚠️ "por revisar" y cuenta como válida, salvo que alguien la impugne y la mayoría vote ❌. Si la votación empata, la respuesta se mantiene. Quien escribió la respuesta no puede votar. El anfitrión puede cerrar una votación, y al pasar de ronda se cierran todas las votaciones abiertas.

Para ampliar los diccionarios, edita `server/dictionaries.js`: son listas de palabras separadas por comas.

---

## 4. Arquitectura

```
tuti-fruti-online/
├── server/
│   ├── index.js         Servidor HTTP (Express) + WebSockets (Socket.IO)
│   ├── game.js          Salas, máquina de estados, rondas, puntuación, impugnaciones
│   ├── validation.js    Normalización y validación de respuestas
│   ├── dictionaries.js  Listas de palabras por categoría
│   └── store.js         Base de datos (SQLite integrado en Node; JSON si no hay)
├── public/
│   ├── index.html       Interfaz (una sola página, sin paso de compilación)
│   ├── styles.css       Diseño responsive, modo claro/oscuro, animaciones
│   ├── app.js           Lógica del cliente (pantallas, temporizador, reconexión)
│   └── sounds.js        Sonidos generados con Web Audio (sin archivos)
├── test/flow.test.js    Prueba automática del flujo completo
├── render.yaml · Dockerfile · .nvmrc
└── package.json
```

Se eligió una estructura **simple y estable**: un solo servidor Node, sin compilación y sin servicios externos. Un único `npm start` sirve la página y el tiempo real.

### Estados de la partida

| Especificación | Implementación |
|---|---|
| LOBBY / WAITING_FOR_PLAYERS | `LOBBY` |
| STARTING | `STARTING` (cuenta regresiva; la letra se oculta hasta que empieza) |
| PLAYING | `PLAYING` |
| ROUND_FINISHED | `ROUND_FINISHED` (se bloquean las respuestas y se recogen las finales) |
| SHOWING_RESULTS | `SHOWING_RESULTS` (respuestas, impugnaciones y clasificación) |
| NEXT_ROUND | acción del anfitrión: vuelve a `STARTING` con la ronda siguiente |
| FINAL_RESULTS | `FINAL_RESULTS` (ganador) |
| GAME_FINISHED | "Volver al inicio" (salir) o "Jugar nuevamente" (vuelve a `LOBBY`) |

### Seguridad

- El navegador **solo envía texto**. Las letras, los tiempos, la validación, los puntos y los totales se calculan en el servidor.
- Las respuestas de los demás **no se envían** a nadie hasta que la ronda termina y se puntúa.
- Tras ¡TIEMPO! solo se acepta una entrega final por jugador. Se rechazan los cambios posteriores.
- Cada jugador tiene un token secreto: nadie puede hacerse pasar por otro, y el expulsado no puede volver con su sesión.
- Solo el anfitrión puede iniciar, avanzar, expulsar o cambiar ajustes. Si se desconecta, el rol pasa a otro jugador.
- Se validan el código de sala, el estado, la ronda, el tiempo (con margen de 1,5 s por latencia), la longitud de los textos y un límite de mensajes por segundo.

### Conexión y recarga de página

- 🟢 Conectado · 🟡 Reconectando… · 🔴 Desconectado, para ti y para cada jugador.
- La reconexión es automática. Si alguien recarga la página o se le apaga la pantalla, vuelve a su sala, en la misma pantalla y con lo que llevaba escrito (también se guarda un borrador en el navegador).
- Las salas se guardan en la base de datos: si el servidor se reinicia, la partida continúa. Las salas inactivas se borran solas.

### Preferencias guardadas en el navegador

Modo claro/oscuro, sonido ON/OFF, nombre, avatar y los últimos ajustes de partida.
