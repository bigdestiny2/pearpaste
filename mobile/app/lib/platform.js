import { Platform } from 'react-native'

export function currentDevicePlatform () {
  if (Platform.OS === 'ios') return 'ios'
  if (Platform.OS === 'android') return 'android'
  return Platform.OS || 'unknown'
}
