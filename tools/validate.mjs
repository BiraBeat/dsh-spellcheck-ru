/**
 * Диагностический прогон движка на реальных данных (не входит в тестовый набор).
 *
 * Задача: измерить, насколько реализация аффиксов совпадает с эталонным
 * развёрнутым списком словоформ (russian.txt того же словаря, MIT), оценить
 * скорость проверки и качество/порядок подсказок.
 * Запуск: node tools/validate.mjs <russian.txt> <ru_50k.txt>
 */
import { readFileSync } from 'node:fs'
import { createEngine, isCheckableWord } from '../src/spellcore.mjs'

const vendor = new URL('./vendor/', import.meta.url)
const dic = readFileSync(new URL('ru_RU.dic', vendor), 'utf8')
const aff = readFileSync(new URL('ru_RU.aff', vendor), 'utf8')

/** Прочитать файл в UTF-8 с откатом на UTF-16LE и windows-1251. */
function readText(path) {
  const bytes = readFileSync(path)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    } catch {
      return new TextDecoder('windows-1251').decode(bytes)
    }
  }
}

const frequency = []
const frequencyPath = process.argv[3]
if (frequencyPath) {
  for (const line of readText(frequencyPath).split(/\r?\n/u)) {
    const word = line.split(/\s+/u)[0]
    if (!word || word.length < 2) continue
    if (!/^[А-Яа-яЁё]+$/u.test(word)) continue
    frequency.push(word.toLowerCase())
  }
}

const started = performance.now()
const engine = createEngine({ dic, aff, frequency })
const buildMs = performance.now() - started
console.log('stats:', engine.stats(), `frequency=${frequency.length} build=${buildMs.toFixed(0)}ms`)

const listPath = process.argv[2]
if (!listPath) process.exit(0)
const all = readText(listPath).split(/\r?\n/u).filter(Boolean)
console.log('word list:', all.length, 'first:', JSON.stringify(all.slice(0, 3)))

const sample = []
const step = Math.max(1, Math.floor(all.length / 12000))
for (let i = 0; i < all.length; i += step) sample.push(all[i])
let checked = 0
let accepted = 0
const rejected = []
const t0 = performance.now()
for (const word of sample) {
  if (!isCheckableWord(word)) continue
  checked += 1
  if (engine.check(word)) accepted += 1
  else if (rejected.length < 80) rejected.push(word)
}
const elapsed = performance.now() - t0
console.log(`coverage: ${accepted}/${checked} = ${(accepted / checked * 100).toFixed(2)}%`
  + ` (${(elapsed / Math.max(1, checked) * 1000).toFixed(1)}µs/слово)`)
console.log('rejected sample:', rejected.join(', '))

console.log('\n--- подсказки (полный поиск) ---')
const misspellings = [
  'привте', 'сабака', 'карова', 'малоко', 'пажалуйста', 'исправленние', 'орфографияя',
  'программис', 'слвоа', 'синхранизация', 'добовлять', 'варрианты', 'подсвечиваються',
  'отабражение', 'страка', 'кнпока', 'соообщение', 'правельно', 'поялвяется',
]
const t1 = performance.now()
for (const word of misspellings) {
  const suggestions = engine.suggest(word)
  console.log(`${word} -> ${suggestions.map(item => `${item.word}(${item.distance})`).join(', ')}`)
}
const suggestMs = performance.now() - t1
console.log(`suggest deep avg = ${(suggestMs / misspellings.length).toFixed(1)}ms/слово`)

const t2 = performance.now()
for (const word of misspellings) engine.shouldFlag(word)
console.log(`shouldFlag avg = ${((performance.now() - t2) / misspellings.length).toFixed(2)}ms/слово`)

console.log('\n--- контроль на осмысленном тексте (ложные срабатывания) ---')
const prose = `Можешь мне сделать плагин для DSH проверка орфографии чтобы можно было
выбирать варианты слов в чате которые подсвечиваются красной волной? Я открываю сессию,
пишу запрос, и модель отвечает подробно. Иногда я печатаю быстро и делаю опечатки,
поэтому хочу видеть подчёркнутые слова и исправлять их правой кнопкой мыши.
Словарь должен знать про компьютер, музыку, датабанк, эквайринг, маркетплейс,
логистику, недвижимость и прочие рабочие термины. Вчера встречался с Нуриевым
в Екатеринбурге, обсуждали маржинальность и кэшбэк.`
const flagged = prose.split(/[^А-Яа-яЁё]+/u).filter(Boolean).filter(word => engine.shouldFlag(word))
console.log('flagged:', flagged.join(', ') || '(нет)')
