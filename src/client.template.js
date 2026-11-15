/**
 * Клиентская половина плагина проверки орфографии.
 *
 * Артефакт браузера: модуль регистрирует фабрику в window.__ModuleLoader__,
 * как требует загрузчик клиентских плагинов DSH. Внутрь вшиваются:
 *   - ядро проверки (src/spellcore.mjs, подставляется сборкой),
 *   - словарь ru_RU (.dic/.aff) в gzip+base64 (подставляется сборкой),
 *   - список частотных слов для порядка подсказок.
 *
 * Почему подсветка без изменения DOM:
 * чат рендерит React из журнала сессии, и вставка своих <span> внутрь
 * текстовых узлов ломает согласование (React владеет этими узлами). Поэтому
 * используется CSS Custom Highlight API: диапазоны (Range) подсвечиваются
 * псевдоэлементом ::highlight(), дерево остаётся нетронутым.
 *
 * Почему правка текста только визуальная:
 * сообщения в чате — неизменяемый журнал сессии, плагин не имеет права
 * переписывать его. Исправление применяется к показанному тексту (и
 * запоминается в рамках сессии), что и ожидает пользователь от «исправить
 * слово» в Word-подобном интерфейсе.
 */
window.__ModuleLoader__.load({
  id: '__PACKAGE_NAME__',
  factory(require) {
    'use strict'

    // ------------------------------------------------------------------
    // Ядро проверки орфографии (вшивается сборкой из src/spellcore.mjs).
    // ------------------------------------------------------------------
    /*__SPELLCORE__*/

    // ------------------------------------------------------------------
    // Данные словаря (вшиваются сборкой: gzip + base64).
    // ------------------------------------------------------------------
    const DIC_GZ_BASE64 = '/*__DIC_B64__*/'
    const AFF_GZ_BASE64 = '/*__AFF_B64__*/'
    const FREQ_GZ_BASE64 = '/*__FREQ_B64__*/'

    /** Пространство имён переводов плагина. */
    const NAMESPACE = 'dshSpellcheck'
    /** Имя семейства целей контекстного меню: своё, чтобы не пересечься с хостом. */
    const TARGET_KIND = 'dshSpellcheckWord'
    /** Имя набора подсветки CSS Custom Highlight API. */
    const HIGHLIGHT_NAME = 'dsh-spellcheck-error'
    /** Контейнер чата, который размещает хост (см. ConversationContent.tsx). */
    const CHAT_REGION_SELECTOR = '[data-conversation-region="chat"]'
    /**
     * Поле ввода композера: contenteditable, который принадлежит Lexical.
     *
     * Проверять его тоже нужно — пользователь печатает именно там. Текст
     * подсвечивается через CSS Custom Highlight API (без изменения DOM), а
     * замена слова вставляется штатной командой редактирования, чтобы модель
     * Lexical осталась согласованной.
     */
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
    /** Узлы, внутри которых проверять орфографию бессмысленно или опасно. */
    const SKIP_SELECTOR = [
      'pre', 'code', 'kbd', 'samp', 'script', 'style', 'textarea', 'input',
      'select', 'option', '[contenteditable="false"]', '[data-spellcheck-skip]',
    ].join(',')
    /** Ключ localStorage с пользовательским словарём. */
    const STORAGE_USER = 'dsh.spellcheck.userWords'
    /** Минимальный интервал между пересканированиями текста, мс. */
    const SCAN_INTERVAL_MS = 120
    /** Сколько вариантов замены показывать в меню (остальные не влезают в экран). */
    const MAX_MENU_SUGGESTIONS = 5

    /** Переводы: en и zh — базовые локали DSH, ru — язык пользователя. */
    const DICTIONARIES = {
      en: {
        suggestHeader: 'Replace with',
        addToDictionary: 'Add to dictionary',
        ignoreSession: 'Ignore until reload',
        fixedNotice: 'Word corrected',
        undo: 'Undo',
        failed: 'Action failed',
        unavailable: 'Spell checker is still loading',
      },
      ru: {
        suggestHeader: 'Заменить на',
        addToDictionary: 'Добавить в словарь',
        ignoreSession: 'Пропустить до перезагрузки',
        fixedNotice: 'Слово исправлено',
        undo: 'Отменить',
        failed: 'Не удалось выполнить действие',
        unavailable: 'Проверка орфографии ещё загружается',
      },
      zh: {
        suggestHeader: '替换为',
        addToDictionary: '添加到词典',
        ignoreSession: '刷新前忽略',
        fixedNotice: '已修正单词',
        undo: '撤销',
        failed: '操作失败',
        unavailable: '拼写检查仍在加载',
      },
    }

    // ------------------------------------------------------------------
    // Вспомогательные функции (не зависят от состояния плагина).
    // ------------------------------------------------------------------

    /** Прочитать JSON из localStorage, не падая на испорченном значении. */
    function readStoredList(key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
      } catch {
        return []
      }
    }

    /** Записать список в localStorage; недоступное хранилище не ломает плагин. */
    function writeStoredList(key, list) {
      try {
        window.localStorage.setItem(key, JSON.stringify(list))
      } catch {
        // Приватный режим или запрет хранилища — работаем без сохранения.
      }
    }

    /** base64 → байты (atob есть в браузере, Buffer в бандле недоступен). */
    function base64ToBytes(base64) {
      const binary = window.atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    /**
     * Распаковать gzip и вернуть текст.
     * DecompressionStream есть в Chromium (Electron), но проверяем явно:
     * без него плагин обязан молча выключиться, а не падать с исключением
     * внутри чужого React-дерева.
     */
    async function gunzipText(base64) {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('DecompressionStream is unavailable')
      }
      const bytes = base64ToBytes(base64)
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
      return await new Response(stream).text()
    }

    /** Подогнать регистр замены под исходное слово. */
    function matchCase(original, replacement) {
      if (original === original.toUpperCase()) return replacement.toUpperCase()
      const first = original.charAt(0)
      if (first !== first.toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1)
      return replacement.charAt(0).toLowerCase() + replacement.slice(1)
    }

    /** Ключ сравнения слов: без регистра и с «е» вместо «ё». */
    function wordKey(word) {
      return normalizeYo(word.toLowerCase())
    }

    // ------------------------------------------------------------------
    // Плагин.
    // ------------------------------------------------------------------
    // Ссылка на объект плагина нужна отладочному контракту: внутри метода
    // apply() собственного имени у функции нет.
    let pluginHandle = null
    const plugin = {
      inject: ['contextMenus', 'locale'],
      apply(ctx) {
        /** @type {null | ReturnType<typeof createEngine>} */
        let engine = null
        /** @type {Promise<void> | null} */
        let engineLoading = null
        /** Последнее исправление — для кнопки «Отменить» в уведомлении. */
        let lastFix = null
        /**
         * Открытые вхождения слов: id → текстовый узел и смещения.
         *
         * Меню хоста получает только JSON-совместимую цель ({ word, occurrence }),
         * поэтому сам узел живёт здесь. Так действие применяется именно к тому
         * месту, где кликнули, даже если за время показа меню кликнули ещё раз.
         */
        const occurrences = new Map()
        let occurrenceSeq = 0
        /** Последний открытый жест: защита от двойного открытия меню. */
        let lastOpen = { word: '', at: 0 }
        /**
         * Текстовые узлы → снимок текста и диапазоны (кэш между сканами).
         * Пересоздаётся, когда нужно сбросить кэш целиком: WeakMap нельзя очистить.
         */
        let nodeCache = new WeakMap()
        /** Ставился ли уже набор подсветки (чтобы не пересчитывать её без изменений). */
        let painted = false
        let scanTimer = 0
        /** Хэндл отложенной загрузки словаря: снимается при выгрузке плагина. */
        let loadTimer = 0
        /** Исходное значение spellcheck у полей ввода, которым мы его отключили. */
        const nativeSpellingDisabled = new Map()
        let announcedSpellingOff = false
        let lastScanAt = 0
        let observer = null
        let disposed = false
        let warnedUnsupported = false
        const userWords = new Set(readStoredList(STORAGE_USER).map(word => word.toLowerCase()))
        const ignoredWords = new Set()

        const t = ctx.locale.bind(NAMESPACE)

        /** Сбросить кэш диапазонов (после смены настроек или словаря). */
        const resetNodeCache = () => {
          nodeCache = new WeakMap()
          painted = false
        }

        /** Есть ли в среде CSS Custom Highlight API. */
        const highlightSupported = () => typeof CSS !== 'undefined' && CSS.highlights
          && typeof window.Highlight === 'function'

        const styleElement = document.createElement('style')
        styleElement.setAttribute('data-dsh-spellcheck', '')
        // Подчёркивание рисуется поверх текста, не меняя разметку. Цвет берётся
        // из семантического токена темы, с запасным значением на случай
        // переименования токена в новой версии DSH.
        styleElement.textContent = `::highlight(${HIGHLIGHT_NAME}) {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: var(--dsw-alias-state-error-primary, #e5484d);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-skip-ink: none;
  background-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent);
}`

        /** Загрузить словарь один раз; повторные вызовы ждут тот же промис. */
        const ensureEngine = () => {
          if (engine !== null) return Promise.resolve(engine)
          if (engineLoading !== null) return engineLoading
          engineLoading = (async () => {
            const [dicText, affText, freqText] = await Promise.all([
              gunzipText(DIC_GZ_BASE64),
              gunzipText(AFF_GZ_BASE64),
              gunzipText(FREQ_GZ_BASE64),
            ])
            engine = createEngine({
              dic: dicText,
              aff: affText,
              frequency: freqText.split('\n').filter(Boolean),
              userWords,
              ignore: ignoredWords,
            })
            const stats = engine.stats()
            console.info(`[dsh-spellcheck] dictionary ready: ${stats.stems} stems, ${stats.rules} rules, ${freqText.length} bytes of frequency data`)
            scheduleScan(0)
          })().catch((error) => {
            engineLoading = null
            console.warn('[dsh-spellcheck] dictionary failed to load', error)
          })
          return engineLoading
        }

        /** Запланировать пересканирование с ограничением частоты. */
        function scheduleScan(delay = SCAN_INTERVAL_MS) {
          if (disposed) return
          if (scanTimer !== 0) return
          const wait = Math.max(delay, lastScanAt + SCAN_INTERVAL_MS - Date.now())
          scanTimer = window.setTimeout(() => {
            scanTimer = 0
            lastScanAt = Date.now()
            try {
              scanChat()
            } catch (error) {
              console.warn('[dsh-spellcheck] scan failed', error)
            }
          }, Math.max(0, wait))
        }

        /** Узел находится в проверяемой области: лента чата или поле ввода. */
        function isCheckableTextNode(node) {
          const parent = node.parentElement
          if (!parent) return false
          if (parent.closest(SKIP_SELECTOR) !== null) return false
          return parent.closest(CHAT_REGION_SELECTOR) !== null
            || parent.closest(COMPOSER_INPUT_SELECTOR) !== null
        }

        /** Хост композера для узла, если это поле ввода. */
        function composerHostOf(node) {
          const parent = node.parentElement
          return parent === null ? null : parent.closest(COMPOSER_INPUT_SELECTOR)
        }

        /**
         * Отключить встроенную проверку Chromium в поле ввода.
         *
         * Иначе на одном слове рисуются две разные волны (своя и браузерная), а
         * нативное меню DSH не содержит вариантов замены. Свою проверку мы
         * включаем только после того, как словарь загрузился, поэтому при
         * сбое загрузки поведение остаётся штатным.
         */
        function silenceNativeSpelling() {
          for (const host of document.querySelectorAll(COMPOSER_INPUT_SELECTOR)) {
            if (host.getAttribute('spellcheck') === 'false') continue
            if (!nativeSpellingDisabled.has(host)) {
              nativeSpellingDisabled.set(host, host.getAttribute('spellcheck'))
            }
            host.setAttribute('spellcheck', 'false')
            if (!announcedSpellingOff) {
              announcedSpellingOff = true
              console.info('[dsh-spellcheck] composer found: built-in Chromium spellcheck disabled for it')
            }
          }
        }

        /** Вернуть исходный атрибут spellcheck (при выгрузке плагина). */
        function restoreNativeSpelling() {
          for (const [host, previous] of nativeSpellingDisabled) {
            if (!host.isConnected) continue
            if (previous === null) host.removeAttribute('spellcheck')
            else host.setAttribute('spellcheck', previous)
          }
          nativeSpellingDisabled.clear()
        }

        /** Пересчитать подсветку во всём чате. */
        function scanChat() {
          if (disposed || engine === null) return
          // Своя проверка готова — убираем конкурирующую браузерную в поле ввода.
          silenceNativeSpelling()
          const roots = [...document.querySelectorAll(CHAT_REGION_SELECTOR)]
          // Поле ввода обычно лежит внутри области чата, но могло быть отрисовано
          // и отдельно (портал/другая вёрстка): тогда обходим его как свой корень.
          for (const host of document.querySelectorAll(COMPOSER_INPUT_SELECTOR)) {
            const inside = roots.some(root => typeof root.contains === 'function' && root.contains(host))
            if (!inside) roots.push(host)
          }
          if (roots.length === 0) {
            // Чат не отрисован (стартовый экран): снимаем набор, чтобы не
            // держать ссылки на отключённые узлы.
            if (painted && highlightSupported()) CSS.highlights.delete(HIGHLIGHT_NAME)
            painted = false
            return
          }
          const ranges = []
          let recomputed = false
          for (const root of roots) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                return isCheckableTextNode(node) && node.nodeValue && node.nodeValue.length >= 3
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT
              },
            })
            let node = walker.nextNode()
            while (node !== null) {
              if (collectNodeRanges(node, ranges)) recomputed = true
              node = walker.nextNode()
            }
          }
          // Пока текст не менялся, набор диапазонов тот же: повторная установка
          // заставила бы браузер пересчитывать отрисовку подсветки на каждом
          // потоковом токене без пользы.
          if (!recomputed && painted) return
          painted = true
          if (highlightSupported()) {
            CSS.highlights.set(HIGHLIGHT_NAME, new window.Highlight(...ranges))
          } else if (!warnedUnsupported) {
            warnedUnsupported = true
            console.warn('[dsh-spellcheck] CSS Custom Highlight API недоступен: подсветка отключена, меню работает по правому клику')
          }
        }

        /**
         * Собрать диапазоны ошибочных слов одного текстового узла (с кэшем).
         * @returns {boolean} пересчитывался ли узел (false — попали в кэш).
         */
        function collectNodeRanges(node, ranges) {
          const text = node.nodeValue || ''
          const cached = nodeCache.get(node)
          if (cached !== undefined && cached.text === text) {
            for (const range of cached.ranges) ranges.push(range)
            return false
          }
          const rangesOfNode = []
          for (const token of tokenize(text)) {
            if (!engine.shouldFlag(token.word)) continue
            const range = document.createRange()
            range.setStart(node, token.start)
            range.setEnd(node, token.end)
            rangesOfNode.push(range)
            ranges.push(range)
          }
          nodeCache.set(node, { text, ranges: rangesOfNode })
          return true
        }

        /**
         * Найти слово под указателем мыши.
         * @returns {null | { node: Text, start: number, end: number, word: string }}
         */
        function wordAtPoint(x, y) {
          const position = typeof document.caretRangeFromPoint === 'function'
            ? document.caretRangeFromPoint(x, y)
            : null
          if (!position) return null
          const node = position.startContainer
          if (node === null || node.nodeType !== Node.TEXT_NODE) return null
          if (!isCheckableTextNode(node)) return null
          const text = node.nodeValue || ''
          const offset = position.startOffset
          for (const token of tokenize(text)) {
            if (offset < token.start || offset > token.end) continue
            return { node, ...token }
          }
          return null
        }

        /**
         * Применить выбранное исправление к показанному тексту.
         *
         * Два пути:
         *  - лента чата: текст принадлежит React, поэтому меняем текстовый узел
         *    (правка живёт до перерисовки сообщения);
         *  - поле ввода: там contenteditable под управлением Lexical, поэтому
         *    слово выделяется и заменяется штатной командой редактирования —
         *    модель редактора остаётся согласованной.
         * @returns {{ ok: boolean, composer: boolean }} результат и место правки.
         */
        function applyFix(target, replacement) {
          if (!target || !target.node) return { ok: false, composer: false }
          const { node } = target
          if (!node.isConnected) return { ok: false, composer: false }
          const text = node.nodeValue || ''
          // Проверяем, что по сохранённым смещениям всё ещё то же слово:
          // за время между кликом и выбором пункта текст мог перерисоваться.
          const current = tokenize(text).find(token => token.start === target.start && token.end === target.end)
          if (!current) return { ok: false, composer: false }
          const display = matchCase(current.word, replacement)
          if (display === current.word) return { ok: false, composer: false }
          const composerHost = composerHostOf(node)
          if (composerHost !== null) {
            return { ok: applyComposerFix(composerHost, node, current, display), composer: true }
          }
          node.nodeValue = text.slice(0, current.start) + display + text.slice(current.end)
          lastFix = { node, start: current.start, length: display.length, from: current.word, to: display }
          nodeCache.delete(node)
          scheduleScan(0)
          return { ok: true, composer: false }
        }

        /**
         * Заменить слово в поле ввода через обычное редактирование.
         *
         * Выделяем слово в текстовом узле и вызываем execCommand('insertText'):
         * Chromium присылает beforeinput, Lexical применяет вставку штатным
         * путём, и модель редактора (а значит, и отправляемый текст) обновляется.
         * Если команда не сработала, текст остаётся прежним — портить ввод нельзя.
         * @param {Element} host - contenteditable композера.
         * @param {Text} node - текстовый узел со словом.
         * @param {{ start: number, end: number, word: string }} token - слово в узле.
         * @param {string} display - замена с нужным регистром.
         * @returns {boolean}
         */
        function applyComposerFix(host, node, token, display) {
          const selection = window.getSelection()
          if (selection === null) return false
          const range = document.createRange()
          range.setStart(node, token.start)
          range.setEnd(node, token.end)
          try {
            if (typeof host.focus === 'function') host.focus({ preventScroll: true })
            selection.removeAllRanges()
            selection.addRange(range)
            const applied = document.execCommand('insertText', false, display)
            nodeCache.delete(node)
            scheduleScan(0)
            return applied === true
          } catch (error) {
            console.warn('[dsh-spellcheck] composer replacement failed', error)
            return false
          }
        }

        /** Отменить последнее исправление в показанном тексте. */
        function undoLastFix() {
          const fix = lastFix
          if (fix === null) return
          lastFix = null
          const node = fix.node
          if (node.isConnected && node.nodeValue
            && node.nodeValue.slice(fix.start, fix.start + fix.length) === fix.to) {
            const text = node.nodeValue
            node.nodeValue = text.slice(0, fix.start) + fix.from + text.slice(fix.start + fix.length)
            nodeCache.delete(node)
          }
          scheduleScan(0)
        }

        /**
         * Показать уведомление хоста.
         * @param {string} from - исходное слово.
         * @param {string} to - выбранная замена.
         * @param {boolean} canUndo - предлагать ли отмену (в поле ввода отмена
         *   живёт в самом редакторе: Ctrl+Z и так работает).
         */
        function notifyFixed(from, to, canUndo) {
          const text = `${t('fixedNotice')}: «${from}» → «${to}»`
          if (!canUndo) {
            ctx.contextMenus.notify(text, true)
            return
          }
          ctx.contextMenus.notify(text, true, {
            label: t('undo'),
            run: () => { undoLastFix() },
            failureLabel: t('failed'),
          })
        }

        /** Запомнить слово в пользовательском словаре и сохранить его. */
        function addUserWord(word) {
          const lower = word.toLowerCase()
          if (userWords.has(lower)) return
          userWords.add(lower)
          if (engine !== null) engine.addUserWord(lower)
          writeStoredList(STORAGE_USER, [...userWords])
          resetNodeCache()
          scheduleScan(0)
        }

        /**
         * Действия контекстного меню для конкретного слова.
         * @param {{ word: string, occurrence?: string }} value - цель из ctx.contextMenus.open.
         */
        function menuActions(value) {
          if (engine === null) {
            void ensureEngine()
            return [{ id: 'loading', label: t('unavailable'), disabled: true }]
          }
          const word = String(value && value.word ? value.word : '')
          if (word === '') return []
          const target = occurrences.get(String(value && value.occurrence ? value.occurrence : '')) ?? null
          /** @type {Array<{id: string, label: string, run?: () => void, disabled?: boolean, separatorBefore?: boolean}>} */
          const actions = []
          // Не больше пяти вариантов: длинный список превращает меню в свалку,
          // а первые кандидаты и так самые правдоподобные.
          const suggestions = engine.suggest(word).slice(0, MAX_MENU_SUGGESTIONS)
          if (suggestions.length > 0) {
            actions.push({ id: 'suggest-header', label: t('suggestHeader'), disabled: true })
            for (let index = 0; index < suggestions.length; index += 1) {
              const suggestion = suggestions[index]
              actions.push({
                id: `apply-${index}`,
                label: suggestion.word,
                run: () => {
                  const result = target === null
                    ? { ok: false, composer: false }
                    : applyFix(target, suggestion.word)
                  if (result.ok) {
                    console.info(`[dsh-spellcheck] fixed «${word}» → «${matchCase(word, suggestion.word)}» in ${result.composer ? 'composer' : 'transcript'}`)
                    notifyFixed(word, matchCase(word, suggestion.word), !result.composer)
                  } else {
                    // Текст перерисовался между кликом и выбором: молчать нельзя,
                    // иначе выглядит как поломка.
                    ctx.contextMenus.notify(t('failed'))
                  }
                  occurrences.delete(String(value.occurrence ?? ''))
                },
              })
            }
          }
          actions.push({
            id: 'add-dictionary',
            label: t('addToDictionary'),
            separatorBefore: suggestions.length > 0,
            run: () => { addUserWord(word) },
          })
          actions.push({
            id: 'ignore-session',
            label: t('ignoreSession'),
            run: () => {
              ignoredWords.add(word.toLowerCase())
              if (engine !== null) engine.addIgnored(word.toLowerCase())
              // Кэш диапазонов помнит прежнее решение для этого узла, поэтому
              // сбрасываем его целиком: иначе подчёркивание останется висеть.
              resetNodeCache()
              scheduleScan(0)
            },
          })
          return actions
        }

        /**
         * Открыть меню хоста для найденного слова и запомнить жест.
         * @param {{ node: Text, start: number, end: number, word: string }} target
         * @param {{ x: number, y: number }} point
         */
        function openWordMenu(target, point) {
          occurrenceSeq += 1
          const occurrence = String(occurrenceSeq)
          occurrences.set(occurrence, target)
          // Карта не должна расти: держим только последние вхождения.
          if (occurrences.size > 20) occurrences.delete(occurrences.keys().next().value)
          lastOpen = { word: target.word, at: Date.now() }
          console.info(`[dsh-spellcheck] menu for «${target.word}» in ${composerHostOf(target.node) === null ? 'transcript' : 'composer'}`)
          ctx.contextMenus.open(
            { kind: TARGET_KIND, value: { word: target.word, occurrence } },
            point,
          )
        }

        /**
         * Правый клик на уровне указателя.
         *
         * Нативное меню Electron приходит из главного процесса и не всегда
         * уважает preventDefault на contextmenu, поэтому жест отменяется ещё
         * здесь: у Chromium это надёжно убирает и нативное меню, и выделение
         * слова под курсором.
         */
        function onPointerDown(event) {
          if (disposed || engine === null || event.button !== 2) return
          const target = wordAtPoint(event.clientX, event.clientY)
          if (target === null) return
          if (!engine.shouldFlag(target.word)) return
          event.preventDefault()
          openWordMenu(target, { x: event.clientX, y: event.clientY })
        }

        /** Обработчик contextmenu: клавиатура и случаи, когда pointerdown не пришёл. */
        function onContextMenu(event) {
          if (disposed || engine === null) return
          const target = wordAtPoint(event.clientX, event.clientY)
          if (target === null) return
          if (!engine.shouldFlag(target.word)) return
          // preventDefault обязателен: иначе штатный обработчик хоста закроет
          // уже открытое меню (он реагирует на неотменённый contextmenu).
          event.preventDefault()
          // Меню уже открыто обработчиком pointerdown. Повторный open() по тому
          // же слову хост понял бы как повторный жест и закрыл меню.
          if (lastOpen.word === target.word && Date.now() - lastOpen.at < 500) return
          openWordMenu(target, { x: event.clientX, y: event.clientY })
        }

        /** Запуск: стили, наблюдатели, отложенная загрузка словаря. */
        function start() {
          if (typeof CSS === 'undefined' || !CSS.highlights) {
            // Без подсветки меню по правому клику всё равно полезно, поэтому
            // продолжаем работу, только предупреждаем один раз.
            console.warn('[dsh-spellcheck] CSS.highlights недоступен: подчёркивание не будет показано')
          }
          // Стиль добавляется в head; если документа ещё нет (теоретически при
          // очень ранней активации), плагин не должен падать внутри хоста.
          try {
            if (document.head) document.head.appendChild(styleElement)
          } catch (error) {
            console.warn('[dsh-spellcheck] style injection failed', error)
          }
          try {
            observer = new MutationObserver(() => { scheduleScan() })
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          } catch (error) {
            console.warn('[dsh-spellcheck] observer setup failed', error)
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('contextmenu', onContextMenu, true)
          // Словарь грузим сразу, но не блокируя первый кадр интерфейса.
          // Хэндл таймера храним: иначе после выгрузки плагина словарь всё
          // равно распакуется и соберётся (сотни миллисекунд на главном потоке).
          loadTimer = window.setTimeout(() => {
            loadTimer = 0
            void ensureEngine()
          }, 150)
          return () => {
            disposed = true
            if (scanTimer !== 0) window.clearTimeout(scanTimer)
            scanTimer = 0
            if (loadTimer !== 0) window.clearTimeout(loadTimer)
            loadTimer = 0
            occurrences.clear()
            restoreNativeSpelling()
            observer?.disconnect()
            observer = null
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('contextmenu', onContextMenu, true)
            styleElement.remove()
            if (highlightSupported()) CSS.highlights.delete(HIGHLIGHT_NAME)
          }
        }

        ctx.effect(() => ctx.locale.register(NAMESPACE, DICTIONARIES), 'spellcheck: locale')
        ctx.effect(() => ctx.contextMenus.register({
          id: 'dsh-spellcheck',
          target: TARGET_KIND,
          order: 0,
          resolve: value => menuActions(value),
        }), 'spellcheck: context menu')
        ctx.effect(start, 'spellcheck: highlight lifetime')

        // Отладочный доступ для тестов сборки: сами тесты выполняются в Node
        // и вызывают чистые функции ядра, здесь же проверяется только то, что
        // фабрика собралась и экспортирует ожидаемый контракт.
        if (typeof globalThis === 'object' && globalThis.__DSH_SPELLCHECK_PROBE__ === true) {
          globalThis.__dshSpellcheck = {
            apply: pluginHandle?.apply,
            tokenize,
            matchCase,
            wordKey,
            NAMESPACE,
            TARGET_KIND,
            HIGHLIGHT_NAME,
          }
        }
      },
    }
    pluginHandle = plugin
    return plugin
  },
})
