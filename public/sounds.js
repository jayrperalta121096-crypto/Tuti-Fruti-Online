// Sonidos sintetizados con Web Audio (no requiere archivos).
window.Sounds = (() => {
  let ctx = null;
  let enabled = true;
  try {
    enabled = localStorage.getItem('tf_sound') !== 'off';
  } catch (_) {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Desbloquear audio con el primer toque (requisito de los navegadores móviles)
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => ac(), { once: true, passive: true }));

  function tone(freq, start, dur, type = 'sine', vol = 0.18) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + start;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const library = {
    countdown: () => tone(660, 0, 0.15, 'triangle'),
    start: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.25, 'triangle')),
    tick: () => tone(880, 0, 0.08, 'square', 0.07),
    stop: () => {
      tone(220, 0, 0.5, 'sawtooth', 0.15);
      tone(165, 0.05, 0.55, 'square', 0.1);
    },
    results: () => [784, 988, 1175].forEach((f, i) => tone(f, i * 0.12, 0.35, 'sine', 0.15)),
    winner: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, i === 5 ? 0.8 : 0.22, 'triangle', 0.18)),
    pop: () => tone(520, 0, 0.08, 'sine', 0.1),
  };

  return {
    play(name) {
      if (!enabled || !library[name]) return;
      try {
        library[name]();
      } catch (_) {}
    },
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem('tf_sound', enabled ? 'on' : 'off');
      } catch (_) {}
      if (enabled) library.pop();
      return enabled;
    },
  };
})();
