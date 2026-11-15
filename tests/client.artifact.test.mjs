/**
 * Тесты собранного клиентского артефакта (client.js).
 *
 * Проверяем то, что нельзя проверить в ядре:
 *  - артефакт исполняется как модуль загрузчика и отдаёт фабрику с верным id;
 *  - фабрика возвращает плагин с нужными зависимостями (inject);
 *  - вшитый словарь реально распаковывается (gzip+base64) и движок строится;
 *  - меню правой кнопки возвращает русские варианты замены;
 *  - регистрации (стиль, меню, локаль, наблюдатель) отпускаются при выгрузке.
 *
 * DOM подменён минимальными заглушками: цель теста — контракт плагина и
 * распаковка данных, а не проверка вёрстки чата.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const packageName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name

/** Заглушка DOM: ровно те методы, которые использует плагин. */
function createDomStub() {
  const appended = []
  const listeners = []
  const style = { textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value }, remove() { this.removed = true } }
  const document = {
    head: { appendChild(node) { appended.push(node) } },
    body: {},
    createElement() { return style },
    querySelectorAll() { return [] },
    createRange() { return { setStart() {}, setEnd() {}, startContainer: null, endContainer: null } },
    caretRangeFromPoint() { return null },
    addEventListener(type, handler) { listeners.push({ type, handler }) },
    removeEventListener(type, handler) {
      const index = listeners.findIndex(item => item.type === type && item.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  return { document, style, appended, listeners }
}

/** Минимальное хранилище вместо localStorage. */
function createStorageStub() {
  const data = new Map()
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null },
    setItem(key, value) { data.set(key, String(value)) },
  }
}

const dom = createDomStub()
const storage = createStorageStub()
const highlightSets = []
let definition = null
const savedGlobals = {}

before(() => {
  // Плагин написан для браузера и обращается к глобальным объектам напрямую,
  // поэтому подменяем их на время теста и возвращаем назад в after().
  const globals = {
    window: {
      __ModuleLoader__: { load(loaded) { definition = loaded } },
      atob: value => Buffer.from(value, 'base64').toString('binary'),
      localStorage: storage,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      Highlight: class Highlight { constructor(...ranges) { this.ranges = ranges } },
    },
    document: dom.document,
    MutationObserver: class MutationObserver {
      constructor(callback) { this.callback = callback }
      observe() { this.observing = true }
      disconnect() { this.observing = false }
    },
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: { highlights: { set(name, highlight) { highlightSets.push({ name, highlight }) }, delete() {} } },
    __DSH_SPELLCHECK_PROBE__: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    savedGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  vm.runInThisContext(source, { filename: 'client.js' })
})

after(() => {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
  delete globalThis.__DSH_SPELLCHECK_PROBE__
  delete globalThis.__dshSpellcheck
})

/** Создать контекст плагина с подменёнными сервисами DSH. */
function createContext() {
  const effects = []
  const locales = {}
  const notices = []
  const registrations = []
  const ctx = {
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    locale: {
      register(namespace, dictionaries) {
        locales[namespace] = dictionaries
        return () => { delete locales[namespace] }
      },
      bind(namespace) {
        return key => locales[namespace]?.ru?.[key] ?? key
      },
    },
    contextMenus: {
      register(contribution) {
        registrations.push(contribution)
        return () => { registrations.pop() }
      },
      notify(text, success, action) { notices.push({ text, success, action }) },
      open() {},
    },
  }
  return { ctx, effects, locales, notices, registrations }
}

async function createAppliedPlugin() {
  const bundle = createContext()
  const plugin = definition.factory(() => { throw new Error('клиент не должен требовать другие модули') })
  plugin.apply(bundle.ctx)
  // Словарь грузится через setTimeout(150); ждём с запасом.
  await new Promise(resolve => setTimeout(resolve, 1200))
  return { plugin, ...bundle }
}

test('фабрика загружается под правильным id и отдаёт контракт плагина', () => {
  assert.ok(definition, 'модуль должен вызвать __ModuleLoader__.load')
  assert.equal(definition.id, packageName, 'id фабрики обязан совпадать с именем пакета')
  assert.equal(typeof definition.factory, 'function')
  const plugin = definition.factory(() => { throw new Error('лишний require') })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['contextMenus', 'locale'])
})

test('стиль подсветки содержит волнистое подчёркивание и токен темы', async () => {
  await createAppliedPlugin()
  const style = dom.appended.at(-1)
  assert.ok(style, 'стиль должен быть добавлен в head')
  const css = style.textContent
  assert.match(css, /::highlight\(dsh-spellcheck-error\)/)
  assert.match(css, /text-decoration-style:\s*wavy/)
  assert.match(css, /--dsw-alias-state-error-primary/)
})

test('локаль регистрируется с русским словарём', async () => {
  const { locales } = await createAppliedPlugin()
  assert.ok(locales.dshSpellcheck, 'пространство имён dshSpellcheck должно быть зарегистрировано')
  assert.equal(locales.dshSpellcheck.ru.addToDictionary, 'Добавить в словарь')
  assert.equal(typeof locales.dshSpellcheck.en.suggestHeader, 'string')
})

test('словарь распаковался и меню предлагает русские варианты', async () => {
  const { registrations } = await createAppliedPlugin()
  assert.equal(registrations.length, 1)
  const contribution = registrations[0]
  assert.equal(contribution.target, 'dshSpellcheckWord')
  const actions = await contribution.resolve({ word: 'привте' }, new AbortController().signal)
  assert.ok(Array.isArray(actions) && actions.length > 2)
  const labels = actions.map(action => action.label)
  assert.ok(labels.includes('привет'), `ожидалась подсказка «привет», получено: ${labels.join(', ')}`)
  assert.ok(labels.includes('Добавить в словарь'))
  assert.ok(labels.includes('Пропустить до перезагрузки'))
  assert.equal(actions[0].disabled, true, 'заголовок «Заменить на» не должен быть кликабельным')
  // Применение подсказки без реального узла не должно бросать исключение.
  await actions.find(action => action.id === 'apply-0').run()
})

test('добавление в словарь сохраняется в localStorage', async () => {
  const { registrations } = await createAppliedPlugin()
  const actions = await registrations[0].resolve({ word: 'квазипроцессинг' }, new AbortController().signal)
  const add = actions.find(action => action.id === 'add-dictionary')
  assert.ok(add, 'должно быть действие «Добавить в словарь»')
  add.run()
  const stored = JSON.parse(storage.getItem('dsh.spellcheck.userWords') ?? '[]')
  assert.ok(stored.includes('квазипроцессинг'), `в словаре должно быть слово, получено: ${stored.join(', ')}`)
})

test('регистрации отпускаются при выгрузке плагина', async () => {
  const { effects } = await createAppliedPlugin()
  assert.ok(effects.length >= 3)
  assert.deepEqual(effects.map(effect => effect.label), [
    'spellcheck: locale', 'spellcheck: context menu', 'spellcheck: highlight lifetime',
  ])
  for (const effect of effects) assert.equal(typeof effect.cleanup, 'function')
  // Выгрузка не должна бросать исключений.
  for (const effect of effects) effect.cleanup()
  assert.equal(dom.appended.at(-1).removed, true, 'стиль должен быть удалён из документа')
})

test('вспомогательные функции отдают ожидаемые значения', () => {
  const internals = globalThis.__dshSpellcheck
  assert.ok(internals, 'отладочный контракт должен быть доступен')
  assert.equal(internals.matchCase('Сабака', 'собака'), 'Собака')
  assert.equal(internals.matchCase('САБАКА', 'собака'), 'СОБАКА')
  assert.equal(internals.wordKey('Ёлка'), 'елка')
  assert.deepEqual(internals.tokenize('привте друг').map(token => token.start), [0, 7])
})
