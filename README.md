# Chat spell check (Russian)

A DSH bundle that checks Russian spelling in the chat transcript and in the
message input: misspelled words get a red wavy underline, and a right-click
opens the harness context menu with up to five replacement candidates, plus
**Add to dictionary** and **Ignore until reload**.

## Install (for everyone)

The bundle is a normal DSH plugin package named **`dsh-spellcheck-ru`**. Pick one
route:

| Route | What to do |
|---|---|
| GitHub tag (primary) | install the bundle with target `github:BiraBeat/dsh-spellcheck-ru#v1.1.0` — Plugin Manager checks the repository with `git ls-remote` and fetches the tag through pnpm |
| GitHub Release asset | download `dsh-spellcheck-ru-1.1.0.tgz` and install with target `file:<path>/dsh-spellcheck-ru-1.1.0.tgz` |
| npm registry | if the package is published there: target `dsh-spellcheck-ru@1.1.0` |
| Plugin Manager (GUI) | sidebar **Plugins** → **Add plugin** → paste the same spec → install |

After installation a row named **Проверка орфографии в чате** appears in
**Plugins**; it is enabled by default. Restart DSH so the browser loads the
client half.

Requirements: any current DSH desktop or web profile (the underline needs the
CSS Custom Highlight API, i.e. a current Electron/Chromium). The dictionary
travels inside the package; no network access is used at runtime.

## Publish a release (for the maintainer)

The repository is self-contained: `client.js` is committed, so installing from a
git tag needs neither a build step nor network access beyond the clone.

```sh
node tools/build.mjs        # rebuild client.js after any change under src/
npm test                    # 71 tests
npm run verify-pack         # packs a real tarball and checks what users receive

git init
git add .
git commit -m "dsh-spellcheck-ru 1.1.0"
git branch -M main
git remote add origin https://github.com/BiraBeat/dsh-spellcheck-ru.git
git push -u origin main
git tag v1.1.0
git push origin v1.1.0      # тег и есть адрес установки для других людей
```

Attach `dist/dsh-spellcheck-ru-<version>.tgz` to the GitHub release for the
`file:`/download route. CI (`.github/workflows/ci.yml`) rebuilds the artifact,
runs the tests, verifies the packed tarball and fails if the committed
`client.js` differs from the sources.

To rename the package, change `package.json` `name` only and rebuild: the build
substitutes the name into the client artifact id, and `cordis.patch.yml` names
the same package. For npm, `npm login` then `npm publish` (or
`npm publish dist/dsh-spellcheck-ru-1.1.0.tgz`); `prepublishOnly` refuses to
publish a stale or incomplete artifact.

## How it works

| Part | Responsibility |
|---|---|
| `tools/vendor/ru_RU.dic` + `ru_RU.aff` | Hunspell-compatible Russian dictionary (146 269 stems, 1 581 suffix rules), compressed and embedded into `client.js` at build time. |
| `tools/vendor/ru_50k.txt` | Subtitle word-frequency list, used to rank suggestions and to reject implausible corrections. |
| `src/spellcore.mjs` | Pure engine: affix lookup (the same algorithm hunspell uses), Damerau-Levenshtein suggestions, tokenizer, flag decision. |
| `src/client.template.js` | Browser plugin: observes the transcript and the composer, paints ranges through the CSS Custom Highlight API, opens the host context menu on right-click. |
| `tools/build.mjs` | Writes `client.js` (inlines the engine, the compressed dictionary and the package name). |
| `tools/verify-pack.mjs` | Release gate: checks the directory or the packed tarball before publishing. |
| `client.js` | Built artifact loaded by the DSH module loader (about 1.1 MB, generated — do not edit). |

There is no Host work: `index.js` only satisfies the bundle row. Nothing is
written to the session log and no network request is made — the dictionary
travels inside the artifact.

## What gets underlined

Both the chat transcript and the composer (the message input) are checked. A
word is underlined only when it is absent from the dictionary **and** a
plausible one-edit correction exists:

- the edit is an insertion, a deletion, a transposition, or a substitution that
  Russian typists actually make (same vowel family, voiced/unvoiced pair,
  adjacent keys);
- the candidate is a frequent word (for very short candidates, a truly common
  word), or at least eight letters long (rare but long terms such as
  «отображение»).

The consequence is deliberate: loanwords and terms that merely resemble another
word («кэш» → «кыш», «деплой» → «теплой», «бандл» → «банд») are left alone,
while real typos — including inside long technical words — are flagged. Words
with a capital letter are treated as names unless the correction is a very
frequent word. Code blocks, inline code, reference chips and identifiers are
skipped.

## Behaviour notes

- **Composer**: Chromium's own spell checker is switched off on the composer
  element (`spellcheck="false"`) once this dictionary is loaded, otherwise two
  different verdicts and two waves would compete, and the native menu has no
  replacement variants. A chosen replacement is inserted with the native
  `insertText` editing command, so the Lexical draft model stays consistent and
  `Ctrl+Z` undoes it as a normal edit. The attribute is restored when the bundle
  is turned off.
- **Transcript**: the session log is immutable. A chosen correction rewrites only
  the clicked occurrence on screen; if React re-renders that message the fix
  disappears. The toast that follows offers **Undo**.
- **Add to dictionary** persists in `localStorage` under
  `dsh.spellcheck.userWords`; **Ignore until reload** lives only until the page
  is reloaded.
- Requires the CSS Custom Highlight API (any current Electron/Chromium). Without
  it the underline is skipped and the context menu still works.

## Development

```sh
node tools/build.mjs                                                       # rebuild client.js
node --test tests/spellcore.test.mjs tests/client.artifact.test.mjs \
            tests/client.dom.test.mjs tests/package.test.mjs                # 70 tests
node tools/validate.mjs <russian.txt> <ru_50k.txt>                          # coverage report, optional
```

`tools/build.mjs` must be rerun after every change under `src/`.

## Licences

See [LICENSES.md](LICENSES.md).
