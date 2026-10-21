# PDF text extraction runtime

**Current release:** PDF.js **6.4.299**. The initial 5.x installation below is historical: after repairing its native binary, a later security audit found GHSA-hq66-cqwq-w95j. The dependency was upgraded to the patched 6.x line, with Node, Electron-main and packaged-ASAR PDF extraction re-tested. Do not downgrade to the historical version when following these diagnostic notes.

## Historical root cause and repair

The failing PDF tests were caused by a **truncated installed native binary**, not
an unsupported PDF.js text API or an architecture mismatch. PDF.js imports its
Node graphics support even when the application only calls `getTextContent()`.
Failure to load that support caused the later `DOMMatrix is not defined` error.

Observed on this Windows machine:

| Component | Verified value |
| --- | --- |
| Host Node | 24.21.0, `win32`, `x64`; machine `x86_64` |
| PDF.js at diagnosis | `pdfjs-dist` 5.7.284, within the then-declared `^5.4.624` range; no longer used |
| Canvas wrapper | `@napi-rs/canvas` 0.1.100 |
| Native package | `@napi-rs/canvas-win32-x64-msvc` 0.1.100 |
| PE machine field | `0x8664` (AMD64), correct for the host |
| Broken native file length | 12,013,558 bytes |
| Minimum length required by its PE section headers | 27,294,720 bytes |
| Reinstalled native file length | 27,294,720 bytes |

The original file ended inside its `.text` section. Later sections, including
`.rdata` and `.reloc`, were missing. Windows therefore rejected it as "not a
valid Win32 application" (`ERR_DLOPEN_FAILED`). The generic optional-dependency
warning from the canvas loader did not identify this actual corruption.

SHA-256 of `skia.win32-x64-msvc.node`:

- Broken: `e97b4fcee9e9c886f649d9057662f79c20a0c928ff56992078bdbe6dadb08be7`
- Repaired: `0f76fb0648fbff832856f6ce202059fc3fa38be7ad925300e96935906ea11132`

Only the corrupt optional-package directory was explicitly removed, followed by
a reinstall of the same version:

```sh
node -e "require('node:fs').rmSync('node_modules/@napi-rs/canvas-win32-x64-msvc', { recursive: true, force: true })"
npm install --no-save --package-lock=false --ignore-scripts --include=optional --no-audit --no-fund @napi-rs/canvas-win32-x64-msvc@0.1.100
node -e "console.log(typeof require('@napi-rs/canvas').DOMMatrix)"
```

The final command returned `function` with no native-loader warning. Npm also
reconciled other local `node_modules` entries against the existing dependency
ranges. SHA-256 checks confirmed that **both `package.json` and
`package-lock.json` were unchanged**. No dependency replacement or declaration
change is needed. Keep `pdfjs-dist`; do not add `unpdf` for this issue.

The command above is specific to the observed Windows x64 installation. On a
different platform or architecture, inspect `process.platform`, `process.arch`,
and the canvas wrapper's optional dependencies first. Match the native package
version to the canvas wrapper. Rebuilding a package with an already-truncated
prebuilt binary does not restore its missing bytes; reinstall that package.
Restart the application/test process after repair, because a failed ESM import
can remain cached for the lifetime of the process.

## Supported application runtime

`electron/files.ts` uses a dynamic import of
`pdfjs-dist/legacy/build/pdf.mjs`, then `getDocument()` and page
`getTextContent()`. It does not render pages, execute PDF JavaScript, invoke
external tools, access a screenshot, or play audio. Application code and tests
do not supply a fake `DOMMatrix`, `ImageData`, or `Path2D`. PDF.js obtains its
real graphics support from the repaired upstream canvas package.

Parent/build requirements:

- Keep PDF.js external to the Electron CommonJS bundle, including its dynamic
  ESM import. The adjacent `legacy/build/pdf.worker.mjs` must be shipped too.
- Install optional production dependencies. For this PDF.js Node runtime,
  omitting the matching canvas native package prevents even text-only imports.
- Ship the target platform/architecture's native package, not a binary copied
  from an unrelated host or an incomplete install.
- Preserve the existing `asarUnpack` entries for `node_modules/pdfjs-dist/**/*`
  and `node_modules/@napi-rs/**/*`. No package-config changes were made here.
- If Electron's executable has not yet been installed, install the binary for
  the already-declared version with `node node_modules/electron/install.js`
  before running the Windows main-process integration test. This does not
  require a manifest change.

## Verification

Run from the project root:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run tests/files.test.ts
node node_modules/vitest/vitest.mjs run
```

The real PDF fixtures include correct object offsets and xref tables, escaped
text, multiple pages, and actual Flate-compressed content streams. Tests cover
registration and preparation/re-reading, invalid and textless PDFs, excessive
decompressed text, and registry rollback after extraction fails. The size-limit
fixture uses valid PDF horizontal scaling to keep all its text inside the page;
PDF.js correctly omits text positioned outside the page bounds.

On Windows, an additional test bundles the real service to CommonJS with PDF.js
external, launches an actual **windowless Electron main process**, and registers
and prepares a compressed two-page PDF. It asserts `process.type === 'browser'`
and the installed Electron version. It explicitly removes
`ELECTRON_RUN_AS_NODE` from the child's environment: this is not merely a Node
process using Electron's executable. Temporary application files and profile
are removed afterward; it neither opens a `BrowserWindow` nor invokes the
capture/speech services. The integration test is Windows-only, so non-Windows
headless CI does not require an X server.

Verified runtime: **Electron 42.11.18 / embedded Node 24.19.0 / Windows x64**.
Both ordinary Node and real Electron main extracted the expected PDF text after
the native-package repair, without graphics shims or an alternate extractor.

## Remaining limitations

- This service performs text extraction, not OCR. Image-only PDFs are explicitly
  rejected. Password-protected PDFs are not unlocked automatically.
- PDF.js currently warns that `standardFontDataUrl` is unset for fixtures using
  non-embedded Helvetica. Their expected text is verified, but this is not a
  font-completeness guarantee. PDFs needing additional font/CMap assets may
  need explicit local asset configuration; do not point these options at a
  remote CDN or suppress the warning to imply support that was not tested.
- The Vitest integration test exercises a development CommonJS bundle. In addition,
  `node scripts/ui-smoke.mjs --packaged --wait-ms=0` verified the release's actual
  `app.asar` PDF import through its real preload and file-registration IPC. A
  synthetic document's text was extracted without a model request. Running the
  NSIS installation/uninstallation flow on a clean Windows account is still a
  manual acceptance step; launching `win-unpacked` is not that installation test.
