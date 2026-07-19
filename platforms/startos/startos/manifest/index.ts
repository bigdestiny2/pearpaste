import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'
import { containerImageRef, imageId, startOsImageArch } from '../utils'

export const manifest = setupManifest({
  id: 'pearpaste',
  title: 'Pear Paste',
  license: 'Apache-2.0',
  packageRepo: 'https://github.com/bigdestiny2/pearpaste/tree/main/platforms/startos',
  upstreamRepo: 'https://github.com/bigdestiny2/pearpaste',
  marketingUrl: 'https://github.com/bigdestiny2/pearpaste',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    [imageId]: {
      source: { dockerTag: containerImageRef },
      arch: startOsImageArch,
    },
  },
  alerts: {
    install: null,
    update: null,
    uninstall: null,
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {},
})
