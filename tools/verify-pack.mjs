/**
 * Проверка публикуемого пакета.
 *
 * Ошибка в `files` или забытый `npm run build` ломают установку у чужих людей,
 * а не у автора — локальная линкованная установка видит все файлы каталога.
 * Поэтому перед публикацией проверяется именно то, что попадёт в tarball.
 *
 * Режимы:
 *  - `node tools/verify-pack.mjs --self` — проверить каталог пакета как есть
 *    (используется в prepublishOnly) и заодно убедиться, что client.js
 *    новее исходников;
 *  - `node tools/verify-pack.mjs` — собрать настоящий tarball (`npm pack`),
 *    распаковать во временный каталог и проверить только его содержимое.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packageDir = resolve(import.meta.dirname, '..')
const selfMode = process.argv.includes('--self')

/** Список проблем; пустой список означает готовность к публикации. */
const problems = []
const notes = []
const fail = message => problems.push(message)
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const bytes = path => statSync(path).size
const exists = path => existsSync(path)

/**
 * Проверить один каталог пакета (каталог или распакованный tarball).
 * @param {string} dir
 * @param {{ requireFreshArtifact: boolean }} options
 */
function verifyDirectory(dir, options) {
  const manifestPath = join(dir, 'package.json')
  if (!exists(manifestPath)) {
    fail('нет package.json')
    return
  }
  const manifest = readJson(manifestPath)
  const name = manifest.name

  // 1. Публикуемый манифест.
  if (typeof name !== 'string' || name.length === 0) fail('package.json: пустое имя')
  if (manifest.private === true) fail('package.json: private=true — npm откажется публиковать')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/u.test(manifest.version)) {
    fail('package.json: version должна быть вида 1.2.3')
  }
  if (manifest.license === undefined) fail('package.json: не указана license')
  if (manifest.exports?.['./client'] !== './client.js') fail('package.json: экспорт ./client обязателен')
  if (manifest.exports?.['.'] !== './index.js') fail('package.json: экспорт "." обязателен')
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch обязателен')
  if (manifest.dsh?.client?.platform !== 'web') fail('package.json: dsh.client.platform должен быть web')
  if (manifest.dsh?.client?.immediately !== true) fail('package.json: dsh.client.immediately должен быть true')

  // 2. Строка патча должна называть именно этот пакет.
  const patchPath = join(dir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  if (!exists(patchPath)) fail('нет cordis.patch.yml (указан в dsh.bundle.patch)')
  else {
    const patch = readFileSync(patchPath, 'utf8')
    if (!patch.includes(`name: '${name}'`) && !patch.includes(`name: "${name}"`)) {
      fail(`cordis.patch.yml: строка плагина должна называться ${name}`)
    }
    if (!/(- insert:|id: dsh-spellcheck)/u.test(patch)) fail('cordis.patch.yml: нет вставки строки плагина')
  }

  // 3. Хостовая половина.
  const hostPath = join(dir, manifest.exports?.['.'] ?? 'index.js')
  if (!exists(hostPath)) fail('нет index.js')
  else if (!/export function apply\(/u.test(readFileSync(hostPath, 'utf8'))) fail('index.js: нет export function apply()')

  // 4. Клиентский артефакт: собран, содержит словарь и совпадает с именем пакета.
  const clientPath = join(dir, manifest.exports?.['./client'] ?? 'client.js')
  if (!exists(clientPath)) fail('нет client.js — запустите node tools/build.mjs')
  else {
    const client = readFileSync(clientPath, 'utf8')
    if (bytes(clientPath) < 500_000) fail('client.js подозрительно мал: похоже, словарь не вшит')
    if (!client.includes('window.__ModuleLoader__.load')) fail('client.js: нет вызова __ModuleLoader__.load')
    if (!client.includes(`id: '${name}'`)) fail(`client.js: id модуля должен быть ${name} (пересоберите)`)
    if (!client.includes('dsh-spellcheck-error')) fail('client.js: нет набора подсветки')
    if (/__PACKAGE_NAME__|__SPELLCORE__|__DIC_B64__/u.test(client)) fail('client.js: остались подстановочные маркеры')
    notes.push(`client.js: ${(bytes(clientPath) / 1048576).toFixed(2)} MB`)

    // Сборка должна быть свежее исходников, иначе в пакет уедет старая логика.
    if (options.requireFreshArtifact) {
      const clientTime = statSync(clientPath).mtimeMs
      for (const source of ['src/client.template.js', 'src/spellcore.mjs', 'package.json']) {
        const sourcePath = join(dir, source)
        if (exists(sourcePath) && statSync(sourcePath).mtimeMs > clientTime) {
          fail(`${source} новее client.js — запустите node tools/build.mjs`)
        }
      }
      const stampPath = join(dir, 'build-stamp.json')
      if (!exists(stampPath)) fail('нет build-stamp.json — запустите node tools/build.mjs')
      else {
        const stamp = readJson(stampPath)
        if (stamp.packageName !== name) fail('build-stamp.json: имя пакета не совпадает с манифестом')
        if (stamp.version !== manifest.version) fail('build-stamp.json: версия не совпадает с манифестом')
      }
    }
  }

  // 5. Локали и документ деталей.
  const locales = ['en', 'ru', 'zh']
  for (const locale of locales) {
    const path = join(dir, 'locale', `${locale}.json`)
    if (!exists(path)) {
      fail(`нет locale/${locale}.json`)
      continue
    }
    let data
    try {
      data = readJson(path)
    } catch {
      fail(`locale/${locale}.json: некорректный JSON`)
      continue
    }
    if (typeof data.meta?.title !== 'string' || data.meta.title.length === 0) fail(`locale/${locale}.json: нет meta.title`)
    if (typeof data.meta?.description !== 'string' || data.meta.description.length < 80) {
      fail(`locale/${locale}.json: meta.description должен объяснять работу и ограничения`)
    }
    if (data.meta?.detail !== undefined && !exists(join(dir, data.meta.detail))) {
      fail(`locale/${locale}.json: meta.detail указывает на отсутствующий ${data.meta.detail}`)
    }
  }
  for (const file of ['docs/DETAIL.md', 'docs/DETAIL.ru.md']) {
    const path = join(dir, file)
    if (!exists(path)) {
      fail(`нет ${file}`)
      continue
    }
    const text = readFileSync(path, 'utf8').trim()
    const images = text.match(/!\[[^\]]+\]\(([^)]+)\)/g) ?? []
    if (images.length !== 1) fail(`${file}: ожидалось ровно одно изображение`)
    const target = images[0]?.match(/\]\(([^)]+)\)/)?.[1]
    if (target !== undefined && !exists(join(dir, 'docs', target))) fail(`${file}: нет файла docs/${target}`)
  }

  // 6. Иконка.
  const iconPath = join(dir, 'icon.svg')
  if (!exists(iconPath)) fail('нет icon.svg')
  else {
    if (bytes(iconPath) > 256 * 1024) fail('icon.svg больше 256 KiB')
    const svg = readFileSync(iconPath, 'utf8')
    if (!/^<svg /u.test(svg)) fail('icon.svg: файл не похож на SVG')
    if (/<script|<foreignObject|<image/iu.test(svg)) fail('icon.svg: недопустимые элементы')
  }

  // 7. Лицензии: своя и на вшитые словари.
  for (const file of ['LICENSE', 'LICENSES.md']) {
    if (!exists(join(dir, file))) fail(`нет ${file} — требуется для публикации со вшитым словарём`)
  }

  // 8. В пакете не должно быть исходников словаря и node_modules.
  const heavy = []
  const walk = (current, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules') {
        fail('в пакете оказался node_modules')
        continue
      }
      const path = join(current, entry)
      const stats = lstatSync(path)
      if (stats.isDirectory()) walk(path, depth + 1)
      else if (stats.size > 1_500_000) heavy.push(`${path.slice(dir.length + 1)} (${(stats.size / 1048576).toFixed(2)} MB)`)
    }
  }
  walk(dir, 0)
  for (const file of heavy) notes.push(`крупный файл: ${file}`)
  notes.push(`версия: ${manifest.version}, строк в патче: ${(exists(patchPath) ? readFileSync(patchPath, 'utf8').split('\n').length - 1 : 0)}`)
}

if (selfMode) {
  verifyDirectory(packageDir, { requireFreshArtifact: true })
} else {
  // Настоящий npm pack: проверяем ровно тот набор файлов, который получат люди.
  const work = mkdtempSync(join(tmpdir(), 'dsh-spellcheck-pack-'))
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  /** Запустить npm; на Windows .cmd требует оболочки, поэтому идём через cmd /c. */
  const runNpm = args => (process.platform === 'win32'
    ? execFileSync('cmd', ['/c', `npm ${args.join(' ')}`], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync(npmBin, args, { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  let tarball = null
  try {
    const output = runNpm(['pack', '--json'])
    const packed = JSON.parse(output)
    tarball = join(packageDir, packed[0].filename)
    notes.push(`tarball: ${packed[0].filename}, файлов: ${packed[0].files.length}, размер: ${(packed[0].size / 1048576).toFixed(2)} MB`)
    execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'ignore' })
    verifyDirectory(join(work, 'package'), { requireFreshArtifact: false })
  } catch (error) {
    fail(`npm pack не удался: ${error.message}`)
  } finally {
    if (tarball !== null) rmSync(tarball, { force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

for (const note of notes) console.log('•', note)
if (problems.length > 0) {
  console.error(`\n✖ Пакет не готов к публикации (${problems.length}):`)
  for (const problem of problems) console.error('  -', problem)
  process.exit(1)
}
console.log(selfMode ? '\n✔ Каталог пакета готов к публикации' : '\n✔ Tarball содержит всё нужное и устанавливается как бандл DSH')
