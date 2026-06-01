/**
 * @format
 */

// MUST be first: installs TextEncoder/TextDecoder before the app module graph
// (App -> usePearPasteRpc -> rpc-commands.mjs) — RN 0.81 Hermes lacks
// TextDecoder, which the worklet-shared rpc-commands.mjs uses at module load.
import './polyfills';

// Host entry: register the real PearPaste app source which lives outside this
// generated project (mobile/app, resolved via Metro watchFolders). app.json
// name is "PearPaste", matching mobile/app/index.js's registerComponent.
import { AppRegistry } from 'react-native';
import App from '../app/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
