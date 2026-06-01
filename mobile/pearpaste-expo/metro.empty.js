// Empty-module stub for optional, uninstalled RN libraries (QR/camera). The
// PearPaste pairing screen feature-detects these and falls back to manual
// short-code / invite entry when they are absent (spec §13).
//
// IMPORTANT: `.default` (and every member) MUST be FALSY. The screen detects
// availability via `require('lib').default` / `require('lib').Name`. A truthy
// `module.exports.default = {}` made `QRCode = {}` (an object) which then
// crashed as a JSX element ("Element type is invalid … got: object"). An
// empty exports object yields `undefined` for any property → detection
// correctly falls back. Do not re-add a `.default`.
module.exports = {};
