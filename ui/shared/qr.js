// QR code generation for the desktop pair screen.
//
// Thin wrapper around `qrcode-svg` (pure JS, sync, no native deps, browser-
// safe). It replaces a hand-rolled encoder that had latent bugs in the QR
// version-10+ code path (wrong char-count indicator width + multi-block
// interleave issues), which silently returned `null` for invites > ~213 chars
// — i.e. *any* real pairing invite once `autobaseKey` was added — and the UI
// fell back to "use the short code." Pairing-via-QR is a load-bearing UX, so
// we use a tested library and stop fighting ISO/IEC 18004 ourselves.

// Vendored from `qrcode-svg` as a single ESM file. We avoid the bare
// specifier `import QRCode from 'qrcode-svg'` because pear-electron's
// renderer serves modules over pear-bridge HTTP and CJS interop on bare
// node_modules specifiers is fragile (in our case it loaded silently as
// nothing, which prevented bridge-client.js from initializing — no worker
// boot, no QR). A relative ESM file resolves cleanly under the bridge.
import QRCode from './qr-vendor.js'

function stripPrologue (svg) {
  return String(svg || '')
    .replace(/^<\?xml[^?]*\?>\s*/, '')
    .replace(/^<!DOCTYPE[^>]*>\s*/, '')
}

// qrToSvg(text, opts) -> string SVG, or null on failure.
// opts: { scale = 6, margin = 4, dark, light }
//   - `scale` is preserved as a hint; the returned <svg> has a viewBox so CSS
//     can resize it independently. We pass `width = matrix * scale + padding`
//     by deferring to qrcode-svg's default sizing (which uses module size).
export function qrToSvg (text, opts = {}) {
  if (text == null || text === '') return null
  const { margin = 4, dark = '#0b0d10', light = '#ffffff' } = opts
  try {
    const qr = new QRCode({
      content: String(text),
      ecl: 'M',
      padding: margin,
      color: dark,
      background: light,
      join: true, // single <path> — much smaller output, same visual result
      container: 'svg'
    })
    return stripPrologue(qr.svg())
  } catch (_) {
    return null
  }
}

// Back-compat: expose a matrix shape for any caller that wants it. The
// underlying library exposes `qr.qrcode.modules` (2-D boolean grid) after
// construction; we normalize to { size, modules: 0/1 cells } to match the
// previous local encoder's contract.
export function generateQR (text) {
  if (text == null || text === '') return null
  try {
    const qr = new QRCode({ content: String(text), ecl: 'M', container: 'svg' })
    const m = qr.qrcode && qr.qrcode.modules
    if (!m || !m.length) return null
    return { size: m.length, modules: m.map(row => row.map(b => (b ? 1 : 0))) }
  } catch (_) { return null }
}

export default { qrToSvg, generateQR }
