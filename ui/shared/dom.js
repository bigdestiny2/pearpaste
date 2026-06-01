// Tiny dependency-free DOM helper (spec §12: lightweight, no heavy framework,
// no remote CDN). `h(tag, props, ...children)` builds elements; `mount`
// swaps a container's content. This is intentionally ~1KB instead of pulling
// React/htm so the Pear-end package stays small.

export function h (tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'html') el.innerHTML = v // only used with locally-built trusted SVG strings
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'value') el.value = v
      else if (k === 'disabled' || k === 'checked' || k === 'selected') el[k] = !!v
      else el.setAttribute(k, v)
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function mount (container, node) {
  container.replaceChildren(node)
}

export function clear (container) { container.replaceChildren() }

export default { h, mount, clear }
