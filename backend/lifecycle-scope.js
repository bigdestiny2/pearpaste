// Paste lifecycle scope.
//
// Borrows the HiveRelay 0.8.13+ cancellation/lifecycle contract: long-running
// async loops register here, observe `signal`, and the scope guarantees that
// teardown drains every registered task before resources (Corestore, swarm,
// relay) are closed. This prevents "closed" errors from stale async references
// after restart under active replication.
//
// Spec refs: §10 (teardown drains loops before closing Corestore),
// §21 Agent 1 (lifecycle shutdown pattern), §22 (every loop accepts cancel).

export class LifecycleScope {
  constructor (name = 'root') {
    this.name = name
    this.closing = false
    this.closed = false
    this._tasks = new Set()
    this._disposers = []
    this._abort = createAbortScope()
  }

  get signal () {
    return this._abort.signal
  }

  get cancelled () {
    return this._abort.signal.aborted
  }

  // Run an async background loop under this scope. `fn` receives the scope.
  // Its lifetime is tracked so `drain()` waits for it to settle.
  spawn (fn, label = 'task') {
    if (this.closing) throw new Error('LifecycleScope is closing; cannot spawn ' + label)
    const p = (async () => {
      try {
        await fn(this)
      } catch (err) {
        if (!this.cancelled) throw err
      }
    })()
    p.label = label
    this._tasks.add(p)
    p.finally(() => this._tasks.delete(p))
    return p
  }

  // Register a synchronous/async disposer run in LIFO order during teardown,
  // after all spawned tasks have drained.
  onClose (disposer) {
    this._disposers.push(disposer)
  }

  // Cooperative sleep that resolves early (rejects with AbortError) on cancel.
  sleep (ms) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(abortError())
      const t = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(abortError())
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // Signal cancellation, wait for every spawned task to settle, then run
  // disposers newest-first. Safe to call more than once.
  async close () {
    if (this.closed) return
    this.closing = true
    this._abort.abort()
    const pending = [...this._tasks]
    await Promise.allSettled(pending)
    for (let i = this._disposers.length - 1; i >= 0; i--) {
      try {
        await this._disposers[i]()
      } catch (_) {
        // disposers must not throw past teardown
      }
    }
    this._disposers = []
    this.closed = true
  }

  // Child scope cancelled when the parent is.
  child (name) {
    const c = new LifecycleScope(this.name + '/' + name)
    this.onClose(() => c.close())
    return c
  }
}

// Self-contained abort primitive. The Pear runtime is Bare, which has no
// global AbortController; Node does. We ship our own minimal, identical
// implementation so behaviour does not diverge between `npm test` (Node) and
// `pear run` (Bare). The signal exposes the AbortSignal-compatible surface
// LifecycleScope.sleep() and subsystems rely on: `aborted`,
// addEventListener/removeEventListener('abort', fn, { once }), and `onabort`.
function createAbortScope () {
  const handlers = new Set()
  let onabort = null
  const signal = {
    aborted: false,
    addEventListener (type, fn, opts) {
      if (type !== 'abort' || typeof fn !== 'function') return
      if (signal.aborted) { if (opts && opts.once) fn(); else fn(); return }
      handlers.add({ fn, once: !!(opts && opts.once) })
    },
    removeEventListener (type, fn) {
      if (type !== 'abort') return
      for (const h of handlers) if (h.fn === fn) handlers.delete(h)
    },
    get onabort () { return onabort },
    set onabort (fn) { onabort = typeof fn === 'function' ? fn : null }
  }
  function abort () {
    if (signal.aborted) return
    signal.aborted = true
    const fire = [...handlers]
    handlers.clear()
    if (onabort) { try { onabort() } catch (_) {} }
    for (const h of fire) { try { h.fn() } catch (_) {} }
  }
  return { signal, abort }
}

function abortError () {
  const e = new Error('aborted')
  e.name = 'AbortError'
  e.code = 'ABORT_ERR'
  return e
}

export default LifecycleScope
