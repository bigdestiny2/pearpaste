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

const workers = new Map()

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
  const pipe = getWorker(updaterWorkerSpecifier)

  return new Promise((resolve) => {
    function onData (data) {
      const message = data.toString()

      if (message === 'pear:updateApplied') {
        pipe.removeListener('data', onData)
        resolve()
      }
    }

    pipe.on('data', onData)
    pipe.write('pear:applyUpdate')
  })
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
