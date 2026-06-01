// React Native registration entry for the PearPaste mobile app.
//
// `react-native init` / Metro looks for AppRegistry.registerComponent. The app
// name 'PearPaste' must match the native projects (ios/PearPaste,
// android .../MainActivity getMainComponentName) created by the build guide.

import { AppRegistry } from 'react-native'
import App from './App'

AppRegistry.registerComponent('PearPaste', () => App)

export default App
