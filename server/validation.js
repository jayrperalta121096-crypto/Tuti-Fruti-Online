// Validación automática de respuestas (se ejecuta SOLO en el servidor).
const { DICTIONARIES } = require('./dictionaries');

/** Normaliza: minúsculas, sin tildes (conserva la ñ), sin signos, espacios simples. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'ñ')
    .replace(/[^a-zñ0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLetter(letter) {
  return normalize(letter).charAt(0);
}

// Diccionarios normalizados en Sets
const DICT_SETS = {};
for (const [cat, words] of Object.entries(DICTIONARIES)) {
  DICT_SETS[cat] = new Set(words.map(normalize).filter(Boolean));
}

// Índice por primera letra para búsqueda aproximada (errores de tipeo)
const DICT_BY_LETTER = {};
for (const [cat, set] of Object.entries(DICT_SETS)) {
  DICT_BY_LETTER[cat] = {};
  for (const word of set) {
    const l = word.charAt(0);
    (DICT_BY_LETTER[cat][l] = DICT_BY_LETTER[cat][l] || []).push(word);
  }
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

/** Busca la palabra en el diccionario de la categoría. Devuelve la forma canónica o null. */
function lookup(dictKey, norm) {
  const set = DICT_SETS[dictKey];
  if (!set) return null;
  if (set.has(norm)) return norm;
  // Plurales simples: "mangos" → "mango", "limones" → "limon"
  const candidates = [];
  if (norm.endsWith('es')) candidates.push(norm.slice(0, -2));
  if (norm.endsWith('s')) candidates.push(norm.slice(0, -1));
  for (const c of candidates) if (set.has(c)) return c;
  // Error de tipeo de 1 letra para palabras de 5+ letras
  if (norm.length >= 5) {
    const list = DICT_BY_LETTER[dictKey][norm.charAt(0)] || [];
    for (const word of list) if (levenshtein(word, norm) <= 1) return word;
  }
  return null;
}

/**
 * Evalúa una respuesta.
 * status:
 *   empty      → vacía (0 pts)
 *   bad_letter → no empieza con la letra (0 pts)
 *   ok         → reconocida en el diccionario (válida)
 *   review     → no reconocida: se acepta provisionalmente y queda "por revisar"
 *   free       → categoría sin diccionario: se acepta (se puede impugnar)
 */
function evaluate(text, letter, dictKey) {
  const norm = normalize(text);
  if (!norm) return { status: 'empty', key: '' };
  const l = normalizeLetter(letter);
  if (norm.charAt(0) !== l || norm.replace(/ /g, '').length < 2) {
    return { status: 'bad_letter', key: norm };
  }
  // dictKey puede ser una lista (ej. "Fruta o Verdura" usa ['fruta','verdura'])
  const keys = (Array.isArray(dictKey) ? dictKey : [dictKey]).filter((k) => k && DICT_SETS[k]);
  if (!keys.length) return { status: 'free', key: norm };
  for (const k of keys) {
    const canon = lookup(k, norm);
    if (canon) return { status: 'ok', key: canon };
  }
  return { status: 'review', key: norm };
}

const VALID_STATUSES = new Set(['ok', 'review', 'free', 'accepted']);
const isValidStatus = (s) => VALID_STATUSES.has(s);

module.exports = { normalize, evaluate, isValidStatus, DICT_SETS };
