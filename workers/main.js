/* global Bare */
// Paste — OTA updater worker (Bare process, spawned by electron/main.js via
// PearRuntime.run). Boilerplate-verbatim from holepunchto/hello-pear-electron.
//
// DELIBERATELY ISOLATED from the Paste Pear-end (/workers/paste.js): this
// worker gets its OWN corestore (<dir>/pear-runtime/corestore) and its OWN
// Hyperswarm joined only to the app-update drive topic. Paste's vault swarm is
// guarded by the replication firewall (committed-device auth); update-drive
// peers are anonymous seeders, so they must never share that swarm — an
// unconditional store.replicate() here is safe ONLY because this store holds
// public app bytes, never vault data.
import PearRuntime from 'pear-runtime'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import goodbye from 'graceful-goodbye'
import FramedStream from 'framed-stream'
import path from 'bare-path'

const pipe = new FramedStream(Bare.IPC)

const updaterConfig = {
  dir: Bare.argv[2],
  app: Bare.argv[3],
  updates: Bare.argv[4] !== 'false',
  version: Bare.argv[5],
  upgrade: Bare.argv[6],
  name: Bare.argv[7]
}

const store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime/corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ ...updaterConfig, swarm, store })

pear.updater.on('error', console.error)
if (updaterConfig.updates !== false) {
  swarm.on('connection', (connection) => store.replicate(connection))
  swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
}

console.log('updater storage:', pear.storage)

pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))

goodbye(async () => {
  await swarm.destroy()
  await pear.close()
  await store.close()
})

pipe.on('data', async (data) => {
  const message = data.toString()
  if (message === 'pear:applyUpdate') {
    await pear.updater.applyUpdate()
    pipe.write('pear:updateApplied')
  } else console.log(message)
})
