/**
 * Тесты ядра проверки орфографии.
 *
 * Проверяем не «примерно работает», а конкретные инварианты:
 *  - разбор .aff/.dic даёт ожидаемые объёмы и корректную семантику суффиксов;
 *  - корректные слова не помечаются (в том числе с «ё», с заглавной буквы);
 *  - опечатки помечаются, и первая подсказка — нужное слово;
 *  - подсказки всегда сами проходят проверку (не предлагаем новую опечатку);
 *  - расстояния и токенизация считаются точно.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createEngine, distance, isCheckableWord, normalizeYo, parseAff, parseDic,
  replaceRange, tokenize, MAX_SUGGEST_DISTANCE,
} from '../src/spellcore.mjs'

const vendor = new URL('../tools/vendor/', import.meta.url)
const dicText = readFileSync(new URL('ru_RU.dic', vendor), 'utf8')
const affText = readFileSync(new URL('ru_RU.aff', vendor), 'utf8')
const frequency = readFileSync(new URL('ru_50k.txt', vendor), 'utf8')
  .split(/\r?\n/u)
  .map(line => line.split(/\s+/u)[0])
  .filter(word => word && /^[А-Яа-яЁё]+$/u.test(word))
  .map(word => word.toLowerCase())

const engine = createEngine({ dic: dicText, aff: affText, frequency })

describe('разбор словаря', () => {
  test('dic: количество основ и наличие базовых слов', () => {
    const stems = parseDic(dicText)
    assert.equal(stems.size, 146269)
    for (const stem of ['кот', 'привет', 'собака', 'работать']) {
      assert.ok(stems.has(stem), `нет основы ${stem}`)
    }
    // Флаги хранятся строкой рядом с основой: «кот/A» → 'A'.
    assert.match(stems.get('кот') ?? '', /^[A-Z]+$/u)
  })

  test('aff: правила суффиксов разобраны, алфавит TRY не пуст', () => {
    const { rules, tryChars, maxAppend } = parseAff(affText)
    assert.equal(rules.length, 1581)
    assert.ok(tryChars.length > 20, 'алфавит TRY должен быть разобран')
    assert.ok(maxAppend >= 4, 'должны быть многобуквенные суффиксы')
    const rule = rules.find(item => item.append === 'жешь')
    assert.ok(rule, 'правило «жешь» должно существовать')
    assert.equal(rule.strip, 'чь')
    assert.ok(rule.condition instanceof RegExp)
  })
})

describe('проверка слов', () => {
  const valid = [
    'привет', 'можешь', 'коты', 'мышки', 'подсвечиваются', 'исправления', 'варианты',
    'неправильному', 'орфография', 'синхронизация', 'программирование', 'Чувашия',
    'Дубай', 'ёлка', 'елка', 'Привет', 'ПРИВЕТ',
  ]
  for (const word of valid) {
    test(`корректное слово: ${word}`, () => {
      assert.equal(engine.check(word), true)
      assert.equal(engine.shouldFlag(word), false)
    })
  }

  const invalid = ['привте', 'сабака', 'карова', 'малоко', 'исправленние', 'слвоа', 'синхранизация',
    // ошибки в окончаниях — самый частый вид опечатки в русском
    'синию', 'оталкивался']
  for (const word of invalid) {
    test(`опечатка подчёркивается: ${word}`, () => {
      assert.equal(engine.check(word), false)
      assert.equal(engine.shouldFlag(word), true)
    })
  }

  test('«е» и «ё» взаимозаменяемы', () => {
    assert.equal(normalizeYo('ёлка'), 'елка')
    assert.equal(engine.check('елка'), true)
    assert.equal(engine.check('ёлка'), true)
  })

  test('слова с заглавной буквы не считаются ошибкой', () => {
    assert.equal(engine.check('Привет'), true)
    assert.equal(engine.check('Собака'), true)
  })

  test('фамилия с заглавной буквы не подчёркивается', () => {
    // Ближайший кандидат — другое имя собственное («Нутриевым»), а не
    // частотное слово, поэтому это фамилия, а не опечатка.
    assert.equal(engine.check('Нуриевым'), false)
    assert.equal(engine.shouldFlag('Нуриевым'), false)
  })

  test('бренд с заглавной буквы не подчёркивается', () => {
    // «Сбера» → «сбора»/«сфера»: кандидаты есть, но они не настолько частотные,
    // чтобы считать слово опечаткой в начале предложения.
    assert.equal(engine.check('Сбера'), false)
    assert.equal(engine.shouldFlag('Сбера'), false)
  })

  test('опечатка в слове с заглавной буквы подчёркивается', () => {
    assert.equal(engine.shouldFlag('Пажалуйста'), true)
  })

  test('заимствования и сокращения не подчёркиваются', () => {
    // Слов нет в словаре, но правдоподобной опечатки тоже нет: рядом только
    // другие слова («кэш» → «кыш», «деплой» → «теплой», «бандл» → «банд»).
    // Ложные срабатывания на терминах делают проверку бесполезной.
    for (const word of ['фича', 'виджет', 'коммит', 'бандл', 'кэш', 'токен', 'юнит', 'деплой', 'рефакторинг']) {
      assert.equal(engine.shouldFlag(word), false, `не должно подчёркиваться: ${word}`)
    }
  })

  test('опечатки в длинных терминах подчёркиваются', () => {
    // Исправление отсутствует в частотном списке, но слово длинное и
    // правдоподобное: такие опечатки терять нельзя.
    for (const word of ['отабражение', 'подсвечиваються', 'исправленние']) {
      assert.equal(engine.shouldFlag(word), true, `должно подчёркиваться: ${word}`)
    }
  })
})

describe('подсказки', () => {
  test('известные опечатки исправляются в первую подсказку', () => {
    const cases = [
      ['привте', 'привет'],
      ['сабака', 'собака'],
      ['пажалуйста', 'пожалуйста'],
      ['слвоа', 'слова'],
      ['синхранизация', 'синхронизация'],
      ['кнпока', 'кнопка'],
      ['отабражение', 'отображение'],
      ['соообщение', 'сообщение'],
      ['правельно', 'правильно'],
      ['поялвяется', 'появляется'],
    ]
    for (const [typo, expected] of cases) {
      const suggestions = engine.suggest(typo)
      assert.ok(suggestions.length > 0, `нет подсказок для ${typo}`)
      assert.equal(suggestions[0].word, expected, `${typo} → ожидалось ${expected}, получено ${suggestions[0].word}`)
    }
  })

  test('регистр исходного слова сохраняется в подсказке', () => {
    const suggestions = engine.suggest('Сабака')
    assert.equal(suggestions[0].word, 'Собака')
    const upper = engine.suggest('САБАКА')
    assert.equal(upper[0].word, 'СОБАКА')
  })

  test('подсказки не содержат исходное слово и проходят проверку', () => {
    for (const typo of ['привте', 'карова', 'программис']) {
      const suggestions = engine.suggest(typo)
      const words = suggestions.map(item => item.word.toLowerCase())
      assert.equal(new Set(words).size, words.length, 'подсказки не должны дублироваться')
      for (const item of suggestions) {
        assert.equal(engine.check(item.word), true, `подсказка ${item.word} сама не проходит проверку`)
        assert.notEqual(item.word.toLowerCase(), typo)
        assert.ok(item.distance >= 1 && item.distance <= MAX_SUGGEST_DISTANCE)
      }
    }
  })

  test('число подсказок ограничено', () => {
    assert.ok(engine.suggest('страка').length <= 8)
  })
})

describe('пользовательский словарь и пропуски', () => {
  test('добавленное слово перестаёт подчёркиваться', () => {
    const local = createEngine({ dic: dicText, aff: affText, frequency })
    assert.equal(local.check('квазипроцессинг'), false)
    local.addUserWord('квазипроцессинг')
    assert.equal(local.check('квазипроцессинг'), true)
    assert.equal(local.check('Квазипроцессинг'), true)
  })

  test('пропущенное слово перестаёт подчёркиваться', () => {
    const local = createEngine({ dic: dicText, aff: affText, frequency })
    // «пажалуйста» — опечатка с правдоподобным кандидатом, то есть подчёркивается.
    assert.equal(local.shouldFlag('пажалуйста'), true)
    local.addIgnored('пажалуйста')
    assert.equal(local.shouldFlag('пажалуйста'), false)
  })

  test('пользовательский словарь, переданный при создании, учитывается', () => {
    const local = createEngine({ dic: dicText, aff: affText, userWords: ['ДШСПЕЛЛ'] })
    assert.equal(local.check('дшспелл'), true)
  })
})

describe('расстояние и токенизация', () => {
  test('расстояние Дамерау-Левенштейна', () => {
    assert.equal(distance('кот', 'кот'), 0)
    assert.equal(distance('кот', 'коты'), 1)
    assert.equal(distance('кот', 'ток'), 2) // две перестановки в OSA
    assert.equal(distance('привет', 'привте'), 1) // перестановка соседних
    assert.equal(distance('привет', 'приветик'), 2)
    assert.equal(distance('привет', 'аааааа', 2), 3, 'лимит обрывает вычисление')
  })

  test('токенизация: слова, дефисы и точные смещения', () => {
    const text = 'Привет, какой-то ёж! 42 раза'
    const tokens = tokenize(text)
    assert.deepEqual(tokens.map(token => token.word), ['Привет', 'какой', 'то', 'ёж', 'раза'])
    for (const token of tokens) {
      assert.equal(text.slice(token.start, token.end), token.word)
    }
  })

  test('токенизация пустой строки', () => {
    assert.deepEqual(tokenize(''), [])
    assert.deepEqual(tokenize('123 !!!'), [])
  })

  test('replaceRange подставляет слово по смещениям', () => {
    assert.equal(replaceRange('привте друг', 0, 6, 'привет'), 'привет друг')
    assert.equal(replaceRange('мой привте', 4, 10, 'привет'), 'мой привет')
  })

  test('isCheckableWord отсекает не слова', () => {
    assert.equal(isCheckableWord('привет'), true)
    assert.equal(isCheckableWord('ВШЭ'), false, 'аббревиатуры не проверяем')
    assert.equal(isCheckableWord('мр3'), false, 'цифры не проверяем')
    assert.equal(isCheckableWord('iPhone'), false, 'латиницу не проверяем')
    assert.equal(isCheckableWord('да'), false, 'слишком короткие слова не проверяем')
    assert.equal(isCheckableWord('прИвет'), false, 'внутренние заглавные — идентификатор')
  })

  test('части дефисных слов токенизируются отдельно', () => {
    const text = 'юнит-экономика и кто-то пришёл'
    assert.deepEqual(tokenize(text).map(token => token.word), ['юнит', 'экономика', 'и', 'кто', 'то', 'пришёл'])
  })
})

describe('скорость', () => {
  test('проверка текста из 400 слов укладывается в разумное время', () => {
    const words = ['Можешь мне сделать плагин для проверки орфографии чтобы можно было',
      'выбирать варианты слов в чате которые подсвечиваются красной волной',
      'иногда я печатаю быстро и делаю опечатки поэтому хочу видеть подчёркнутые слова'].join(' ')
    const tokens = tokenize(words).filter(token => isCheckableWord(token.word))
    const started = performance.now()
    for (let repeat = 0; repeat < 20; repeat += 1) {
      for (const token of tokens) engine.shouldFlag(token.word)
    }
    const elapsed = performance.now() - started
    // 20 проходов по ~35 слов с кэшем должны быть почти бесплатными.
    assert.ok(elapsed < 2000, `слишком медленно: ${elapsed.toFixed(0)}ms`)
  })
})
