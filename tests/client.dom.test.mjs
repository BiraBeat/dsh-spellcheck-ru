/**
 * Проверка связки «текст → подсветка → правая кнопка → замена».
 *
 * В реальном приложении этот путь не виден ни тестам, ни агенту: чат живёт в
 * браузерном окне пользователя. Поэтому здесь он исполняется на ручных
 * заглушках узлов и событий — проверяется именно наша логика (смещения слов,
 * создание диапазонов, обработчик contextmenu, применение замены), а не
 * вёрстка интерфейса.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const CHAT = '[data-conversation-region="chat"]'
const COMPOSER_INPUT = '[data-composer-input]'
const SKIP = 'pre, code, kbd, samp, script, style, textarea, input, select, option, [contenteditable="false"], [data-spellcheck-skip]'

/**
 * Заглушка поля ввода композера: contenteditable с атрибутом spellcheck.
 */
function composerHost() {
  const attributes = new Map()
  const host = {
    kind: 'composer',
    focused: 0,
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null },
    setAttribute(name, value) { attributes.set(name, value) },
    removeAttribute(name) { attributes.delete(name) },
    focus() { host.focused += 1 },
    closest(selector) {
      if (selector === SKIP) return null
      if (selector === COMPOSER_INPUT) return host
      if (selector === CHAT) return { kind: 'chat' }
      return null
    },
  }
  return host
}

/** Минимальный элемент: плагину нужен только closest(). */
function element(kind, host = null) {
  return {
    kind,
    closest(selector) {
      if (selector === SKIP) return null
      if (selector === COMPOSER_INPUT) return host
      if (selector === CHAT) return kind === 'chat' || host !== null ? { kind: 'chat' } : null
      return null
    },
  }
}

/** Текстовый узел с поведением, которого ждёт плагин. */
function textNode(value, host = null) {
  return {
    nodeType: 3,
    nodeValue: value,
    parentElement: element(host === null ? 'chat' : 'composer', host),
    isConnected: true,
  }
}

function createRangeStub() {
  return {
    startContainer: null,
    startOffset: 0,
    endContainer: null,
    endOffset: 0,
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
  }
}

const state = {
  textNodes: [],
  ranges: [],
  highlights: [],
  listeners: [],
  styleAppended: [],
  observerCallback: null,
  caretPoint: null,
  composers: [],
  execCommands: [],
  selection: null,
}

const fakeDocument = {
  head: { appendChild(node) { state.styleAppended.push(node) } },
  body: {},
  createElement() {
    return { textContent: '', setAttribute() {}, remove() { this.removed = true } }
  },
  querySelectorAll(selector) {
    if (selector === CHAT) return [{ kind: 'chat' }]
    if (selector === COMPOSER_INPUT) return state.composers
    return []
  },
  /** Среда редактирования: плагин заменяет слово штатной командой вставки. */
  execCommand(command, _ui, value) {
    state.execCommands.push({ command, value })
    return true
  },
  createRange() {
    const range = createRangeStub()
    state.ranges.push(range)
    return range
  },
  createTreeWalker(_root, _what, filter) {
    let index = 0
    return {
      nextNode() {
        while (index < state.textNodes.length) {
          const node = state.textNodes[index]
          index += 1
          if (filter.acceptNode(node) === 1) return node
        }
        return null
      },
    }
  },
  caretRangeFromPoint() {
    // Возвращает позицию «каретки» там, где тест попросил кликнуть.
    if (state.caretPoint === null) return null
    const range = createRangeStub()
    range.startContainer = state.caretPoint.node
    range.startOffset = state.caretPoint.offset
    return range
  },
  addEventListener(type, handler) { state.listeners.push({ type, handler }) },
  removeEventListener() {},
}

const openCalls = []
const notices = []
let registeredContribution = null

const savedGlobals = {}

before(() => {
  const globals = {
    window: {
      __ModuleLoader__: { load(definition) { state.definition = definition } },
      atob: value => Buffer.from(value, 'base64').toString('binary'),
      localStorage: { getItem: () => null, setItem() {} },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      Highlight: class Highlight {
        constructor(...ranges) { this.ranges = ranges }
      },
      /** Выделение в поле ввода: плагин ставит его перед заменой слова. */
      getSelection() {
        return state.selection
      },
    },
    document: fakeDocument,
    MutationObserver: class MutationObserver {
      constructor(callback) { state.observerCallback = callback }
      observe() {}
      disconnect() { state.observerCallback = null }
    },
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: {
      highlights: {
        set(name, highlight) { state.highlights.push({ name, highlight }) },
        delete() {},
      },
    },
    __DSH_SPELLCHECK_PROBE__: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    savedGlobals[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  vm.runInThisContext(source, { filename: 'client.js' })
})

after(() => {
  // Сначала выгружаем плагин: он снимет таймеры и наблюдателей, иначе
  // отложенное сканирование обратится к уже удалённым глобальным заглушкам.
  for (const effect of effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
  delete globalThis.__DSH_SPELLCHECK_PROBE__
  delete globalThis.__dshSpellcheck
})

const effects = []

function applyPlugin() {
  const definition = state.definition
  const plugin = definition.factory(() => { throw new Error('лишний require') })
  const ctx = {
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
    },
    locale: {
      register() { return () => {} },
      bind: () => key => key,
    },
    contextMenus: {
      register(contribution) { registeredContribution = contribution; return () => {} },
      notify(text, success, action) { notices.push({ text, success, action }) },
      open(target, point) { openCalls.push({ target, point }) },
    },
  }
  plugin.apply(ctx)
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('подсветка: диапазон создаётся только для слова с опечаткой', async () => {
  const node = textNode('Привет, как дила? Всё хорошо')
  state.textNodes.push(node)
  applyPlugin()
  // Словарь распаковывается асинхронно, затем сканирование ставится в очередь.
  await sleep(1400)
  state.observerCallback?.()
  await sleep(300)
  assert.ok(state.highlights.length > 0, 'набор подсветки должен быть установлен')
  const last = state.highlights.at(-1)
  assert.equal(last.name, 'dsh-spellcheck-error')
  assert.equal(last.highlight.ranges.length, 1, '«дила» — единственная опечатка в строке')
  const range = last.highlight.ranges[0]
  assert.equal(range.startContainer, node)
  assert.equal(node.nodeValue.slice(range.startOffset, range.endOffset), 'дила')
})

test('правая кнопка по опечатке открывает меню с вариантами', async () => {
  assert.equal(state.listeners.filter(listener => listener.type === 'contextmenu').length, 1)
  const handler = state.listeners.find(listener => listener.type === 'contextmenu').handler
  const node = state.textNodes[0]
  const offset = node.nodeValue.indexOf('дила') + 2
  state.caretPoint = { node, offset }
  let prevented = false
  handler({ clientX: 40, clientY: 60, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'свой contextmenu нужно отменить, иначе хост закроет меню')
  assert.equal(openCalls.length, 1)
  assert.equal(openCalls[0].target.kind, 'dshSpellcheckWord')
  assert.equal(openCalls[0].target.value.word, 'дила')
  assert.deepEqual(openCalls[0].point, { x: 40, y: 60 })

  const actions = registeredContribution.resolve(openCalls[0].target.value, new AbortController().signal)
  const labels = actions.map(action => action.label)
  assert.ok(labels.includes('дела'), `ожидалась подсказка «дела», получено: ${labels.join(', ')}`)
})

test('выбор варианта меняет показанный текст и уведомляет с отменой', async () => {
  const node = state.textNodes[0]
  // Меню получает JSON-цель { word, occurrence }: сборка действия должна взять
  // именно то вхождение, по которому кликнули.
  const actions = registeredContribution.resolve(openCalls[0].target.value, new AbortController().signal)
  const apply = actions.find(action => action.label === 'дела')
  assert.ok(apply, 'должно быть действие «дела»')
  apply.run()
  assert.equal(node.nodeValue, 'Привет, как дела? Всё хорошо')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].success, true)
  assert.equal(typeof notices[0].action.run, 'function', 'у уведомления должна быть отмена')
  // Отмена возвращает исходное слово.
  notices[0].action.run()
  assert.equal(node.nodeValue, 'Привет, как дила? Всё хорошо')
})

test('клик по верному слову не открывает меню', () => {
  const handler = state.listeners.find(listener => listener.type === 'contextmenu').handler
  const node = state.textNodes[0]
  state.caretPoint = { node, offset: node.nodeValue.indexOf('Привет') + 2 }
  const before = openCalls.length
  let prevented = false
  handler({ clientX: 10, clientY: 10, preventDefault() { prevented = true } })
  assert.equal(prevented, false, 'корректное слово не перехватывает событие')
  assert.equal(openCalls.length, before)
})

test('правый клик перехватывается на pointerdown и меню не открывается дважды', () => {
  const node = state.textNodes[0]
  const offset = node.nodeValue.indexOf('дила') + 2
  state.caretPoint = { node, offset }
  const before = openCalls.length
  const down = state.listeners.find(listener => listener.type === 'pointerdown')
  assert.ok(down, 'обработчик pointerdown должен быть зарегистрирован')
  let prevented = false
  down.handler({ button: 2, clientX: 50, clientY: 70, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'нативное меню Electron нужно отменять на pointerdown')
  assert.equal(openCalls.length, before + 1)

  // Следом Chromium всё же присылает contextmenu: меню не должно переоткрыться.
  const menu = state.listeners.find(listener => listener.type === 'contextmenu').handler
  let preventedContext = false
  menu({ clientX: 50, clientY: 70, preventDefault() { preventedContext = true } })
  assert.equal(preventedContext, true)
  assert.equal(openCalls.length, before + 1, 'повторный contextmenu не переоткрывает меню')

  // Левая кнопка ничего не перехватывает.
  let leftPrevented = false
  down.handler({ button: 0, clientX: 50, clientY: 70, preventDefault() { leftPrevented = true } })
  assert.equal(leftPrevented, false)
  assert.equal(openCalls.length, before + 1)
})

test('поле ввода: подсветка, меню и замена слова штатной командой', async () => {
  // Пользователь печатает в композере: contenteditable под управлением Lexical.
  const host = composerHost()
  state.composers.push(host)
  const node = textNode('привте друг', host)
  state.textNodes.push(node)

  state.observerCallback?.()
  await new Promise(resolve => setTimeout(resolve, 250))

  // 1. Слово с опечаткой подсвечено и в поле ввода.
  const last = state.highlights.at(-1)
  const composerRange = last.highlight.ranges.find(range => range.startContainer === node)
  assert.ok(composerRange, 'в поле ввода тоже должен быть диапазон')
  assert.equal(node.nodeValue.slice(composerRange.startOffset, composerRange.endOffset), 'привте')
  // 2. Встроенная проверка Chromium отключена, иначе волн было бы две.
  assert.equal(host.getAttribute('spellcheck'), 'false')

  // 3. Правая кнопка открывает наше меню, а не нативное.
  const handler = state.listeners.find(listener => listener.type === 'contextmenu').handler
  state.caretPoint = { node, offset: 2 }
  const before = openCalls.length
  let prevented = false
  handler({ clientX: 12, clientY: 34, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(openCalls.length, before + 1)
  const target = openCalls.at(-1).target
  assert.equal(target.value.word, 'привте')

  // 4. Выбор варианта идёт через execCommand и выделение ровно одного слова.
  const rangesBefore = state.ranges.length
  state.selection = {
    removeAllRanges() { this.removed = true },
    addRange(range) { state.selectedRange = range },
  }
  const actions = registeredContribution.resolve(target.value, new AbortController().signal)
  const apply = actions.find(action => action.label === 'привет')
  assert.ok(apply, `ожидалась подсказка «привет», получено: ${actions.map(a => a.label).join(', ')}`)
  apply.run()
  assert.equal(state.ranges.length, rangesBefore + 1, 'перед заменой создаётся диапазон слова')
  assert.equal(state.selectedRange.startContainer, node)
  assert.equal(state.selectedRange.startOffset, 0)
  assert.equal(state.selectedRange.endOffset, 6)
  assert.deepEqual(state.execCommands.at(-1), { command: 'insertText', value: 'привет' })
  assert.equal(host.focused, 1, 'поле ввода получает фокус перед вставкой')

  // 5. Уведомление без кнопки отмены: в редакторе работает свой Ctrl+Z.
  const notice = notices.at(-1)
  assert.equal(notice.success, true)
  assert.equal(notice.action, undefined)
})
