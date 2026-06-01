// Metro platform-resolution shim (iOS). See worklet-bundle.android.js.
// Resolved on iOS so only the ~3.5 MB iOS bare-pack bundle is included in the
// iOS JS bundle.
module.exports = require('./app.ios.bundle')
