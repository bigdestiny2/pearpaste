import { createRequire } from 'node:module'

const loadJson = createRequire(__filename)

type RootPackage = {
  version: string
}

type ContainerImageConfig = {
  repository: string
  digest?: string | null
  startOsArches: string[]
  startOsPackageRevision: number
  webPort?: number
  uiPort?: number
  startOsPort?: number
}

type StartOsVersion = `${bigint}.${bigint}.${bigint}:${bigint}`
type StartOsImageArch = ['x86_64', 'aarch64']

const rootPackage = loadJson('../../../package.json') as RootPackage
const imageConfig = loadJson('../../../release/container-image.json') as ContainerImageConfig

function startOsPackageVersion(): StartOsVersion {
  return `${rootPackage.version}:${imageConfig.startOsPackageRevision}` as StartOsVersion
}

function startOsArch(): StartOsImageArch {
  const [first, second, ...rest] = imageConfig.startOsArches
  if (first === 'x86_64' && second === 'aarch64' && rest.length === 0) {
    return [first, second]
  }
  throw new Error('release/container-image.json startOsArches must be ["x86_64", "aarch64"]')
}

export const imageId = 'pearpaste'
export const appVersion = rootPackage.version
export const webPort = imageConfig.webPort ?? imageConfig.uiPort ?? 3000
export const startOsPort = imageConfig.startOsPort ?? imageConfig.uiPort ?? webPort
export const startOsVersion = startOsPackageVersion()
export const containerImageTag = `${imageConfig.repository}:${appVersion}`
export const containerImageRef =
  process.env.PEARPASTE_IMAGE ||
  (imageConfig.digest ? `${containerImageTag}@${imageConfig.digest}` : containerImageTag)
export const startOsImageArch = startOsArch()
