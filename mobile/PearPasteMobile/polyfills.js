// PearPaste RN polyfills — must be the FIRST import in index.js so it runs
// before the app module graph (App -> usePearPasteRpc -> rpc-commands.mjs).
//
// rpc-commands.mjs is shared with the Bare worklet, whose runtime has both
// TextEncoder and TextDecoder. React Native 0.81's Hermes has TextEncoder but
// NOT TextDecoder, so `new TextDecoder()` at rpc-commands.mjs module top-level
// throws "Property 'TextDecoder' doesn't exist" and redboxes the whole app.
//
// Zero-dependency, spec-correct UTF-8 codec (handles 1–4 byte sequences and
// surrogate pairs). Installed on globalThis only when missing, so it never
// shadows a real platform implementation.

(function installTextCodecPolyfill (g) {
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = class TextEncoder {
      get encoding () { return 'utf-8' }
      encode (input) {
        const str = String(input == null ? '' : input)
        const out = []
        for (let i = 0; i < str.length; i++) {
          let c = str.charCodeAt(i)
          if (c < 0x80) {
            out.push(c)
          } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
          } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
            const c2 = str.charCodeAt(i + 1)
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
              const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
              out.push(
                0xf0 | (cp >> 18),
                0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f),
                0x80 | (cp & 0x3f)
              )
              i++
            } else {
              out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
            }
          } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
          }
        }
        return Uint8Array.from(out)
      }
    }
  }

  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = class TextDecoder {
      constructor (label) { this.encoding = String(label || 'utf-8').toLowerCase() }
      decode (input) {
        if (input == null) return ''
        let bytes
        if (input instanceof Uint8Array) bytes = input
        else if (input && input.buffer) {
          bytes = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength)
        } else if (Array.isArray(input)) bytes = Uint8Array.from(input)
        else bytes = new Uint8Array(input)

        let out = ''
        for (let i = 0; i < bytes.length;) {
          const b = bytes[i++]
          let cp
          if (b < 0x80) cp = b
          else if (b >= 0xc0 && b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
          else if (b >= 0xe0 && b < 0xf0) {
            cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
          } else if (b >= 0xf0) {
            cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                 ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
          } else cp = 0xfffd
          if (cp > 0xffff) {
            cp -= 0x10000
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
          } else {
            out += String.fromCharCode(cp)
          }
        }
        return out
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : global)
