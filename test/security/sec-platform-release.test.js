// Security: platform release build guards.
//
// Android release artifacts must not be signed with the public debug keystore.
// The Gradle config is intentionally fail-closed: debug builds may use
// debug.keystore, but release package tasks require a private keystore supplied
// out of band.

import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ANDROID_APP_GRADLE = path.join(ROOT, 'mobile/PearPasteMobile/android/app/build.gradle')
const ANDROID_MANIFEST = path.join(ROOT, 'mobile/PearPasteMobile/android/app/src/main/AndroidManifest.xml')

function releaseBuildTypeSnippet (gradle) {
  const buildTypesAt = gradle.indexOf('buildTypes')
  const releaseAt = gradle.indexOf('release {', buildTypesAt)
  return releaseAt >= 0 ? gradle.slice(releaseAt, releaseAt + 900) : ''
}

test('§17 Android release build is not signed with the debug keystore', (t) => {
  const gradle = fs.readFileSync(ANDROID_APP_GRADLE, 'utf8')
  const releaseSnippet = releaseBuildTypeSnippet(gradle)

  t.ok(releaseSnippet, 'release buildType is present')
  t.absent(/signingConfig\s+signingConfigs\.debug/.test(releaseSnippet),
    'release buildType does not use signingConfigs.debug')
  t.ok(/signingConfig\s+signingConfigs\.release/.test(releaseSnippet),
    'release buildType uses signingConfigs.release when configured')
  t.ok(/GradleException/.test(gradle) && /release signing is not configured/i.test(gradle),
    'release packaging fails closed when signing material is absent')
  for (const name of [
    'PEARPASTE_ANDROID_KEYSTORE',
    'PEARPASTE_ANDROID_KEYSTORE_PASSWORD',
    'PEARPASTE_ANDROID_KEY_ALIAS',
    'PEARPASTE_ANDROID_KEY_PASSWORD'
  ]) {
    t.ok(gradle.includes(name), name + ' is part of the signing contract')
  }
})

test('§17 Android release disables cleartext traffic by default', (t) => {
  const gradle = fs.readFileSync(ANDROID_APP_GRADLE, 'utf8')
  const manifest = fs.readFileSync(ANDROID_MANIFEST, 'utf8')
  const releaseSnippet = releaseBuildTypeSnippet(gradle)

  t.ok(manifest.includes('android:usesCleartextTraffic="$' + '{usesCleartextTraffic}"'),
    'manifest uses the Gradle cleartext placeholder')
  t.ok(/manifestPlaceholders\s*=\s*\[usesCleartextTraffic:\s*"false"\]/.test(gradle),
    'default manifest placeholder disables cleartext traffic')
  t.ok(releaseSnippet && /usesCleartextTraffic:\s*"false"/.test(releaseSnippet),
    'release build explicitly disables cleartext traffic')
})
