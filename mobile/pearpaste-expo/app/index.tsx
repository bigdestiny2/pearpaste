// PearPaste Expo host — index route.
//
// MUST import polyfills first (RN/Hermes lacks TextDecoder, which the
// worklet-shared rpc-commands.mjs uses at module load). Then render the shared
// PearPaste app (mobile/app/App.js — resolved via Metro watchFolders). The app
// brings up the Bare Pear-end worklet via react-native-bare-kit (the
// integration proven working under Expo by bare-expo).
import '../polyfills'
import App from '../../app/App'

export default App
