/**
 * Проверка упаковки плагина как отображения и как данных.
 *
 * Ошибки в манифесте не видны в консоли браузера: Plugin Manager молча
 * показывает запасную иконку или диагностику вместо описания. Поэтому
 * структура, локали, документ деталей и иконка проверяются автоматически.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const readText = path => readFileSync(new URL(path, root), 'utf8')
const readJson = path => JSON.parse(readText(path))

const manifest = readJson('package.json')

test('манифест описывает бандл и клиентскую половину', () => {
  assert.equal(manifest.name, 'dsh-spellcheck-ru')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.private, undefined, 'публикуемый пакет не должен быть private')
  assert.equal(typeof manifest.license, 'string', 'нужна лицензия для публикации')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-context-menu'))
})

test('имя пакета совпадает в манифесте, патче и клиентском артефакте', () => {
  const patch = readText('cordis.patch.yml')
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'строка патча должна называть имя пакета')
  const client = readText('client.js')
  assert.ok(client.includes(`id: '${manifest.name}'`), 'id фабрики в client.js должен совпадать с именем пакета')
  assert.ok(!client.includes('__PACKAGE_NAME__'), 'в артефакте не должно остаться подстановочных маркеров')
})

test('экспорты и список файлов содержат всё, что нужно во время работы', () => {
  const exportsMap = manifest.exports
  assert.equal(exportsMap['.'], './index.js')
  assert.equal(exportsMap['./client'], './client.js')
  assert.equal(exportsMap['./icon'], './icon.svg')
  assert.ok(exportsMap['./locale/*.json'], 'локали должны экспортироваться по маске')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'docs', 'icon.svg']) {
    assert.ok(manifest.files.includes(required), `в files нет ${required}`)
  }
})

test('патч вставляет ровно одну строку плагина с тем же именем', () => {
  const patch = readText('cordis.patch.yml')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-spellcheck/)
  assert.match(patch, /name: 'dsh-spellcheck-ru'/)
  assert.equal((patch.match(/- id:/g) ?? []).length, 1)
})

test('хостовая половина экспортирует apply', () => {
  const source = readText('index.js')
  assert.match(source, /export function apply\(/)
})

test('локали содержат заголовок, описание и корректный документ деталей', () => {
  for (const locale of ['en', 'ru', 'zh']) {
    const data = readJson(`locale/${locale}.json`)
    assert.equal(typeof data.meta.title, 'string', `${locale}: meta.title`)
    assert.equal(typeof data.meta.description, 'string', `${locale}: meta.description`)
    assert.ok(data.meta.description.length > 80, `${locale}: описание должно объяснять работу и ограничения`)
    if (data.meta.detail !== undefined) {
      const path = data.meta.detail
      assert.match(path, /^docs\/[A-Za-z0-9._-]+\.md$/)
      assert.ok(existsSync(new URL(path, root)), `${locale}: нет файла ${path}`)
    }
  }
  // Английский и русский документы обязательны: это языки автора запроса.
  assert.equal(readJson('locale/en.json').meta.detail, 'docs/DETAIL.md')
  assert.equal(readJson('locale/ru.json').meta.detail, 'docs/DETAIL.ru.md')
})

test('документ деталей содержит ровно одно изображение', () => {
  for (const path of ['docs/DETAIL.md', 'docs/DETAIL.ru.md']) {
    const text = readText(path).trim()
    const images = text.match(/!\[[^\]]+\]\([^)]+\)/g) ?? []
    assert.equal(images.length, 1, `${path}: ожидалось одно изображение`)
    assert.equal(text, images[0], `${path}: кроме изображения ничего быть не должно`)
    const image = images[0].match(/\]\(([^)]+)\)/)[1]
    assert.ok(existsSync(new URL(`docs/${image}`, root)), `${path}: нет файла docs/${image}`)
  }
})

test('иконка и превью — корректная разметка SVG без скриптов и текста', () => {
  for (const path of ['icon.svg', 'docs/preview.svg']) {
    const svg = readText(path)
    const size = statSync(new URL(path, root)).size
    assert.ok(size < 256 * 1024, `${path}: слишком большой файл`)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.match(svg, /viewBox="0 0 \d+ \d+"/)
    assert.doesNotMatch(svg, /<script/i, `${path}: скрипты запрещены`)
    assert.doesNotMatch(svg, /<style/i, `${path}: встроенные стили запрещены`)
    assert.doesNotMatch(svg, /<text/i, `${path}: текст должен быть путями или отсутствовать`)
    assert.doesNotMatch(svg, /<foreignObject/i)
    assert.doesNotMatch(svg, /<image/i)
    assert.doesNotMatch(svg, /\son[a-z]+=/i, `${path}: обработчики событий запрещены`)
    // Проверка сбалансированности — грубый, но полезный признак валидного XML.
    const opens = (svg.match(/<([a-zA-Z]+)(\s|>|\/)/g) ?? []).length
    const closes = (svg.match(/<\/[a-zA-Z]+>/g) ?? []).length + (svg.match(/\/>/g) ?? []).length
    assert.equal(opens, closes, `${path}: незакрытые теги`)
  }
  assert.match(readText('icon.svg'), /width="36" height="36"/)
  assert.match(readText('docs/preview.svg'), /width="640" height="300"/)
})

test('клиентский артефакт собран и не требует сети', () => {
  const source = readText('client.js')
  assert.ok(statSync(new URL('client.js', root)).size > 500_000, 'client.js должен содержать вшитый словарь')
  assert.match(source, /window\.__ModuleLoader__\.load/)
  assert.match(source, /id: 'dsh-spellcheck-ru'/)
  assert.match(source, /dsh-spellcheck-error/)
  // Никаких сетевых загрузок: словарь приходит внутри файла.
  assert.doesNotMatch(source, /fetch\(\s*['"`]https?:/)
  assert.doesNotMatch(source, /XMLHttpRequest/)
})
