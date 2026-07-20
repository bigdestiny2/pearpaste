import { i18n } from './i18n'
import { sdk } from './sdk'
import { imageId, webPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting Pear Paste!'))

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: await sdk.SubContainer.of(
      effects,
      { imageId },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/data',
        readonly: false,
      }),
      'pearpaste-sub',
    ),
    exec: {
      command: ['node', 'server/web.mjs'],
      env: {
        NODE_ENV: 'production',
        HOME: '/data',
        PEARPASTE_HOST: '0.0.0.0',
        PEARPASTE_PORT: String(webPort),
        PEARPASTE_STORAGE: '/data/store',
      },
    },
    ready: {
      display: i18n('Web Interface'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, webPort, {
          successMessage: i18n('The web interface is ready'),
          errorMessage: i18n('The web interface is not ready'),
        }),
    },
    requires: [],
  })
})
