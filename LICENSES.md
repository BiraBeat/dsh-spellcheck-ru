# Licences and attribution

This package embeds third-party dictionary data. The data is redistributed in a
converted form (gzip + base64 inside `client.js`, plus a filtered frequency
list), which is marked here as a modification as required by the notice below.

## Russian orthography dictionary — `ru_RU.dic`, `ru_RU.aff`

Source: LibreOffice dictionaries, <https://github.com/LibreOffice/dictionaries/tree/master/ru_RU>
(originally Alexander I. Lebedev's Russian dictionary).

```
Copyright (c) 1997-2008, Alexander I. Lebedev

Modifications (upstream): 2012-08-24 Laszlo Nemeth added the TRY line.
Modifications (this package): converted to gzip + base64 embedded data; the .aff
rules are interpreted by src/spellcore.mjs instead of hunspell.

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this
  list of conditions and the following disclaimer in the documentation and/or
  other materials provided with the distribution.
* Modified versions must be clearly marked as such.
* The name of Alexander I. Lebedev may not be used to endorse or promote
  products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Word frequency list — `ru_50k.txt`

Source: FrequencyWords, <https://github.com/hermitdave/FrequencyWords> (Russian
list derived from OpenSubtitles 2018). MIT License, copyright (c) 2016 Hermit
Dave. Only the ranking order is used; entries that the dictionary does not
recognise are dropped at build time.

## Everything else

`src/`, `tools/`, `client.js`, `locale/`, `docs/`, `icon.svg` — original work of
this package.
