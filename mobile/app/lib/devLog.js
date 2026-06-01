// TEMPORARY diagnostic — monkey-patches console.warn / console.error to also
// write to a file in app Documents. The yellow LogBox banner ("Open debugger
// to view warnings.") shows in dev builds when JS code calls console.warn,
// but the warning text travels over a Metro WebSocket and doesn't appear in
// the tee'd Metro CLI log or iOS os_log — so we can't grep for it from the
// host. This shim captures the actual messages.
//
// Read from the host via:
//   xcrun simctl get_app_container booted com.pearpaste data
//   → Documents/pearpaste-warnings.log
//
// Imported once at the top of App.js. Idempotent — re-imports won't re-patch.
// REMOVE THIS FILE + the App.js import once warnings are diagnosed.

import * as RNFS from '@dr.pogodin/react-native-fs'

const LOG = (RNFS.DocumentDirectoryPath || '/tmp') + '/pearpaste-warnings.log'

function safeStr (a) {
  if (a == null) return String(a)
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message + '\n' + (a.stack || '')
  try { return JSON.stringify(a) } catch (_) { return String(a) }
}

async function append (level, args) {
  try {
    const line = JSON.stringify({
      t: Date.now(),
      level,
      msg: Array.from(args).map(safeStr).join(' ')
    }) + '\n'
    await RNFS.appendFile(LOG, line, 'utf8')
  } catch (_) {}
}

if (!globalThis.__devLogInstalled) {
  globalThis.__devLogInstalled = true
  try { RNFS.writeFile(LOG, '').catch(() => {}) } catch (_) {}
  const _l = console.log
  const _w = console.warn
  const _e = console.error
  // Capturing console.log too — Hermes release builds on Android suppress
  // logcat output for `console.log`, but the file mirror still captures
  // backend stage events (MobilePearEnd forwards worklet 'boot' log:* events
  // as console.log('[backend]', ...) which is exactly what we need for
  // diagnosing pair flow failures.
  console.log = function (...args) { append('log', args); _l.apply(console, args) }
  console.warn = function (...args) { append('warn', args); _w.apply(console, args) }
  console.error = function (...args) { append('error', args); _e.apply(console, args) }
}
