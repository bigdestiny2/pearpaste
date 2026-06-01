// Metro platform-resolution shim. Importing '../../backend/worklet-bundle'
// resolves to THIS file on Android, so Metro only pulls the ~3.5 MB Android
// bare-pack bundle into the Android JS bundle (the iOS variant is unreachable
// from the Android module graph — was previously double-included via static
// `import iosBundle ... ; import androidBundle ...`).
module.exports = require('./app.android.bundle')
