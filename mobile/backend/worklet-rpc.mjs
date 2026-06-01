// WorkletRPC — length-prefixed JSON over the Bare worklet IPC.
//
// Faithful ESM port of the PROVEN PearBrowser `backend/rpc.js` protocol
// (verified working on real iOS + Android with a heavy native-addon Pear-end
// worklet). Wire format per message: 8 lowercase-hex chars = JSON char length,
// then the JSON. Both sides operate on the utf8-decoded string with the same
// char-length header, so framing stays consistent.
//   request:  { id, cmd, data }
//   reply:    { id, result } | { id, error, code }
//   event:    { event, data }
//
// We deliberately do NOT use bare-rpc: its handshake/framing is what silently
// hung our worklet; this simple framing is what PearBrowser proves works.

import b4a from 'b4a'

export default class WorkletRPC {
  constructor (ipc) {
    this._ipc = ipc
    this._handlers = new Map()
    this._buffer = ''
    ipc.on('data', (chunk) => this._onData(chunk))
    ipc.on('error', () => {})
  }

  handle (cmd, fn) { this._handlers.set(cmd, fn) }

  event (evt, data) { this._send({ event: evt, data }) }

  _reply (id, result, error) {
    if (error) {
      this._send({ id, error: typeof error === 'string' ? error : (error && error.message) || 'error', code: error && error.code })
    } else {
      this._send({ id, result })
    }
  }

  _send (msg) {
    try {
      const json = JSON.stringify(msg)
      this._ipc.write(b4a.from(json.length.toString(16).padStart(8, '0') + json))
    } catch (_) {}
  }

  _onData (chunk) {
    this._buffer += b4a.toString(b4a.from(chunk))
    while (this._buffer.length >= 8) {
      const len = parseInt(this._buffer.slice(0, 8), 16)
      if (!Number.isFinite(len) || len < 0 || len > 50_000_000) { this._buffer = ''; return }
      if (this._buffer.length < 8 + len) break
      const json = this._buffer.slice(8, 8 + len)
      this._buffer = this._buffer.slice(8 + len)
      let msg
      try { msg = JSON.parse(json) } catch (_) { continue }
      this._process(msg)
    }
  }

  async _process (msg) {
    if (msg.id && msg.cmd !== undefined) {
      const handler = this._handlers.get(msg.cmd)
      if (!handler) { this._reply(msg.id, null, 'unknown command: ' + msg.cmd); return }
      try {
        const result = await handler(msg.data)
        this._reply(msg.id, result)
      } catch (err) {
        this._reply(msg.id, null, err)
      }
    }
  }
}
