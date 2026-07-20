// Paste — Electron main process (pear-runtime + Electron-Forge path).
//
// Ported from holepunchto/hello-pear-electron (the current Pear desktop
// boilerplate). This process is a THIN host: it opens the BrowserWindow and
// relays renderer<->worker IPC. ALL P2P/crypto work runs in Bare workers
// spawned via PearRuntime.run():
//   /workers/main.js   — the OTA updater (own corestore+swarm, update drive)
//   /workers/paste.js  — the Paste Pear-end (createPearEnd; vault, swarm,
//                        autobase, relays), speaking the SAME newline-JSON RPC
//                        protocol as the legacy pear-electron path.
//
// The legacy pear-electron entry (../index.js, `pear run --dev .`) remains the
// shippable fallback until the Phase 5 cutover — see
// docs/PEAR_RUNTIME_MIGRATION.md.
//
// ESM note: the repo is `"type": "module"`; Electron ≥28 supports an ESM main.
// The sandboxed preload must stay CJS, hence preload.cjs.

import { app, BrowserWindow, ipcMain } from 'electron'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import PearRuntime from 'pear-runtime'
import FramedStream from 'framed-stream'
import whichRuntime from 'which-runtime'
import { command, flag } from 'paparam'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { isMac, isLinux, isWindows } = whichRuntime
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg

const protocol = name
const updaterWorkerSpecifier = '/workers/main.js'
const APPLY_UPDATE_TIMEOUT_MS = 5 * 60 * 1000

const workers = new Map()
let applyUpdatePromise = null

const appName = productName ?? name

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide()
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

function getAppPath () {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll (name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function frameToText (data) {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  if (data && data.buffer) {
    return Buffer.from(data.buffer, data.byteOffset || 0, data.byteLength).toString('utf8')
  }
  return data && typeof data.toString === 'function' ? data.toString() : String(data)
}

function updaterErrorFromFrame (message) {
  if (message.startsWith('pear:updateError:')) {
    const err = new Error(message.slice('pear:updateError:'.length) || 'update failed')
    err.code = 'UPDATE_FAILED'
    return err
  }

  let parsed = null
  try { parsed = JSON.parse(message) } catch (_) {}
  if (parsed && parsed.type === 'pear:updateError') {
    const err = new Error(parsed.message || 'update failed')
    if (parsed.code) err.code = parsed.code
    return err
  }

  return null
}

// Conventional per-OS app dir (boilerplate-verbatim). Workers receive it as
// argv[2]; the updater keeps its corestore under <dir>/pear-runtime/ and the
// Paste worker keeps the vault store under <dir>/store (never shared).
function storageDir () {
  const appPath = getAppPath()
  if (pearStore) return pearStore
  if (appPath === null) return path.join(os.tmpdir(), 'pear', appName)
  const isSnap = !!process.env.SNAP_USER_COMMON
  const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? isSnap
        ? path.join(process.env.SNAP_USER_COMMON, appName)
        : path.join(linuxConfigHome, appName)
      : path.join(os.homedir(), 'AppData', 'Roaming', appName)
}

function getWorker (specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const appPath = getAppPath()
  const dir = storageDir()
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'

  const worker = PearRuntime.run(require.resolve('..' + specifier), [
    dir,
    appPath,
    updates,
    version,
    upgrade,
    productName + extension
  ])
  const pipe = new FramedStream(worker)

  function sendWorkerStdout (data) {
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr (data) {
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function sendWorkerIPC (data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit () {
    pipe.destroy()
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return pipe.write(data)
  })
  workers.set(specifier, pipe)
  pipe.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

async function createWindow () {
  // Window options mirror the pear.gui block of the legacy path (spec §12).
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#07090c',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  await win.loadFile(path.join(__dirname, '..', 'index.html'))
}

ipcMain.handle('pear:applyUpdate', () => {
  if (applyUpdatePromise) return applyUpdatePromise
  const pipe = getWorker(updaterWorkerSpecifier)

  applyUpdatePromise = new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      const err = new Error('update apply timed out')
      err.code = 'UPDATE_TIMEOUT'
      finish(err)
    }, APPLY_UPDATE_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    function finish (err, result) {
      if (done) return
      done = true
      clearTimeout(timer)
      pipe.removeListener('data', onData)
      if (err) reject(err)
      else resolve(result || { applied: true })
    }

    function onData (data) {
      const message = frameToText(data).trim()

      if (message === 'pear:updateApplied') {
        finish(null, { applied: true })
        return
      }

      const err = updaterErrorFromFrame(message)
      if (err) {
        finish(err)
      }
    }

    pipe.on('data', onData)
    try {
      pipe.write('pear:applyUpdate')
    } catch (err) {
      finish(err)
    }
  }).finally(() => {
    applyUpdatePromise = null
  })

  return applyUpdatePromise
})
ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename)
  return true
})
ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.quit()
})

function handleDeepLink (url) {
  console.log('deep link:', url)
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
  })

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
