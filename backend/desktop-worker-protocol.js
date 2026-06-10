// Shared newline-JSON worker pipe protocol for the desktop Pear worker.

export function attachDesktopWorkerPipe ({ wire, bridge, log = () => {} }) {
  let buf = ''

  wire.on('data', async (chunk) => {
    buf += chunkToText(chunk)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch (_) { continue }

      if (msg && msg.type === 'visibility' && typeof msg.visible === 'boolean') {
        try { bridge.setVisibility(msg.visible) } catch (_) {}
        continue
      }

      let res
      try {
        res = await bridge.request(msg)
        if (res && res.result && res.result._promise) res.result = await res.result._promise
      } catch (err) {
        res = { id: msg && msg.id, ok: false, error: { message: String((err && err.message) || err), code: err && err.code } }
      }
      const out = JSON.stringify(res) + '\n'
      log('debug', 'rpc-res', { id: res && res.id, cmd: msg && msg.command, ok: res && res.ok, code: res && res.error && res.error.code, bytes: out.length })
      try { wire.write(out) } catch (e) { log('warn', 'rpc-res-write-failed', { err: String((e && e.message) || e) }) }
    }
  })

  wire.on('end', () => { try { wire.end() } catch (_) {} })
  wire.on('error', (err) => log('warn', 'desktop-worker-pipe-error', { err: String((err && err.message) || err) }))
}

function chunkToText (chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk && typeof chunk.toString === 'function') return chunk.toString()
  return String(chunk)
}
