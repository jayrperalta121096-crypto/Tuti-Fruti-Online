/* ============ Tuti Fruti Online — cliente ============ */
(() => {
  'use strict';

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (_) {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (_) {}
    },
  };
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const normalize = (t) =>
    String(t || '').toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'ñ').replace(/[^a-zñ0-9]/g, '');

  // ---------- Estado del cliente ----------
  let META = null;
  let S = null; // último estado recibido del servidor
  let prevPhase = null;
  let prevRound = 0;
  let session = LS.get('tf_session'); // { code, playerId, token }
  let view = session ? 'loading' : 'home';
  let clockOffset = 0;
  let resultsTab = 'answers';
  let joinPrefill = '';
  let lastTickSecond = null;
  let lastCountdown = null;
  let sendTimer = null;
  let offlineTimer = null;
  let confettiDone = false;

  const now = () => Date.now() + clockOffset;
  const me = () => (S ? S.players.find((p) => p.id === S.you) : null);
  const isHost = () => S && S.hostId === S.you;
  const playerById = (id) => (S ? S.players.find((p) => p.id === id) : null);

  // Código desde la URL (?sala=ABC123 o /sala/ABC123)
  const urlCode = (() => {
    const q = new URLSearchParams(location.search).get('sala');
    const m = location.pathname.match(/\/sala\/([A-Za-z0-9]{6})/);
    return (q || (m && m[1]) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  })();
  if (urlCode) {
    joinPrefill = urlCode;
    if (!session || session.code !== urlCode) view = 'join';
  }

  // ---------- Socket ----------
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 4000, timeout: 8000 });
  const call = (event, payload = {}) =>
    new Promise((resolve) => {
      if (!socket.connected) return resolve({ ok: false, error: 'Sin conexión. Reintentando…' });
      let done = false;
      const t = setTimeout(() => {
        if (!done) resolve({ ok: false, error: 'El servidor no respondió. Intenta de nuevo.' });
      }, 8000);
      socket.emit(event, payload, (res) => {
        done = true;
        clearTimeout(t);
        resolve(res || { ok: false, error: 'Error' });
      });
    });

  socket.on('connect', async () => {
    setConn('connected');
    if (session) {
      const res = await call('room:rejoin', session);
      if (!res.ok) {
        const code = session.code;
        clearSession();
        toast(res.error, true);
        joinPrefill = code;
        view = 'join';
        render();
      }
    }
  });
  socket.on('disconnect', () => setConn('reconnecting'));
  socket.io.on('reconnect_attempt', () => setConn('reconnecting'));
  window.addEventListener('offline', () => setConn('reconnecting'));
  window.addEventListener('online', () => !socket.connected && socket.connect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
  });

  socket.on('state', (state) => {
    clockOffset = state.serverNow - Date.now();
    const phaseChanged = !S || state.phase !== S.phase || state.round !== S.round;
    S = state;
    if (view !== 'room') {
      view = 'room';
      history.replaceState(null, '', `/?sala=${state.code}`);
    }
    if (phaseChanged) onPhaseChange(prevPhase, state.phase);
    prevPhase = state.phase;
    prevRound = state.round;
    render();
  });

  socket.on('kicked', ({ message }) => {
    clearSession();
    S = null;
    view = 'home';
    history.replaceState(null, '', '/');
    render();
    openModal(`<h2>🚪 Fuera de la sala</h2><p>${esc(message)}</p><div class="actions"><button class="btn primary" data-close>Entendido</button></div>`);
  });

  function setConn(status) {
    const b = $('#connBadge');
    clearTimeout(offlineTimer);
    b.classList.remove('reconnecting', 'offline');
    if (status === 'connected') {
      b.querySelector('b').textContent = 'Conectado';
    } else {
      b.classList.add('reconnecting');
      b.querySelector('b').textContent = 'Reconectando…';
      offlineTimer = setTimeout(() => {
        b.classList.remove('reconnecting');
        b.classList.add('offline');
        b.querySelector('b').textContent = 'Desconectado';
      }, 20000);
    }
  }

  function saveSession(s) {
    session = s;
    LS.set('tf_session', s);
  }
  function clearSession() {
    session = null;
    LS.del('tf_session');
    S = null;
    prevPhase = null;
  }

  // ---------- Topbar ----------
  function applyThemeIcon() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    $('#themeBtn').textContent = dark ? '☀️' : '🌙';
    $('#themeBtn').title = dark ? 'Modo claro' : 'Modo oscuro';
    document.querySelector('meta[name=theme-color]').content = dark ? '#17122a' : '#ff5a5f';
    return dark;
  }
  $('#themeBtn').onclick = () => {
    const dark = applyThemeIcon();
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('tf_theme', next);
    } catch (_) {}
    applyThemeIcon();
  };
  const soundIcon = () => ($('#soundBtn').textContent = Sounds.enabled ? '🔊' : '🔇');
  $('#soundBtn').onclick = () => {
    Sounds.toggle();
    soundIcon();
    toast(Sounds.enabled ? 'Sonido activado' : 'Sonido desactivado');
  };
  $('#brandBtn').onclick = () => {
    if (view === 'room') return confirmLeave();
    view = 'home';
    render();
  };
  applyThemeIcon();
  soundIcon();

  function updateTopbar() {
    const inRoom = view === 'room' && S;
    $('#roomChip').classList.toggle('hidden', !inRoom);
    $('#connBadge').classList.toggle('hidden', !inRoom && view !== 'loading');
    if (inRoom) $('#roomChip').textContent = S.code;
  }

  // ---------- Modal y toasts ----------
  function openModal(html, { wide = false, onMount, dismissable = true } = {}) {
    const m = $('#modal');
    const body = $('#modalBody');
    body.className = `modal card pop${wide ? ' wide' : ''}`;
    body.innerHTML = html;
    m.classList.remove('hidden');
    m.onclick = (e) => {
      if ((e.target === m && dismissable) || e.target.closest('[data-close]')) closeModal();
    };
    if (onMount) onMount(body);
  }
  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modalBody').innerHTML = '';
  }
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
  function confirmDialog(title, text, okLabel = 'Sí', cls = 'primary') {
    return new Promise((resolve) => {
      openModal(
        `<h2>${title}</h2><p>${text}</p><div class="actions"><button class="btn ghost" data-r="0">Cancelar</button><button class="btn ${cls}" data-r="1">${okLabel}</button></div>`,
        {
          onMount: (b) =>
            $$('[data-r]', b).forEach((btn) =>
              (btn.onclick = () => {
                closeModal();
                resolve(btn.dataset.r === '1');
              })
            ),
        }
      );
      $('#modal').onclick = (e) => {
        if (e.target.id === 'modal') {
          closeModal();
          resolve(false);
        }
      };
    });
  }
  function toast(msg, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ---------- Cambios de fase (sonidos y efectos) ----------
  function onPhaseChange(from, to) {
    lastTickSecond = null;
    lastCountdown = null;
    if (to !== 'FINAL_RESULTS') confettiDone = false;
    if (to === 'PLAYING' && from !== 'PLAYING') Sounds.play('start');
    if (to === 'ROUND_FINISHED') {
      if (from === 'PLAYING') Sounds.play('stop');
      // Entregar respuestas finales al servidor
      socket.emit('answers:final', { answers: collectAnswers() });
    }
    if (to === 'SHOWING_RESULTS') {
      resultsTab = 'answers';
      Sounds.play('results');
      clearDrafts();
    }
    if (to === 'FINAL_RESULTS') Sounds.play('winner');
    if (to !== 'PLAYING' && to !== 'ROUND_FINISHED') closeModalIfStop();
  }
  function closeModalIfStop() {
    if ($('#modalBody [data-stopmodal]')) closeModal();
  }

  // ---------- Respuestas (borrador local + sincronización) ----------
  const draftKey = () => (S ? `tf_draft_${S.code}_${S.round}` : 'tf_draft');
  function collectAnswers() {
    const inputs = $$('.ans-input');
    if (inputs.length) {
      const out = {};
      inputs.forEach((i) => (out[i.dataset.cat] = i.value));
      return out;
    }
    return { ...(S && S.current ? S.current.myAnswers : {}), ...LS.get(draftKey(), {}) };
  }
  function clearDrafts() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('tf_draft_'))
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
  }
  function queueSend() {
    LS.set(draftKey(), collectAnswers());
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => socket.emit('answers:update', { answers: collectAnswers() }), 350);
  }

  // ---------- Render principal ----------
  function render() {
    updateTopbar();
    if (view === 'home') return renderHome();
    if (view === 'create') return renderCreate();
    if (view === 'join') return renderJoin();
    if (view === 'loading' || !S) return renderLoading();
    switch (S.phase) {
      case 'LOBBY':
        return renderLobby();
      case 'STARTING':
        return renderStarting();
      case 'PLAYING':
      case 'ROUND_FINISHED':
        return renderGame();
      case 'SHOWING_RESULTS':
        return renderResults();
      case 'FINAL_RESULTS':
        return renderFinal();
    }
  }

  function setScreen(id, html) {
    app.dataset.screen = id;
    app.innerHTML = `<section class="screen">${html}</section>`;
    window.scrollTo({ top: 0 });
  }

  function renderLoading() {
    if (app.dataset.screen === 'loading') return;
    setScreen('loading', `<div class="card center narrow" style="margin-top:40px"><div style="font-size:3rem">🍇</div><h2>Entrando a la sala<span class="dots-anim"><span>.</span><span>.</span><span>.</span></span></h2></div>`);
  }

  // ---------- HOME ----------
  function renderHome() {
    setScreen(
      'home',
      `<div class="hero">
        <div class="hero-fruits"><span>🍎</span><span>🍌</span><span>🍉</span><span>🍇</span><span>🍓</span></div>
        <h1 class="logo"><span class="t1">TUTI</span> <span class="t2">FRUTI</span></h1>
        <p class="tagline">El clásico juego de palabras, ahora online.</p>
        <div class="home-actions">
          <button class="btn primary block" id="goCreate">🎮 CREAR PARTIDA</button>
          <button class="btn purple block" id="goJoin">🚪 UNIRME A UNA PARTIDA</button>
          <button class="btn block" id="goHow">📖 ¿CÓMO JUGAR?</button>
        </div>
      </div>
      <div class="how-mini">
        <div class="card"><span class="n">🔤</span>Todos reciben la misma letra</div>
        <div class="card"><span class="n">✍️</span>Completa cada categoría con esa letra</div>
        <div class="card"><span class="n">🔴</span>El primero en terminar grita ¡TIEMPO!</div>
      </div>`
    );
    $('#goCreate').onclick = () => {
      view = 'create';
      render();
    };
    $('#goJoin').onclick = () => {
      view = 'join';
      render();
    };
    $('#goHow').onclick = showHowTo;
  }

  function showHowTo() {
    openModal(
      `<div class="howto"><h2>📖 ¿Cómo jugar?</h2>
      <ol>
        <li>Crea una partida y comparte el código con tus amigos.</li>
        <li>En cada ronda aparece una letra al azar.</li>
        <li>Escribe una palabra que empiece con esa letra en cada categoría.</li>
        <li>Cuando termines, presiona <b>¡TIEMPO!</b> y la ronda acaba para todos. Si nadie lo presiona, termina al llegar a cero.</li>
        <li>Se comparan las respuestas y se reparten los puntos:</li>
      </ol>
      <p><span class="pts p10">+10</span> respuesta válida que nadie más puso</p>
      <p><span class="pts p5">+5</span> respuesta válida repetida</p>
      <p><span class="pts p0">0</span> vacía, con otra letra o rechazada</p>
      <p>⚠️ Si el sistema no reconoce una palabra, <b>no se elimina</b>: cualquiera puede <b>impugnarla</b> y todos votan si vale.</p>
      <div class="actions"><button class="btn primary" data-close>¡A jugar!</button></div></div>`,
      { wide: true }
    );
  }

  // ---------- Formulario de ajustes (crear sala / editar en lobby) ----------
  function defaultForm() {
    const last = LS.get('tf_last_settings');
    const cats = META.categories.map((c) => ({ id: c.id, name: c.name, active: c.active, custom: false }));
    const form = {
      name: LS.get('tf_name', ''),
      avatar: LS.get('tf_avatar') || META.avatars[Math.floor(Math.random() * META.avatars.length)],
      rounds: 5,
      roundTime: 60,
      stopRequiresAll: true,
      categories: cats,
      letters: META.defaultLetters.slice(),
    };
    if (last) Object.assign(form, { rounds: last.rounds, roundTime: last.roundTime, stopRequiresAll: last.stopRequiresAll, categories: last.categories, letters: last.letters });
    return form;
  }

  function settingsHTML(f) {
    const activeCount = f.categories.filter((c) => c.active).length;
    return `
      <div class="grid2">
        <div><div class="section-title">🔁 Número de rondas</div>
          <div class="stepper"><button type="button" data-act="rounds" data-d="-1">−</button><output>${f.rounds}</output><button type="button" data-act="rounds" data-d="1">+</button></div></div>
        <div><div class="section-title">⏱️ Tiempo por ronda</div>
          <div class="stepper"><button type="button" data-act="time" data-d="-15">−</button><output>${f.roundTime} s</output><button type="button" data-act="time" data-d="15">+</button></div></div>
      </div>
      <div>
        <div class="section-title">🗂️ Categorías <span class="chip">${activeCount} activas</span></div>
        <div class="cat-list">
          ${f.categories
            .map(
              (c, i) => `<div class="cat-item ${c.active ? '' : 'off'}">
              <label class="switch"><input type="checkbox" data-act="cat-toggle" data-i="${i}" ${c.active ? 'checked' : ''} aria-label="${esc(c.name)}"><span></span></label>
              <span class="name">${esc(c.name)}</span>${c.custom ? '<span class="tag">propia</span>' : ''}
              <button type="button" class="mini-btn" data-act="cat-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
              <button type="button" class="mini-btn" data-act="cat-down" data-i="${i}" ${i === f.categories.length - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button>
              ${c.custom ? `<button type="button" class="mini-btn" data-act="cat-del" data-i="${i}" aria-label="Eliminar">✕</button>` : ''}
            </div>`
            )
            .join('')}
        </div>
        <div class="row" style="margin-top:10px;flex-wrap:nowrap">
          <input class="input" id="newCat" maxlength="20" placeholder="Nueva categoría (ej. Superhéroe)" autocomplete="off">
          <button type="button" class="btn small green" data-act="cat-add">＋</button>
        </div>
      </div>
      <details class="adv">
        <summary>🔤 Letras permitidas (${f.letters.length})</summary>
        <div class="row" style="margin:8px 0">
          <button type="button" class="btn tiny" data-act="letters-easy">Recomendadas</button>
          <button type="button" class="btn tiny" data-act="letters-all">Todas</button>
        </div>
        <div class="letters">
          ${META.allLetters.map((l) => `<button type="button" class="letter-opt ${f.letters.includes(l) ? 'on' : ''}" data-act="letter" data-l="${l}">${l}</button>`).join('')}
        </div>
      </details>
      <div class="toggle-row">
        <span>🔴 Exigir completar todo para decir ¡TIEMPO!</span>
        <label class="switch"><input type="checkbox" data-act="stopAll" ${f.stopRequiresAll ? 'checked' : ''}><span></span></label>
      </div>`;
  }

  function bindSettings(container, f, rerender) {
    container.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.tagName === 'INPUT') return;
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === 'rounds') f.rounds = Math.min(15, Math.max(1, f.rounds + Number(b.dataset.d)));
      else if (act === 'time') f.roundTime = Math.min(300, Math.max(30, f.roundTime + Number(b.dataset.d)));
      else if (act === 'cat-up' && i > 0) [f.categories[i - 1], f.categories[i]] = [f.categories[i], f.categories[i - 1]];
      else if (act === 'cat-down' && i < f.categories.length - 1) [f.categories[i + 1], f.categories[i]] = [f.categories[i], f.categories[i + 1]];
      else if (act === 'cat-del') f.categories.splice(i, 1);
      else if (act === 'cat-add') {
        const inp = $('#newCat', container);
        const name = inp.value.trim().replace(/\s+/g, ' ').slice(0, 20);
        if (!name) return inp.focus();
        if (f.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast('Esa categoría ya existe', true);
        const id = 'c_' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => x.toString(16).padStart(2, '0')).join('');
        f.categories.push({ id, name: name.charAt(0).toUpperCase() + name.slice(1), active: true, custom: true });
      } else if (act === 'letter') {
        const l = b.dataset.l;
        f.letters = f.letters.includes(l) ? f.letters.filter((x) => x !== l) : [...f.letters, l];
      } else if (act === 'letters-easy') f.letters = META.defaultLetters.slice();
      else if (act === 'letters-all') f.letters = META.allLetters.slice();
      else return;
      const openDetails = $('details.adv', container)?.open;
      rerender();
      if (openDetails) $('details.adv', container).open = true;
    };
    container.onchange = (e) => {
      const t = e.target;
      if (t.dataset.act === 'cat-toggle') {
        f.categories[Number(t.dataset.i)].active = t.checked;
        rerender();
      } else if (t.dataset.act === 'stopAll') f.stopRequiresAll = t.checked;
    };
    const nc = $('#newCat', container);
    if (nc) nc.onkeydown = (e) => e.key === 'Enter' && (e.preventDefault(), $('[data-act=cat-add]', container).click());
  }

  function validateForm(f) {
    const active = f.categories.filter((c) => c.active).length;
    if (active < 2) return 'Activa al menos 2 categorías.';
    if (active > 15) return 'Máximo 15 categorías activas.';
    if (f.letters.length < 3) return 'Selecciona al menos 3 letras.';
    return null;
  }

  function avatarsHTML(selected) {
    return `<div class="avatars" role="radiogroup" aria-label="Avatar">${META.avatars
      .map((a) => `<button type="button" class="avatar-opt ${a === selected ? 'sel' : ''}" data-av="${a}" aria-label="Avatar ${a}">${a}</button>`)
      .join('')}</div>`;
  }
  function bindAvatars(container, f) {
    $$('.avatar-opt', container).forEach(
      (b) =>
        (b.onclick = () => {
          f.avatar = b.dataset.av;
          $$('.avatar-opt', container).forEach((x) => x.classList.toggle('sel', x === b));
          Sounds.play('pop');
        })
    );
  }

  // ---------- CREAR PARTIDA ----------
  let createForm = null;
  function renderCreate() {
    if (!META) return renderLoading();
    if (!createForm) createForm = defaultForm();
    const f = createForm;
    setScreen(
      'create',
      `<div class="narrow stack">
        <h1 class="center" style="font-size:2rem">🎮 Crear nueva partida</h1>
        <form class="card stack" id="createForm" autocomplete="off">
          <label class="field">Tu nombre
            <input class="input" id="cName" maxlength="16" required placeholder="Ej. Juan" value="${esc(f.name)}" autocapitalize="words" enterkeyhint="done">
          </label>
          <div><div class="section-title">Tu avatar</div>${avatarsHTML(f.avatar)}</div>
          <div class="stack" id="settingsBox">${settingsHTML(f)}</div>
          <button class="btn primary block" type="submit" id="createBtn">CREAR SALA</button>
          <button class="btn ghost block" type="button" id="backBtn">Volver</button>
        </form>
      </div>`
    );
    const form = $('#createForm');
    bindAvatars(form, f);
    const box = $('#settingsBox');
    const rerender = () => {
      box.innerHTML = settingsHTML(f);
      bindSettings(box, f, rerender);
    };
    bindSettings(box, f, rerender);
    $('#cName').oninput = (e) => (f.name = e.target.value);
    $('#backBtn').onclick = () => {
      view = 'home';
      render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      f.name = $('#cName').value.trim();
      if (!f.name) return $('#cName').focus(), toast('Escribe tu nombre', true);
      const err = validateForm(f);
      if (err) return toast(err, true);
      const btn = $('#createBtn');
      btn.disabled = true;
      const settings = { rounds: f.rounds, roundTime: f.roundTime, stopRequiresAll: f.stopRequiresAll, categories: f.categories, letters: f.letters };
      const res = await call('room:create', { name: f.name, avatar: f.avatar, settings });
      btn.disabled = false;
      if (!res.ok) return toast(res.error, true);
      LS.set('tf_name', f.name);
      LS.set('tf_avatar', f.avatar);
      LS.set('tf_last_settings', settings);
      saveSession({ code: res.code, playerId: res.playerId, token: res.token });
      view = 'room';
      history.replaceState(null, '', `/?sala=${res.code}`);
      render();
    };
  }

  // ---------- UNIRSE ----------
  function renderJoin() {
    if (!META) return renderLoading();
    const f = { avatar: LS.get('tf_avatar') || META.avatars[Math.floor(Math.random() * META.avatars.length)] };
    setScreen(
      'join',
      `<div class="narrow stack">
        <h1 class="center" style="font-size:2rem">🚪 Unirme a una partida</h1>
        <form class="card stack" id="joinForm" autocomplete="off">
          <label class="field">Código de la sala
            <input class="input code" id="jCode" maxlength="6" required placeholder="ABC123" value="${esc(joinPrefill)}" autocapitalize="characters" autocomplete="off" spellcheck="false" inputmode="text">
          </label>
          <label class="field">Tu nombre
            <input class="input" id="jName" maxlength="16" required placeholder="Ej. María" value="${esc(LS.get('tf_name', ''))}" autocapitalize="words" enterkeyhint="go">
          </label>
          <div><div class="section-title">Tu avatar</div>${avatarsHTML(f.avatar)}</div>
          <button class="btn purple block" type="submit" id="joinBtn">ENTRAR</button>
          <button class="btn ghost block" type="button" id="backBtn">Volver</button>
        </form>
      </div>`
    );
    const form = $('#joinForm');
    bindAvatars(form, f);
    const codeInput = $('#jCode');
    codeInput.oninput = () => (codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
    if (!isTouch) (joinPrefill ? $('#jName') : codeInput).focus();
    $('#backBtn').onclick = () => {
      joinPrefill = '';
      history.replaceState(null, '', '/');
      view = 'home';
      render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const code = codeInput.value.trim();
      const name = $('#jName').value.trim();
      if (code.length !== 6) return toast('El código tiene 6 caracteres', true);
      if (!name) return toast('Escribe tu nombre', true);
      const btn = $('#joinBtn');
      btn.disabled = true;
      const res = await call('room:join', { code, name, avatar: f.avatar });
      btn.disabled = false;
      if (!res.ok) return toast(res.error, true);
      LS.set('tf_name', name);
      LS.set('tf_avatar', f.avatar);
      saveSession({ code: res.code, playerId: res.playerId, token: res.token });
      view = 'room';
      render();
    };
  }

  // ---------- LOBBY ----------
  function playerCard(p, { kick = false } = {}) {
    const statusLbl = { connected: 'Conectado', reconnecting: 'Reconectando…', disconnected: 'Desconectado' }[p.status];
    return `<div class="player ${p.id === S.you ? 'me' : ''}">
      <div class="av">${esc(p.avatar)}</div>
      <div class="nm">${esc(p.name)}${p.isHost ? ' 👑' : ''}<small>${p.id === S.you ? 'Tú · ' : ''}${statusLbl}</small></div>
      <span class="dot ${p.status}" title="${statusLbl}"></span>
      ${kick && p.id !== S.you ? `<button class="mini-btn" data-kick="${p.id}" title="Expulsar" aria-label="Expulsar a ${esc(p.name)}">✕</button>` : ''}
    </div>`;
  }

  function renderLobby() {
    const host = isHost();
    const connected = S.players.filter((p) => p.status !== 'disconnected').length;
    const st = S.settings;
    const activeCats = st.categories.filter((c) => c.active);
    setScreen(
      'lobby',
      `<div class="stack">
        <div class="code-box">
          <div class="lbl">CÓDIGO DE PARTIDA</div>
          <div class="code">${esc(S.code)}</div>
          <div class="row" style="justify-content:center">
            <button class="btn small" id="copyBtn">📋 COPIAR CÓDIGO</button>
            <button class="btn small" id="shareBtn">🔗 COMPARTIR PARTIDA</button>
          </div>
        </div>
        <div class="card">
          <div class="section-title"><span>👥 Jugadores</span><span class="chip">${connected}/${S.maxPlayers}</span></div>
          <div class="players">${S.players.map((p) => playerCard(p, { kick: host })).join('')}</div>
        </div>
        <div class="card">
          <div class="section-title"><span>⚙️ Partida</span>${host ? '<button class="btn tiny" id="editSettings">Editar</button>' : ''}</div>
          <div class="chips">
            <span class="chip">🔁 ${st.rounds} rondas</span>
            <span class="chip">⏱️ ${st.roundTime} s</span>
            <span class="chip">🔤 ${st.letters.length} letras</span>
            ${st.stopRequiresAll ? '<span class="chip">🔴 ¡TIEMPO! con todo completo</span>' : ''}
          </div>
          <div class="chips" style="margin-top:10px">${activeCats.map((c) => `<span class="chip" style="background:color-mix(in srgb,var(--orange) 18%,var(--card2))">${esc(c.name)}</span>`).join('')}</div>
        </div>
        ${
          host
            ? `<button class="btn green block" id="startBtn" ${connected < S.minPlayers ? 'disabled' : ''}>▶ INICIAR PARTIDA</button>
               ${connected < S.minPlayers ? `<div class="waiting">Esperando jugadores<span class="dots-anim"><span>.</span><span>.</span><span>.</span></span></div>` : ''}`
            : `<div class="waiting card">⏳ Esperando a que el anfitrión inicie la partida<span class="dots-anim"><span>.</span><span>.</span><span>.</span></span></div>`
        }
        <button class="btn ghost block" id="leaveBtn">Salir de la sala</button>
      </div>`
    );
    $('#copyBtn').onclick = () => copyText(S.code, 'Código copiado');
    $('#shareBtn').onclick = shareRoom;
    $('#leaveBtn').onclick = confirmLeave;
    if (host) {
      $('#startBtn').onclick = async () => {
        $('#startBtn').disabled = true;
        const res = await call('game:start');
        if (!res.ok) {
          toast(res.error, true);
          $('#startBtn').disabled = false;
        }
      };
      $('#editSettings').onclick = openSettingsModal;
      $$('[data-kick]').forEach(
        (b) =>
          (b.onclick = async () => {
            const p = playerById(b.dataset.kick);
            if (!p) return;
            if (!(await confirmDialog('Expulsar jugador', `¿Seguro que quieres expulsar a <b>${esc(p.name)}</b>?`, 'Expulsar', 'danger'))) return;
            const res = await call('room:kick', { playerId: p.id });
            if (!res.ok) toast(res.error, true);
          })
      );
    }
  }

  function openSettingsModal() {
    const f = JSON.parse(JSON.stringify({ ...S.settings }));
    f.categories = f.categories.map((c) => ({ id: c.id, name: c.name, active: c.active, custom: c.custom }));
    openModal(
      `<h2>⚙️ Ajustes de la partida</h2><div class="stack" id="setBox"></div>
       <div class="actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="saveSet">Guardar</button></div>`,
      {
        wide: true,
        onMount: (b) => {
          const box = $('#setBox', b);
          const rerender = () => {
            box.innerHTML = settingsHTML(f);
            bindSettings(box, f, rerender);
          };
          rerender();
          $('#saveSet', b).onclick = async () => {
            const err = validateForm(f);
            if (err) return toast(err, true);
            const settings = { rounds: f.rounds, roundTime: f.roundTime, stopRequiresAll: f.stopRequiresAll, categories: f.categories, letters: f.letters };
            const res = await call('room:settings', { settings });
            if (!res.ok) return toast(res.error, true);
            LS.set('tf_last_settings', settings);
            closeModal();
            toast('Ajustes guardados');
          };
        },
      }
    );
  }

  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      ta.remove();
    }
    toast(msg);
  }
  async function shareRoom() {
    const url = `${location.origin}/?sala=${S.code}`;
    const text = `¡Juguemos Tuti Fruti! 🍉 Entra con el código ${S.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Tuti Fruti Online', text, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    copyText(`${text}: ${url}`, 'Enlace copiado');
  }

  async function confirmLeave() {
    if (!(await confirmDialog('Salir de la sala', S && S.phase !== 'LOBBY' ? 'La partida está en curso. Si sales conservarás tus puntos, pero no podrás seguir jugando desde aquí.' : '¿Seguro que quieres salir?', 'Salir', 'danger'))) return;
    leaveRoom();
  }
  async function leaveRoom() {
    if (session) await call('room:leave');
    clearSession();
    joinPrefill = '';
    view = 'home';
    history.replaceState(null, '', '/');
    render();
  }

  // ---------- CUENTA REGRESIVA ----------
  function renderStarting() {
    if (app.dataset.screen !== 'starting-' + S.round) {
      setScreen(
        'starting-' + S.round,
        `<div class="center" style="padding-top:40px"><div class="round-lbl">RONDA ${S.round} DE ${S.totalRounds}</div></div>
         <div class="overlay"><div class="center"><div class="round-lbl" style="margin-bottom:10px">RONDA ${S.round} DE ${S.totalRounds}</div><div class="countdown" id="cd">3</div></div></div>`
      );
    }
  }

  // ---------- JUEGO ----------
  function renderGame() {
    const cur = S.current;
    const id = 'game-' + S.round;
    const locked = S.phase !== 'PLAYING';
    if (app.dataset.screen !== id) {
      const draft = { ...(cur.myAnswers || {}), ...LS.get(draftKey(), {}) };
      setScreen(
        id,
        `<div class="game-head">
          <div><div class="round-lbl">RONDA</div><div class="round-lbl" style="color:var(--ink);font-size:1.3rem">${S.round} DE ${S.totalRounds}</div></div>
          <div><div class="letter-cap">LETRA</div><div class="letter-big" id="bigLetter">${esc(cur.letter)}</div></div>
          <div class="timer" id="timer"><div class="round-lbl">TIEMPO</div><div class="t" id="timerT">--:--</div></div>
        </div>
        <div class="progress"><i id="bar"></i></div>
        <form class="answers" id="answers" autocomplete="off" onsubmit="return false">
          ${cur.categories
            .map(
              (c, i) => `<div class="ans-row" style="animation-delay:${i * 40}ms">
              <label for="a_${c.id}">${esc(c.name)}</label>
              <input class="input ans-input" id="a_${c.id}" data-cat="${c.id}" maxlength="40" value="${esc(draft[c.id] || '')}"
                placeholder="${esc(cur.letter)}…" autocomplete="off" autocorrect="off" spellcheck="false" autocapitalize="words"
                enterkeyhint="${i === cur.categories.length - 1 ? 'done' : 'next'}">
            </div>`
            )
            .join('')}
        </form>
        <div class="stop-bar"><button class="btn" id="stopBtn">🔴 ¡TIEMPO!</button></div>
        <div id="finishOverlay"></div>`
      );
      const inputs = $$('.ans-input');
      inputs.forEach((inp, i) => {
        markInput(inp);
        inp.oninput = () => {
          markInput(inp);
          queueSend();
        };
        inp.onkeydown = (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (inputs[i + 1]) inputs[i + 1].focus();
            else inp.blur();
          }
        };
      });
      $('#stopBtn').onclick = pressStop;
      if (!isTouch && inputs[0] && !locked) inputs[0].focus();
    }
    // Partes dinámicas
    $$('.ans-input').forEach((i) => (i.disabled = locked));
    $('#stopBtn').disabled = locked;
    const ov = $('#finishOverlay');
    if (S.phase === 'ROUND_FINISHED') {
      if (!ov.innerHTML) {
        const who = cur.stoppedBy ? playerById(cur.stoppedBy) : null;
        ov.innerHTML = `<div class="overlay"><div class="center"><div class="big">¡TIEMPO!</div>
          <p style="font-weight:800;font-size:1.1rem">${who ? `${esc(who.avatar)} ${esc(who.name)} dijo ¡TIEMPO!` : '⏰ Se acabó el tiempo'}</p>
          <p class="muted" style="font-weight:800">Calculando puntos<span class="dots-anim"><span>.</span><span>.</span><span>.</span></span></p></div></div>`;
        closeModalIfStop();
        document.activeElement && document.activeElement.blur();
      }
    } else ov.innerHTML = '';
    tick();
  }

  function markInput(inp) {
    const v = normalize(inp.value);
    const l = normalize(S.current.letter || '');
    inp.classList.toggle('bad', v.length > 0 && v[0] !== l);
    inp.classList.toggle('good', v.length > 1 && v[0] === l);
  }

  async function pressStop() {
    if (S.phase !== 'PLAYING') return;
    const answers = collectAnswers();
    const missing = S.current.categories.filter((c) => !String(answers[c.id] || '').trim());
    if (S.settings.stopRequiresAll && missing.length) {
      toast(`Te faltan ${missing.length} categoría(s): ${missing.map((c) => c.name).join(', ')}`, true);
      const first = $(`#a_${missing[0].id}`);
      first && first.focus();
      return;
    }
    openModal(
      `<div data-stopmodal><h2>🔴 ¿Decir ¡TIEMPO!?</h2><p>La ronda terminará <b>para todos</b> y se bloquearán las respuestas.${missing.length ? `<br><br>⚠️ Tienes ${missing.length} categoría(s) vacía(s).` : ''}</p>
      <div class="actions"><button class="btn ghost" data-close>Seguir escribiendo</button><button class="btn danger" id="confirmStop">¡TIEMPO!</button></div></div>`,
      {
        onMount: (b) =>
          ($('#confirmStop', b).onclick = async () => {
            closeModal();
            const res = await call('round:stop', { answers: collectAnswers() });
            if (!res.ok) toast(res.error, true);
          }),
      }
    );
  }

  // ---------- Reloj (cuenta regresiva y temporizador) ----------
  function tick() {
    if (!S || view !== 'room') return;
    const cur = S.current;
    if (S.phase === 'STARTING' && cur) {
      const left = Math.ceil((cur.startsAt - now()) / 1000);
      const cd = $('#cd');
      const label = left > 0 ? String(Math.min(3, left)) : '¡YA!';
      if (cd && cd.textContent !== label) {
        cd.textContent = label;
        cd.style.animation = 'none';
        void cd.offsetWidth;
        cd.style.animation = '';
      }
      if (left !== lastCountdown && left > 0 && left <= 3) Sounds.play('countdown');
      lastCountdown = left;
    }
    if ((S.phase === 'PLAYING' || S.phase === 'ROUND_FINISHED') && cur && $('#timerT')) {
      const total = cur.endsAt - cur.startsAt;
      const msLeft = S.phase === 'PLAYING' ? Math.max(0, cur.endsAt - now()) : 0;
      const sec = Math.ceil(msLeft / 1000);
      $('#timerT').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      $('#timer').classList.toggle('warn', sec <= 10 && S.phase === 'PLAYING');
      $('#bar').style.width = `${(msLeft / total) * 100}%`;
      if (S.phase === 'PLAYING' && sec <= 10 && sec > 0 && sec !== lastTickSecond) Sounds.play('tick');
      lastTickSecond = sec;
    }
  }
  setInterval(tick, 200);

  // ---------- RESULTADOS ----------
  const STATUS_INFO = {
    ok: { flag: '', txt: 'Respuesta reconocida ✅' },
    free: { flag: '', txt: 'Categoría sin diccionario: se acepta salvo que la impugnen.' },
    review: { flag: '⚠️', txt: 'El sistema no la reconoce. Cuenta como válida mientras nadie la impugne.' },
    bad_letter: { flag: '🚫', txt: 'No empieza con la letra de la ronda.' },
    empty: { flag: '', txt: 'Sin respuesta.' },
    accepted: { flag: '✅', txt: 'Aceptada por votación.' },
    rejected: { flag: '❌', txt: 'Rechazada por votación.' },
  };

  function renderResults() {
    const r = S.lastResult;
    if (!r) return renderLoading();
    const host = isHost();
    const last = S.round >= S.totalRounds;
    const openCh = Object.values(r.challenges).filter((c) => c.open);
    const reviewList = [];
    r.players.forEach((pid) =>
      r.categories.forEach((c) => {
        const a = r.answers[pid][c.id];
        if (a.status === 'review' && !r.challenges[`${pid}|${c.id}`]) reviewList.push({ pid, c, a });
      })
    );
    const stopper = r.stoppedBy ? playerById(r.stoppedBy) : null;

    const voteCards = openCh
      .map((ch) => {
        const author = playerById(ch.playerId);
        const cat = r.categories.find((c) => c.id === ch.catId);
        const ans = r.answers[ch.playerId][ch.catId];
        const yes = Object.values(ch.votes).filter(Boolean).length;
        const no = Object.values(ch.votes).length - yes;
        const myVote = ch.votes[S.you];
        const canVote = ch.playerId !== S.you && r.players.includes(S.you);
        return `<div class="vote-card">
          <div class="q">⚖️ ¿<b>${esc(ans.text)}</b> es un/a ${esc(cat ? cat.name : '')} válido/a?<br><small>${esc(author ? author.name : '')} · ✅ ${yes} · ❌ ${no}</small></div>
          ${canVote ? `<button class="btn tiny ${myVote === true ? 'green' : ''}" data-vote="${esc(ch.key)}" data-v="1">✅ Válida</button>
                       <button class="btn tiny ${myVote === false ? 'danger' : ''}" data-vote="${esc(ch.key)}" data-v="0">❌ No válida</button>` : '<small><b>Tu respuesta está en votación</b></small>'}
          ${host ? `<button class="btn tiny" data-closevote="${esc(ch.key)}">Cerrar</button>` : ''}
        </div>`;
      })
      .join('');

    const reviewCards = reviewList
      .map(
        ({ pid, c, a }) => `<div class="vote-card" style="background:var(--card2)">
        <div class="q">⚠️ <b>${esc(a.text)}</b> <small>(${esc(c.name)} · ${esc(playerById(pid)?.name || '')})</small><br><small>No reconocida: cuenta como válida</small></div>
        <button class="btn tiny" data-challenge="${pid}|${c.id}">Impugnar</button></div>`
      )
      .join('');

    const table = `<div class="table-wrap"><table class="res">
      <thead><tr><th>Categoría</th>${r.players
        .map((pid) => {
          const p = playerById(pid);
          return `<th>${esc(p ? p.avatar : '👤')} ${esc(p ? p.name : '—')}${pid === S.you ? ' (tú)' : ''}</th>`;
        })
        .join('')}</tr></thead>
      <tbody>${r.categories
        .map(
          (c) => `<tr><td>${esc(c.name)}</td>${r.players
            .map((pid) => {
              const a = r.answers[pid][c.id];
              const ch = r.challenges[`${pid}|${c.id}`];
              const flag = ch && ch.open ? '⚖️' : STATUS_INFO[a.status].flag;
              const cls = a.points === 10 ? 'p10' : a.points === 5 ? 'p5' : 'p0';
              const struck = a.status === 'rejected' || a.status === 'bad_letter';
              return `<td><button class="cell ${a.status !== 'empty' ? 'clickable' : ''}" data-cell="${pid}|${c.id}">
                <span class="w ${a.status === 'empty' ? 'empty' : ''} ${struck ? 'struck' : ''}">${a.status === 'empty' ? '—' : esc(a.text)}</span>
                ${flag ? `<span class="flag">${flag}</span>` : ''}<span class="pts ${cls}">+${a.points}</span></button></td>`;
            })
            .join('')}</tr>`
        )
        .join('')}</tbody>
      <tfoot><tr><td>TOTAL RONDA</td>${r.players.map((pid) => `<td>${r.scores[pid] || 0}</td>`).join('')}</tr></tfoot>
    </table></div>
    <div class="legend"><span><span class="pts p10">+10</span> única</span><span><span class="pts p5">+5</span> repetida</span><span><span class="pts p0">+0</span> inválida</span><span>⚠️ por revisar</span><span>⚖️ en votación</span><span>Toca una respuesta para impugnarla</span></div>`;

    const ranking = rankingHTML(true);

    const hostBar = host
      ? `<button class="btn ${last ? 'orange' : 'green'} block" id="nextBtn">${last ? '🏆 VER GANADOR' : `▶ SIGUIENTE RONDA (${S.round + 1}/${S.totalRounds})`}</button>
         ${openCh.length ? '<p class="center muted" style="font-weight:700">Las votaciones abiertas se cerrarán al avanzar.</p>' : ''}`
      : `<div class="waiting card">⏳ Esperando al anfitrión para ${last ? 'ver al ganador' : 'la siguiente ronda'}<span class="dots-anim"><span>.</span><span>.</span><span>.</span></span></div>`;

    const scrollY = window.scrollY;
    const sameScreen = app.dataset.screen === 'results-' + S.round;
    const tableScroll = sameScreen && $('.table-wrap') ? $('.table-wrap').scrollLeft : 0;
    const reviewOpen = sameScreen && $('.review-box') ? $('.review-box').open : null;
    setScreen(
      'results-' + S.round,
      `<div class="res-head">
        <div class="letter-sm">${esc(r.letter)}</div>
        <div><h2>Resultados · Ronda ${r.round} de ${S.totalRounds}</h2>
        <div class="muted" style="font-weight:800">${stopper ? `🔴 ${esc(stopper.name)} dijo ¡TIEMPO!` : '⏰ Se acabó el tiempo'}</div></div>
      </div>
      <div class="tabs"><button data-tab="answers" class="${resultsTab === 'answers' ? 'on' : ''}">📝 Respuestas</button><button data-tab="ranking" class="${resultsTab === 'ranking' ? 'on' : ''}">🏆 Clasificación</button></div>
      <div class="${resultsTab === 'answers' ? '' : 'hidden'} stack">
        ${voteCards ? `<div class="votes">${voteCards}</div>` : ''}
        ${table}
        ${reviewCards ? `<details class="adv review-box" ${reviewList.length <= 3 ? 'open' : ''}><summary>⚠️ Por revisar (${reviewList.length})</summary><div class="votes" style="margin-top:8px">${reviewCards}</div></details>` : ''}
      </div>
      <div class="${resultsTab === 'ranking' ? '' : 'hidden'}">${ranking}</div>
      <div class="host-bar">${hostBar}</div>`
    );
    if (sameScreen) {
      window.scrollTo({ top: scrollY });
      if ($('.table-wrap')) $('.table-wrap').scrollLeft = tableScroll;
      if (reviewOpen !== null && $('.review-box')) $('.review-box').open = reviewOpen;
    }
    $$('[data-tab]').forEach(
      (b) =>
        (b.onclick = () => {
          resultsTab = b.dataset.tab;
          render();
        })
    );
    $$('[data-vote]').forEach((b) => (b.onclick = () => sendVote(b.dataset.vote, b.dataset.v === '1')));
    $$('[data-closevote]').forEach((b) => (b.onclick = async () => showErr(await call('challenge:close', { key: b.dataset.closevote }))));
    $$('[data-challenge]').forEach((b) => (b.onclick = () => openChallenge(b.dataset.challenge)));
    $$('[data-cell]').forEach((b) => (b.onclick = () => cellDetail(b.dataset.cell)));
    if (host) {
      $('#nextBtn').onclick = async () => {
        $('#nextBtn').disabled = true;
        const res = await call('round:next');
        if (!res.ok) {
          toast(res.error, true);
          $('#nextBtn').disabled = false;
        }
      };
    }
  }

  const showErr = (res) => !res.ok && toast(res.error, true);
  async function sendVote(key, valid) {
    showErr(await call('challenge:vote', { key, valid }));
  }
  async function openChallenge(key) {
    const [playerId, catId] = key.split('|');
    const res = await call('challenge:open', { playerId, catId });
    if (res.ok) toast('Respuesta enviada a votación ⚖️');
    else toast(res.error, true);
  }

  function cellDetail(key) {
    const r = S.lastResult;
    const [pid, catId] = key.split('|');
    const a = r.answers[pid][catId];
    if (!a || a.status === 'empty') return;
    const p = playerById(pid);
    const cat = r.categories.find((c) => c.id === catId);
    const ch = r.challenges[key];
    const info = STATUS_INFO[a.status];
    let action = '';
    if (ch && ch.open) action = `<p>⚖️ Esta respuesta está en votación.</p>`;
    else if (ch) action = `<p>${ch.outcome === 'accepted' ? '✅ Aceptada' : '❌ Rechazada'} por votación.</p>`;
    else if (a.status !== 'bad_letter') action = `<button class="btn orange block" id="doChallenge">⚖️ Impugnar respuesta</button>`;
    openModal(
      `<h2>${esc(cat ? cat.name : '')}</h2>
       <p style="font-family:var(--font-title);font-size:2rem;margin:6px 0">${esc(a.text)}</p>
       <p class="muted" style="font-weight:800">${esc(p ? p.avatar + ' ' + p.name : '')} · <span class="pts ${a.points === 10 ? 'p10' : a.points === 5 ? 'p5' : 'p0'}">+${a.points}</span>${a.shared ? ' (repetida)' : ''}</p>
       <p>${info.txt}</p>${action}
       <div class="actions"><button class="btn ghost" data-close>Cerrar</button></div>`,
      {
        onMount: (b) => {
          const btn = $('#doChallenge', b);
          if (btn)
            btn.onclick = () => {
              closeModal();
              openChallenge(key);
            };
        },
      }
    );
  }

  function rankingHTML(withDelta) {
    const sorted = [...S.players].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const medals = ['🥇', '🥈', '🥉'];
    let pos = 0;
    let prevTotal = null;
    return `<div class="section-title">🏆 CLASIFICACIÓN</div><div class="rank">${sorted
      .map((p, i) => {
        if (p.total !== prevTotal) pos = i + 1;
        prevTotal = p.total;
        return `<div class="rank-item ${pos === 1 ? 'first' : ''}" style="animation-delay:${i * 60}ms">
          <div class="pos">${pos <= 3 ? medals[pos - 1] : pos + '.'}</div>
          <div class="av" style="font-size:1.5rem">${esc(p.avatar)}</div>
          <div class="nm">${esc(p.name)}${p.id === S.you ? ' (tú)' : ''}</div>
          ${withDelta ? `<span class="delta">+${p.lastRound}</span>` : ''}
          <div class="tot">${p.total} pts</div>
        </div>`;
      })
      .join('')}</div>`;
  }

  // ---------- FINAL ----------
  function renderFinal() {
    const sorted = [...S.players].sort((a, b) => b.total - a.total);
    const top = sorted[0];
    const winners = sorted.filter((p) => p.total === top.total);
    const host = isHost();
    setScreen(
      'final',
      `<div class="stack narrow">
        <div class="winner">
          <div class="trophy">🏆</div>
          <div class="lbl">${winners.length > 1 ? '¡EMPATE!' : 'GANADOR'}</div>
          <div class="name">${winners.map((w) => `${esc(w.avatar)} ${esc(w.name.toUpperCase())}`).join('<br>')}</div>
          <div class="score">${top.total} PUNTOS</div>
        </div>
        <div class="podium">${rankingHTML(false)}</div>
        ${
          host
            ? '<button class="btn green block" id="againBtn">🔄 JUGAR NUEVAMENTE</button>'
            : '<div class="waiting card">🔄 El anfitrión puede iniciar otra partida con el mismo grupo</div>'
        }
        <button class="btn ghost block" id="homeBtn">🏠 VOLVER AL INICIO</button>
      </div>`
    );
    if (host) $('#againBtn').onclick = async () => showErr(await call('game:again'));
    $('#homeBtn').onclick = leaveRoom;
    if (!confettiDone) {
      confettiDone = true;
      confetti();
    }
  }

  function confetti() {
    const items = ['🎉', '🍉', '🍓', '🍇', '🍋', '⭐', '🍊', '🎊', '🍒'];
    for (let i = 0; i < 46; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.textContent = items[i % items.length];
      el.style.left = Math.random() * 100 + 'vw';
      el.style.animationDuration = 2.5 + Math.random() * 2.5 + 's';
      el.style.animationDelay = Math.random() * 1.2 + 's';
      el.style.fontSize = 1 + Math.random() * 1.4 + 'rem';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 6500);
    }
  }

  // ---------- Arranque ----------
  fetch('/api/meta')
    .then((r) => r.json())
    .then((m) => {
      META = m;
      if (view !== 'room' && view !== 'loading') render();
    })
    .catch(() => toast('No se pudo cargar la configuración', true));
  render();
})();
