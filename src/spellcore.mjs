/**
 * Ядро проверки русской орфографии.
 *
 * Модуль намеренно не зависит от DOM и от React: он собирается в браузерный
 * артефакт плагина (см. tools/build.mjs) и одновременно импортируется
 * unit-тестами в Node. Поэтому здесь только чистые функции и структуры данных.
 *
 * Источник словаря: hunspell-совместимые файлы ru_RU.dic / ru_RU.aff
 * (LibreOffice/dictionaries, словарь russian-words, MIT). Мы НЕ разворачиваем
 * 146 тысяч основ в полный список форм (это миллионы строк и сотни мегабайт
 * памяти в браузере). Вместо этого применяется тот же алгоритм, что и в
 * hunspell: для проверяемого слова перебираются правила суффиксов (SFX),
 * восстанавливается основа, и она ищется в словаре основ с нужным флагом.
 *
 * Инварианты:
 *  - Состояние движка после создания неизменно, кроме кэшей (они не влияют
 *    на результат проверки, только на скорость).
 *  - `check` возвращает true для любого слова, которое словарь считает
 *    корректным, включая формы, полученные через SFX-правила.
 *  - `suggest` никогда не возвращает исходное слово и только слова, которые
 *    сам движок считает корректными (защита от «исправления» на опечатку).
 */

/** Минимальная длина слова, которое вообще рассматривается как проверяемое. */
export const MIN_WORD_LENGTH = 3;

/** Максимальное расстояние Дамерау-Левенштейна для кандидатов в исправления. */
export const MAX_SUGGEST_DISTANCE = 2;

/**
 * Порог частотности для слов с заглавной буквы.
 *
 * Слово с заглавной буквы — это либо начало предложения, либо имя или
 * название. Чтобы не подчёркивать фамилии и бренды («Нуриевым» → «Нутриевым»),
 * для таких слов требуем очень частотное исправление.
 */
const CAPITALIZED_RANK_LIMIT = 3000;

/**
 * Порог частотности для коротких исправлений (до 8 букв).
 *
 * Слова из частотного списка встречаются в живой речи, поэтому исправление
 * на них правдоподобно. Слова редких рангов (например «кыш», «теплой»,
 * «банд») — случайные соседи технических заимствований, их не принимаем.
 */
const TRUSTED_CANDIDATE_RANK_LIMIT = 15000;

/**
 * Порог частотности для совсем коротких исправлений (до 5 букв).
 *
 * Коротких слов в языке много, и рядом с любым заимствованием почти всегда
 * найдётся «сосед» из трёх букв («кэш» → «куш», «юнит» → «мнит»). Поэтому для
 * коротких кандидатов требуем действительно массовое слово.
 */
const SHORT_CANDIDATE_RANK_LIMIT = 3000;

/**
 * Гласные, которые путают при наборе.
 *
 * В русском ошибка в гласной — самый частый вид опечатки, и путают почти любые
 * гласные: «синию» вместо «синюю», «сабака» вместо «собака», «карова» вместо
 * «корова», «правельно» вместо «правильно». Поэтому все гласные считаем
 * взаимозаменяемыми, а отсекают мусор другие правила: кандидат должен быть
 * частотным словом (или длинным) и правдоподобным по согласным.
 */
const VOWELS = new Set(['а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я']);

/** Пары согласных, которые путают на слух и при быстрой печати. */
const VOICING_PAIRS = [
  ['б', 'п'], ['в', 'ф'], ['г', 'к'], ['г', 'х'], ['д', 'т'],
  ['ж', 'ш'], ['з', 'с'], ['л', 'м'],
];

/** Ряды клавиатуры ЙЦУКЕН: соседние буквы в ряду путают при наборе. */
const KEYBOARD_ROWS = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];

/** Одинарная замена буквы правдоподобна для русской опечатки? */
function isPlausibleSubstitution(from, to) {
  if (from === to) return true;
  if (VOWELS.has(from) && VOWELS.has(to)) return true;
  for (const [first, second] of VOICING_PAIRS) {
    if ((from === first && to === second) || (from === second && to === first)) return true;
  }
  for (const row of KEYBOARD_ROWS) {
    const left = row.indexOf(from);
    const right = row.indexOf(to);
    if (left >= 0 && right >= 0 && Math.abs(left - right) === 1) return true;
  }
  return false;
}

/** Предел кэшей, чтобы долгая сессия не росла бесконечно. */
const CACHE_LIMIT = 20000;

/** Максимум кандидатов, попадающих в меню правой кнопки. */
const MAX_SUGGESTIONS = 8;

/**
 * Регэксп одного слова: только кириллица. Дефис и апостроф намеренно не
 * входят, поэтому «какой-то» распадается на два независимых слова — так
 * подчёркивание и подсказки относятся к конкретной части сложного слова.
 */
const TOKEN_RE = /[А-Яа-яЁё]+/gu;

/** Набор символов, которые считаются «буквами» при разборе условий в .aff. */
const CONDITION_SPECIAL = new Set(['[', ']', '.', '^', '-', '\\']);

/**
 * Разбить текст на слова с их позициями в исходной строке.
 * Позиции нужны, чтобы построить Range для подсветки (CSS Custom Highlight API
 * работает с диапазонами внутри текстовых узлов, а не с индексами в строке).
 * @param {string} text - содержимое текстового узла.
 * @returns {Array<{ word: string, start: number, end: number }>}
 */
export function tokenize(text) {
  const result = [];
  if (!text) return result;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    result.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return result;
}

/**
 * Привести «ё» к «е» для сравнения.
 *
 * Русскоязычные пользователи массово печатают «е» вместо «ё», и в чате это
 * не считается ошибкой. Нормализация применяется только при сравнении и
 * вычислении расстояния; показываем мы всегда словарную форму с «ё».
 * @param {string} word
 * @returns {string}
 */
export function normalizeYo(word) {
  return word.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

/**
 * Расстояние Дамерау-Левенштейна (вариант «optimal string alignment»).
 *
 * Реализация намеренно простая и без зависимостей: слова короткие (до ~30
 * символов), а вызывается функция только для кандидатов при подборе
 * исправлений. `limit` позволяет оборвать вычисление, если разница уже
 * заведомо больше допустимой — это заметно ускоряет перебор.
 * @param {string} a
 * @param {string} b
 * @param {number} limit - максимальное интересующее расстояние.
 * @returns {number} расстояние либо limit + 1, если оно больше лимита.
 */
export function distance(a, b, limit = MAX_SUGGEST_DISTANCE) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const n = a.length;
  const m = b.length;
  // prev2/prev1/current — три строки матрицы; памяти O(m), а не O(n*m).
  let prev2 = new Array(m + 1).fill(0);
  let prev1 = new Array(m + 1).fill(0);
  let current = new Array(m + 1).fill(0);
  for (let j = 0; j <= m; j += 1) prev1[j] = j;
  for (let i = 1; i <= n; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= m; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(prev1[j] + 1, current[j - 1] + 1, prev1[j - 1] + cost);
      // Перестановка соседних символов — самая частая опечатка при быстрой печати.
      if (i > 1 && j > 1
        && a.charCodeAt(i - 1) === b.charCodeAt(j - 2)
        && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    const recycled = prev2;
    prev2 = prev1;
    prev1 = current;
    current = recycled;
  }
  return prev1[m];
}

/**
 * Положить значение в кэш, не давая ему расти бесконечно.
 *
 * При переполнении выбрасывается самый старый ключ (Map хранит порядок
 * вставки), а не весь кэш: полная очистка в долгой сессии означала бы
 * повторный дорогой пересчёт всех слов чата.
 * @param {Map<string, unknown>} cache
 * @param {string} key
 * @param {unknown} value
 */
function remember(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/**
 * Разобрать .aff: TRY-алфавит и правила суффиксов.
 *
 * Формат строк: заголовок блока `SFX флаг перекрёстный количество`, затем
 * правила `SFX флаг отрезать приписать условие`. Условие — упрощённый
 * шаблон hunspell: литералы, `.` (любой символ) и классы `[...]`.
 * @param {string} text
 * @returns {{ tryChars: string, rules: Array<{flag:string,strip:string,append:string,condition:RegExp|null,cross:boolean}>, maxAppend: number }}
 */
export function parseAff(text) {
  const rules = [];
  let tryChars = '';
  let maxAppend = 0;
  const lines = text.split(/\r?\n/u);
  /** @type {Map<string, boolean>} флаг → перекрёстность (PFX+SFX), для полноты */
  const crossFlags = new Map();
  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith('TRY ')) {
      tryChars = raw.slice(4).trim();
      continue;
    }
    if (!raw.startsWith('SFX ') && !raw.startsWith('PFX ')) continue;
    const parts = raw.trim().split(/\s+/u);
    if (parts.length < 4) continue;
    const [, flag, third, fourth] = parts;
    // Заголовок блока: третий токен Y/N, четвёртый — число правил.
    if ((third === 'Y' || third === 'N') && /^\d+$/u.test(fourth)) {
      crossFlags.set(flag, third === 'Y');
      continue;
    }
    const strip = third === '0' ? '' : third;
    const append = fourth === '0' ? '' : fourth;
    const conditionText = parts.length >= 5 ? parts[4] : '';
    const condition = conditionText === '' || conditionText === '.' ? null : compileCondition(conditionText);
    rules.push({ flag, strip, append, condition, cross: crossFlags.get(flag) === true });
    if (append.length > maxAppend) maxAppend = append.length;
  }
  return { tryChars, rules, maxAppend };
}

/**
 * Превратить условие hunspell в регулярное выражение «конец основы».
 *
 * Примеры из ru_RU.aff: `чь`, `[лнртв]ый`, `[цс]кий`, `заться`.
 * Спецсимволы aside, шаблон применяется именно к концу основы словаря —
 * так же, как это делает hunspell при развёртывании аффиксов.
 * @param {string} pattern
 * @returns {RegExp}
 */
function compileCondition(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '[') {
      // Класс символов копируем как есть: внутри допустимы диапазоны и ^.
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) {
        source += '\\[';
        continue;
      }
      source += pattern.slice(i, close + 1);
      i = close;
      continue;
    }
    if (ch === '.') {
      source += '.';
      continue;
    }
    source += CONDITION_SPECIAL.has(ch) ? `\\${ch}` : ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  try {
    return new RegExp(`${source}$`, 'u');
  } catch {
    // Некорректное условие в словаре не должно валить весь движок:
    // правило станет «слишком строгим» и просто не сработает.
    return /$a/u;
  }
}

/**
 * Разобрать .dic: основа → строка флагов.
 * Первая строка файла — количество записей, она пропускается.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseDic(text) {
  const stems = new Map();
  const lines = text.split(/\r?\n/u);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const slash = line.indexOf('/');
    if (slash < 0) stems.set(line, '');
    else stems.set(line.slice(0, slash), line.slice(slash + 1));
  }
  return stems;
}

/**
 * Создать движок проверки.
 *
 * @param {object} options
 * @param {string} options.dic - содержимое .dic (UTF-8).
 * @param {string} options.aff - содержимое .aff (UTF-8).
 * @param {Iterable<string>} [options.userWords] - пользовательские слова.
 * @param {Iterable<string>} [options.ignore] - пропущенные слова.
 * @param {Iterable<string>} [options.frequency] - слова в порядке убывания частоты
 *   (индекс = ранг). Нужен только для порядка подсказок: среди кандидатов с
 *   одинаковым расстоянием выше поднимается частотное слово.
 */
export function createEngine(options) {
  const stems = parseDic(options.dic);
  const { tryChars, rules, maxAppend } = parseAff(options.aff);
  /** @type {Map<string, number>} слово → ранг частоты (0 — самое частое). */
  const frequencyRank = new Map();
  if (options.frequency) {
    let rank = 0;
    for (const word of options.frequency) {
      const key = normalizeYo(String(word).toLowerCase());
      if (!frequencyRank.has(key)) frequencyRank.set(key, rank);
      rank += 1;
    }
  }

  /** @type {Map<string, Array<{flag:string,strip:string,append:string,condition:RegExp|null}>>} */
  const rulesByAppend = new Map();
  /** @type {Map<string, Array<{strip:string,append:string,condition:RegExp|null}>>} */
  const rulesByFlag = new Map();
  for (const rule of rules) {
    let byAppend = rulesByAppend.get(rule.append);
    if (!byAppend) rulesByAppend.set(rule.append, byAppend = []);
    byAppend.push(rule);
    let byFlag = rulesByFlag.get(rule.flag);
    if (!byFlag) rulesByFlag.set(rule.flag, byFlag = []);
    byFlag.push(rule);
  }

  const userWords = new Set([...(options.userWords ?? [])].map(word => word.toLowerCase()));
  const ignoreWords = new Set([...(options.ignore ?? [])].map(word => word.toLowerCase()));

  /** Алфавит для генерации вариантов: TRY-строка hunspell + «ё» (её там нет). */
  const alphabet = [...new Set(`${tryChars.toLowerCase()}ё`)].filter(ch => /[а-яё]/u.test(ch));

  const checkCache = new Map();
  const suggestCache = new Map();
  const flagCache = new Map();

  // Список основ в отсортированном виде нужен только для подбора исправлений
  // по префиксу; строим лениво, чтобы не платить за сортировку там, где
  // подсказки ни разу не понадобились (например, в тексте без опечаток).
  let sortedStems = null;

  /**
   * Проверка сырой словоформы по правилам суффиксов (без учёта регистра).
   * @param {string} word
   * @returns {boolean}
   */
  const matchesRules = (word) => {
    if (stems.has(word)) return true;
    const len = word.length;
    for (let appendLength = 0; appendLength <= maxAppend && appendLength <= len; appendLength += 1) {
      const append = appendLength === 0 ? '' : word.slice(len - appendLength);
      const candidates = rulesByAppend.get(append);
      if (!candidates) continue;
      const base = word.slice(0, len - appendLength);
      for (const rule of candidates) {
        const stem = rule.strip ? base + rule.strip : base;
        const flags = stems.get(stem);
        if (flags === undefined) continue;
        if (!flags.includes(rule.flag)) continue;
        if (rule.condition !== null && !rule.condition.test(stem)) continue;
        return true;
      }
    }
    return false;
  };

  /**
   * Проверить слово с учётом регистра, «ё» и пользовательских слов.
   * @param {string} word
   * @returns {boolean}
   */
  const checkUncached = (word) => {
    if (word.length < 1) return true;
    const lower = word.toLowerCase();
    if (userWords.has(lower)) return true;
    if (ignoreWords.has(lower)) return true;
    const variants = new Set([word, lower]);
    // Заглавная буква в начале предложения и имена собственные не должны
    // считаться ошибкой, если словарная форма начинается со строчной — и наоборот.
    variants.add(lower.charAt(0).toUpperCase() + lower.slice(1));
    variants.add(normalizeYo(word));
    variants.add(normalizeYo(lower));
    for (const variant of variants) {
      if (matchesRules(variant)) return true;
    }
    return false;
  };

  /**
   * Проверить слово (с кэшем).
   * @param {string} word
   * @returns {boolean}
   */
  const check = (word) => {
    const cached = checkCache.get(word);
    if (cached !== undefined) return cached;
    const result = checkUncached(word);
    remember(checkCache, word, result);
    return result;
  };

  /** Привести основу к нижнему регистру для бинарного поиска по массиву. */
  const stemKeys = () => {
    if (sortedStems === null) {
      sortedStems = [];
      for (const stem of stems.keys()) sortedStems.push(stem);
      sortedStems.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return sortedStems;
  };

  /**
   * Развернуть одну основу в словоформы по её флагам.
   * Используется только для подбора исправлений, поэтому ограничено по объёму.
   * @param {string} stem
   * @param {string} flags
   * @param {Set<string>} sink
   */
  const expandStem = (stem, flags, sink) => {
    sink.add(stem);
    if (!flags) return;
    for (const flag of flags) {
      const list = rulesByFlag.get(flag);
      if (!list) continue;
      for (const rule of list) {
        if (rule.strip && !stem.endsWith(rule.strip)) continue;
        if (rule.condition !== null && !rule.condition.test(stem)) continue;
        const form = (rule.strip ? stem.slice(0, stem.length - rule.strip.length) : stem) + rule.append;
        if (form.length > 1) sink.add(form);
      }
    }
  };

  /**
   * Собрать словоформы основ, начинающихся с заданного префикса.
   * @param {string} prefix - префикс в нижнем регистре.
   * @param {number} maxStems - предел числа просматриваемых основ.
   * @param {Set<string>} sink
   */
  const collectByPrefix = (prefix, maxStems, sink) => {
    if (prefix.length < 2) return;
    const keys = stemKeys();
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (keys[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    let seen = 0;
    for (let i = low; i < keys.length && seen < maxStems; i += 1) {
      const stem = keys[i];
      if (!stem.toLowerCase().startsWith(prefix)) break;
      expandStem(stem, stems.get(stem) ?? '', sink);
      seen += 1;
    }
  };

  /**
   * Кандидаты с одной правкой: удаление, перестановка, замена, вставка.
   *
   * Это дешёвый источник (около 500 проверок для слова из 8 букв), и именно он
   * закрывает большинство реальных опечаток. Порядок перебора — TRY-строка
   * словаря, то есть частотный порядок букв языка.
   * @param {string} lower - слово в нижнем регистре.
   * @param {Set<string>} sink
   */
  const collectEditCandidates = (lower, sink) => {
    const length = lower.length;
    if (length < 2) return;
    for (let i = 0; i < length; i += 1) {
      sink.add(lower.slice(0, i) + lower.slice(i + 1));
      if (i + 1 < length) {
        sink.add(lower.slice(0, i) + lower.charAt(i + 1) + lower.charAt(i) + lower.slice(i + 2));
      }
      for (const ch of alphabet) {
        sink.add(lower.slice(0, i) + ch + lower.slice(i + 1));
        sink.add(lower.slice(0, i) + ch + lower.slice(i));
      }
    }
  };

  /**
   * Вес правдоподобия опечатки: 0 — правдоподобная (перестановка или
   * гласная/соседняя клавиша/путаница звонкости), 1 — сомнительная замена.
   *
   * Гласные в русском слове взаимозаменяемы («сабака» ↔ «собака»), поэтому
   * они дают вес 0 даже для замены, а вот согласные — только на соседних
   * клавишах или в паре звонкости. Иначе «кэш» → «куш» и «Сбера» → «сбора»
   * выглядели бы как настоящие опечатки.
   * @param {string} typo - нижний регистр.
   * @param {string} candidate - нижний регистр.
   * @returns {number}
   */
  const plausibilityWeight = (typo, candidate) => {
    if (typo.length !== candidate.length) return 0;
    const differing = [];
    for (let i = 0; i < typo.length; i += 1) {
      if (typo[i] !== candidate[i]) differing.push(i);
    }
    if (differing.length === 0) return 0;
    // Перестановка соседних букв — обычная опечатка.
    if (differing.length === 2) return 0;
    if (differing.length > 2) return 1;
    const position = differing[0];
    return isPlausibleSubstitution(typo[position], candidate[position]) ? 0 : 1;
  };

  /**
   * Подобрать исправления для слова.
   *
   * Два независимых источника кандидатов:
   *  1) все варианты с одной правкой — закрывает обычные опечатки;
   *  2) словоформы словарных основ, близких по префиксу — закрывает ошибки в
   *     окончаниях и морфологические опечатки, где нужно две правки. Этот
   *     источник заметно дороже, поэтому в фоновой проверке текста он не
   *     используется (см. shouldFlag), а нужен для меню правой кнопки.
   * @param {string} word
   * @param {boolean} deep - включать поиск по морфологическому окружению.
   * @returns {Array<{ word: string, distance: number }>} до MAX_SUGGESTIONS вариантов.
   */
  const suggestUncached = (word, deep) => {
    const lower = word.toLowerCase();
    const target = normalizeYo(lower);
    /** @type {Set<string>} */
    const candidates = new Set();
    collectEditCandidates(lower, candidates);
    if (deep) {
      const neighborhoods = new Set();
      for (const cut of [target.length, target.length - 1, target.length - 2]) {
        if (cut < 2) continue;
        collectByPrefix(target.slice(0, cut), 40, neighborhoods);
      }
      for (const form of neighborhoods) candidates.add(form);
    }

    /** @type {Array<{ word: string, distance: number, weight: number }>} */
    const scored = [];
    for (const candidate of candidates) {
      if (!candidate || candidate === lower) continue;
      if (!check(candidate)) continue;
      const d = distance(target, normalizeYo(candidate), MAX_SUGGEST_DISTANCE);
      if (d > MAX_SUGGEST_DISTANCE) continue;
      // Расстояние 0 после нормализации «ё» означает, что это то же слово,
      // просто с другой буквой ё — подсказывать такое бессмысленно.
      if (d === 0) continue;
      // Вес правдоподобия считается только для одной правки: на двух правках
      // любая замена выглядит «объяснимой».
      const weight = d === 1 ? plausibilityWeight(target, normalizeYo(candidate)) : 0;
      scored.push({ word: candidate, distance: d, weight });
    }
    // Сортировка: правдоподобие опечатки (иначе «карова» исправлялась бы в
    // «какова»), затем расстояние, затем частотность, затем близость длины,
    // затем алфавит как стабильный детерминированный тай-брейкер.
    const rankOf = candidate => frequencyRank.get(normalizeYo(candidate)) ?? Number.MAX_SAFE_INTEGER;
    scored.sort((a, b) => a.weight - b.weight
      || a.distance - b.distance
      || rankOf(a.word) - rankOf(b.word)
      || Math.abs(a.word.length - lower.length) - Math.abs(b.word.length - lower.length)
      || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

    const unique = [];
    const seen = new Set();
    for (const item of scored) {
      // «Дела» и «дёла» — одно и то же слово для пользователя: ключ без «ё».
      const key = normalizeYo(item.word);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
      if (unique.length >= MAX_SUGGESTIONS) break;
    }
    return unique;
  };

  /**
   * Подобрать исправления (с кэшем), восстановив регистр исходного слова.
   * @param {string} word
   * @param {{ deep?: boolean }} [options]
   * @returns {Array<{ word: string, distance: number }>}
   */
  const suggest = (word, options = {}) => {
    const deep = options.deep !== false;
    const cacheKey = `${deep ? 'd' : 's'}:${word}`;
    const cached = suggestCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const raw = suggestUncached(word, deep);
    const isUpper = word === word.toUpperCase();
    const isCapitalized = !isUpper && word.charAt(0) !== word.charAt(0).toLowerCase();
    const result = raw.map((item) => {
      let display = item.word;
      if (isUpper) display = display.toUpperCase();
      else if (isCapitalized) display = display.charAt(0).toUpperCase() + display.slice(1);
      return { word: display, distance: item.distance };
    });
    if (suggestCache.size >= CACHE_LIMIT) suggestCache.delete(suggestCache.keys().next().value);
    suggestCache.set(cacheKey, result);
    return result;
  };

  /**
   * Нужно ли подчёркивать слово.
   *
   * Словарь не содержит все имена, термины и неологизмы, поэтому «слова нет в
   * словаре» само по себе не повод рисовать красную волну. Подчёркиваем только
   * когда рядом есть правдоподобное словарное исправление с расстоянием 1 —
   * это резко снижает число ложных срабатываний на именах собственных и
   * технических терминах. Проверка идёт по дешёвому набору кандидатов
   * (одна правка), потому что вызывается для каждого незнакомого слова при
   * каждом обновлении текста.
   * @param {string} word
   * @returns {boolean}
   */
  const shouldFlag = (word) => {
    const cached = flagCache.get(word);
    if (cached !== undefined) return cached;
    const result = decideFlag(word);
    if (flagCache.size >= CACHE_LIMIT) flagCache.delete(flagCache.keys().next().value);
    flagCache.set(word, result);
    return result;
  };

  /**
   * Решение о подчёркивании без кэша (см. shouldFlag).
   * @param {string} word
   * @returns {boolean}
   */
  const decideFlag = (word) => {
    if (!isCheckableWord(word)) return false;
    if (check(word)) return false;
    const raw = suggestUncached(word, false);
    // Нужен хотя бы один правдоподобный кандидат с одной правкой, и этому
    // кандидату нужно доверять:
    //  - длинное слово (8+ букв) принимаем и без частотного списка, иначе
    //    теряются опечатки в терминах («отабражение» → «отображение»);
    //  - короткое (до 5 букв) — только массовое слово, иначе рядом с любым
    //    заимствованием находится случайный «сосед» («кэш» → «куш»);
    //  - среднее — частотное слово из списка.
    const trusted = (candidate) => {
      if (candidate.length >= 8) return true;
      const rank = frequencyRank.get(normalizeYo(candidate));
      if (rank === undefined) return false;
      return rank <= (candidate.length < 5 ? SHORT_CANDIDATE_RANK_LIMIT : TRUSTED_CANDIDATE_RANK_LIMIT);
    };
    const plausible = raw.filter(item => item.distance === 1 && item.weight === 0 && trusted(item.word));
    if (plausible.length === 0) return false;
    const isCapitalized = word.charAt(0) !== word.charAt(0).toLowerCase();
    if (!isCapitalized) return true;
    // Слово с заглавной буквы — вероятное имя или название. Требуем, чтобы
    // хотя бы одно правдоподобное исправление было частотным словом:
    // «Пажалуйста» → «пожалуйста» проходит, «Нуриевым» → «Нутриевым» — нет.
    return plausible.some((item) => {
      const rank = frequencyRank.get(normalizeYo(item.word));
      return rank !== undefined && rank < CAPITALIZED_RANK_LIMIT;
    });
  };

  /**
   * Добавить слово в пользовательский словарь (после «Добавить в словарь»).
   * Кэши сбрасываются целиком: слово могло быть в них помечено как ошибочное.
   * @param {string} word
   */
  const addUserWord = (word) => {
    const lower = word.toLowerCase();
    if (userWords.has(lower)) return;
    userWords.add(lower);
    checkCache.clear();
    suggestCache.clear();
    flagCache.clear();
  };

  /**
   * Больше не считать слово ошибочным в этой сессии.
   * @param {string} word
   */
  const addIgnored = (word) => {
    const lower = word.toLowerCase();
    if (ignoreWords.has(lower)) return;
    ignoreWords.add(lower);
    checkCache.clear();
    suggestCache.clear();
    flagCache.clear();
  };

  return {
    check,
    suggest,
    shouldFlag,
    addUserWord,
    addIgnored,
    stats: () => ({ stems: stems.size, rules: rules.length, alphabet: alphabet.length }),
  };
}

/**
 * Годится ли токен для проверки орфографии.
 *
 * Отсекаем то, что заведомо не является русским словом: аббревиатуры,
 * идентификаторы с цифрами, camelCase, слишком короткие токены.
 * @param {string} word
 * @returns {boolean}
 */
export function isCheckableWord(word) {
  if (word.length < MIN_WORD_LENGTH) return false;
  if (!/^[А-Яа-яЁё]+$/u.test(word)) return false;
  // Аббревиатуры и названия вида ВШЭ, ИТ — не проверяем.
  if (word === word.toUpperCase()) return false;
  // Внутренние заглавные буквы — это идентификатор, а не слово.
  const tail = word.slice(1);
  if (tail !== tail.toLowerCase() && tail !== tail.toUpperCase()) return false;
  return true;
}

/**
 * Применить исправление к строке по позициям токена.
 * Чистая функция: используется и подсветкой, и тестами.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} replacement
 * @returns {string}
 */
export function replaceRange(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}
