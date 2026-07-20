import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
import { startOsVersion } from '../utils'

export const current = VersionInfo.of({
  version: startOsVersion,
  releaseNotes: {
    en_US: 'Initial StartOS package for Pear Paste.',
    es_ES: 'Initial StartOS package for Pear Paste.',
    de_DE: 'Initial StartOS package for Pear Paste.',
    pl_PL: 'Initial StartOS package for Pear Paste.',
    fr_FR: 'Initial StartOS package for Pear Paste.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
