/**
 * Сборка клиентского артефакта плагина.
 *
 * Что делает:
 *  1) сжимает словарь (ru_RU.dic, ru_RU.aff) и список частотных слов в gzip;
 *  2) вшивает их вместе с ядром src/spellcore.mjs в src/client.template.js;
 *  3) пишет готовый client.js — единственный файл, который загружает браузер.
 *
 * Зачем вшивать: клиентский модуль DSH — это один самоисполняемый артефакт,
 * у него нет доступа к файловой системе и к произвольным URL пакета
 * (маршрут ассетов отдаёт только изображения), поэтому данные должны ехать
 * внутри файла. gzip обязателен: 3.3 МБ словаря в base64 иначе превратились
 * бы в 4.6 МБ кода.
 *
 * Запуск: node tools/build.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createEngine } from '../src/spellcore.mjs'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const readBytes = path => readFileSync(new URL(path, root))

const dicText = read('tools/vendor/ru_RU.dic')
const affText = read('tools/vendor/ru_RU.aff')

// Имя пакета — единственный источник правды: загрузчик клиентских модулей
// требует, чтобы id фабрики совпадал с именем пакета, а переименование пакета
// (например, перед публикацией) не должно требовать правки шаблона руками.
const packageName = JSON.parse(read('package.json')).name

/**
 * Список частотных слов: нужен только для порядка подсказок.
 * Оставляем слова, которые сам движок считает корректными — иначе в меню
 * могло бы всплыть «правильное» слово, которого нет в словаре.
 */
const frequencyRaw = read('tools/vendor/ru_50k.txt')
const probe = createEngine({ dic: dicText, aff: affText })
const frequency = []
const seenFrequency = new Set()
for (const line of frequencyRaw.split(/\r?\n/u)) {
  const word = line.split(/\s+/u)[0]
  if (!word || !/^[А-Яа-яЁё]+$/u.test(word)) continue
  const lower = word.toLowerCase()
  if (lower.length < 3 || seenFrequency.has(lower)) continue
  if (!probe.check(lower)) continue
  seenFrequency.add(lower)
  frequency.push(lower)
}

const gzipBase64 = text => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64')

const dicB64 = gzipBase64(dicText)
const affB64 = gzipBase64(affText)
const freqB64 = gzipBase64(frequency.join('\n'))

// Ядро вшивается как обычный код: убираем ключевые слова export, оставляя
// объявления в области видимости фабрики.
let spellcore = read('src/spellcore.mjs')
spellcore = spellcore.replace(/^export (?=const |function |class |async function )/gmu, '')
if (/^export /mu.test(spellcore)) throw new Error('spellcore still exports after stripping')
if (/^\s*import /mu.test(spellcore)) throw new Error('spellcore must not import other modules')

let client = read('src/client.template.js')
const replaceOnce = (haystack, needle, replacement) => {
  const index = haystack.indexOf(needle)
  if (index < 0) throw new Error(`placeholder ${needle} not found`)
  if (haystack.indexOf(needle, index + needle.length) >= 0) throw new Error(`placeholder ${needle} is not unique`)
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length)
}

client = replaceOnce(client, '/*__SPELLCORE__*/', spellcore.trimEnd())
client = replaceOnce(client, '/*__DIC_B64__*/', dicB64)
client = replaceOnce(client, '/*__AFF_B64__*/', affB64)
client = replaceOnce(client, '/*__FREQ_B64__*/', freqB64)
if (!client.includes('__PACKAGE_NAME__')) throw new Error('client template lost the __PACKAGE_NAME__ placeholder')
client = client.split('__PACKAGE_NAME__').join(packageName)
if (client.includes('__PACKAGE_NAME__')) throw new Error('package name substitution left placeholders')

const banner = '/* Собрано tools/build.mjs из src/client.template.js и src/spellcore.mjs. Не править вручную. */\n'
writeFileSync(new URL('client.js', root), banner + client, 'utf8')

/**
 * Штамп сборки: хэши исходников, из которых получен артефакт.
 *
 * Побайтовое сравнение client.js между машинами невозможно: gzip-поток зависит
 * от платформы и версии zlib, поэтому CI на Linux не совпадёт с локальной
 * сборкой на Windows. Штамп зависит только от входных данных, поэтому годится
 * для проверки «артефакт устарел, пересоберите».
 */
const sha256 = path => createHash('sha256').update(readBytes(path)).digest('hex')
const sourceFiles = [
  'package.json',
  'src/client.template.js',
  'src/spellcore.mjs',
  'tools/vendor/ru_RU.aff',
  'tools/vendor/ru_RU.dic',
  'tools/vendor/ru_50k.txt',
]
const manifest = JSON.parse(read('package.json'))
const stamp = {
  packageName,
  version: manifest.version,
  sources: Object.fromEntries(sourceFiles.map(file => [file, sha256(file)])),
}
writeFileSync(new URL('build-stamp.json', root), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')

const size = statSync(new URL('client.js', root)).size
console.log('frequency words:', frequency.length)
console.log('dic gz+b64:', (dicB64.length / 1048576).toFixed(2), 'MB')
console.log('aff gz+b64:', (affB64.length / 1024).toFixed(0), 'KB')
console.log('freq gz+b64:', (freqB64.length / 1024).toFixed(0), 'KB')
console.log('client.js:', (size / 1048576).toFixed(2), 'MB')
