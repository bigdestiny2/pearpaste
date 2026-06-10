import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const root = path.dirname(__filename)

const dirs = {
  source: path.join(root, 'source'),
  editable: path.join(root, 'editable'),
  banners: path.join(root, 'png', 'banners'),
  headers: path.join(root, 'png', 'headers'),
  posts: path.join(root, 'png', 'posts'),
  features: path.join(root, 'png', 'features'),
  profiles: path.join(root, 'png', 'profiles'),
  icons: path.join(root, 'icons')
}

for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })

const backdropArgIndex = process.argv.indexOf('--backdrop')
const suppliedBackdrop = backdropArgIndex >= 0 ? process.argv[backdropArgIndex + 1] : ''
const backdropPath = path.join(dirs.source, 'campaign-backdrop.png')

if (suppliedBackdrop) {
  fs.copyFileSync(path.resolve(suppliedBackdrop), backdropPath)
}

const hasBackdrop = fs.existsSync(backdropPath)

const palette = {
  bg: '#07090c',
  bg2: '#0b0d10',
  surface: '#0f1318',
  surface2: '#141a21',
  text: '#e9eef3',
  muted: '#9aa6b2',
  faint: '#6b7682',
  mint: '#4ade80',
  cyan: '#22d3ee',
  blue: '#6aa9ff',
  violet: '#8b7bff',
  amber: '#f1c47b'
}

const brand = {
  name: 'Paste',
  tagline: 'One notepad. Every device you own.',
  subtagline: 'Private clipboard / encrypted on-device',
  description: 'Copy on your laptop, paste on your phone. No account. No cloud. No plaintext on relays.'
}

function write (file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function esc (text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function svgFile (name, w, h, body, options = {}) {
  const transparent = options.transparent === true
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(name)}">
  <defs>
    <linearGradient id="pasteGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.mint}"/>
      <stop offset="0.62" stop-color="${palette.cyan}"/>
      <stop offset="1" stop-color="${palette.blue}"/>
    </linearGradient>
    <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151b22"/>
      <stop offset="1" stop-color="#080b0f"/>
    </linearGradient>
    <linearGradient id="darkGlass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#17212a" stop-opacity="0.86"/>
      <stop offset="1" stop-color="#080b0f" stop-opacity="0.62"/>
    </linearGradient>
    <radialGradient id="mintGlow" cx="0.22" cy="0.18" r="0.72">
      <stop offset="0" stop-color="${palette.mint}" stop-opacity="0.32"/>
      <stop offset="0.44" stop-color="${palette.cyan}" stop-opacity="0.13"/>
      <stop offset="1" stop-color="${palette.bg}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="violetGlow" cx="0.9" cy="0.04" r="0.62">
      <stop offset="0" stop-color="${palette.violet}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${palette.bg}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse">
      <path d="M42 0H0V42" fill="none" stroke="#ffffff" stroke-opacity="0.055" stroke-width="1"/>
    </pattern>
    <filter id="blurGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="24" stdDeviation="26" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <clipPath id="roundClip">
      <rect width="${w}" height="${h}" rx="0"/>
    </clipPath>
  </defs>
  ${transparent ? '' : `<rect width="${w}" height="${h}" fill="${palette.bg}"/>`}
  ${body}
</svg>
`
}

function pasteMark (x, y, size, options = {}) {
  const stroke = options.stroke || 'url(#pasteGrad)'
  const opacity = options.opacity == null ? 1 : options.opacity
  return `<g transform="translate(${x} ${y}) scale(${size / 32})" opacity="${opacity}">
    <rect x="6" y="4.5" width="20" height="23" rx="4.5" fill="none" stroke="${stroke}" stroke-width="2.4"/>
    <rect x="11.5" y="2.6" width="9" height="5.4" rx="2.4" fill="none" stroke="${stroke}" stroke-width="2.4"/>
    <circle cx="16" cy="18.2" r="3.1" fill="none" stroke="${stroke}" stroke-width="2.2"/>
    <path d="M16 21.3v3" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round"/>
  </g>`
}

function textLines (lines, x, y, options = {}) {
  const size = options.size || 48
  const lineHeight = options.lineHeight || Math.round(size * 1.13)
  const fill = options.fill || palette.text
  const weight = options.weight || 700
  const anchor = options.anchor || 'start'
  const family = options.family || "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
  const opacity = options.opacity == null ? 1 : options.opacity
  const style = options.style ? ` style="${options.style}"` : ''

  return `<text x="${x}" y="${y}" fill="${fill}" opacity="${opacity}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${style}>
    ${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`).join('\n    ')}
  </text>`
}

function pill (x, y, text, options = {}) {
  const padX = options.padX || 18
  const height = options.height || 42
  const size = options.size || 18
  const width = options.width || Math.round(text.length * size * 0.56 + padX * 2)
  const color = options.color || palette.muted
  const icon = options.icon === false ? '' : `<circle cx="${x + 21}" cy="${y + height / 2}" r="4.6" fill="${palette.mint}"/>`
  const textX = icon ? x + 38 : x + padX
  return `<g>
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#ffffff" fill-opacity="0.035" stroke="#ffffff" stroke-opacity="0.12"/>
    ${icon}
    <text x="${textX}" y="${y + height / 2 + size * 0.36}" fill="${color}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="${size}" font-weight="600">${esc(text)}</text>
  </g>`
}

function backdrop (w, h, options = {}) {
  const imageOpacity = options.imageOpacity == null ? 0.8 : options.imageOpacity
  const shade = options.shade == null ? 0.46 : options.shade
  const focus = options.focus || 'xMidYMid'
  const image = hasBackdrop
    ? `<image href="../source/campaign-backdrop.png" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${focus} slice" opacity="${imageOpacity}"/>`
    : ''

  return `<g clip-path="url(#roundClip)">
    ${image}
    <rect width="${w}" height="${h}" fill="${palette.bg}" opacity="${shade}"/>
    <rect width="${w}" height="${h}" fill="url(#mintGlow)"/>
    <rect width="${w}" height="${h}" fill="url(#violetGlow)"/>
    <rect width="${w}" height="${h}" fill="url(#grid)" opacity="0.52"/>
    <circle cx="${w * 0.18}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.28}" fill="${palette.mint}" opacity="0.13" filter="url(#blurGlow)"/>
    <circle cx="${w * 0.86}" cy="${h * 0.16}" r="${Math.min(w, h) * 0.2}" fill="${palette.cyan}" opacity="0.12" filter="url(#blurGlow)"/>
    <rect width="${w}" height="${h}" fill="url(#leftFade)"/>
  </g>`
}

function addLocalDefsForFade (svg) {
  return svg.replace('</defs>', `    <linearGradient id="leftFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.bg}" stop-opacity="0.72"/>
      <stop offset="0.42" stop-color="${palette.bg}" stop-opacity="0.38"/>
      <stop offset="1" stop-color="${palette.bg}" stop-opacity="0.05"/>
    </linearGradient>
  </defs>`)
}

function wordmark (x, y, size = 48, options = {}) {
  const markSize = options.markSize || size
  const gap = options.gap || Math.round(size * 0.32)
  const subtitle = options.subtitle || ''
  const subtitleSize = options.subtitleSize || Math.round(size * 0.26)
  const subtitleX = x + markSize + gap + 3
  return `<g>
    ${pasteMark(x, y - markSize + 4, markSize)}
    <text x="${x + markSize + gap}" y="${y}" fill="${palette.text}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="${size}" font-weight="760">${brand.name}</text>
    ${subtitle ? `<text x="${subtitleX}" y="${y + subtitleSize + 10}" fill="${palette.faint}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="${subtitleSize}" font-weight="600">${esc(subtitle)}</text>` : ''}
  </g>`
}

function miniDeviceStack (x, y, scale = 1) {
  const s = scale
  return `<g transform="translate(${x} ${y}) scale(${s})" filter="url(#shadow)">
    <rect x="160" y="12" width="310" height="210" rx="22" fill="#05070a" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
    <rect x="181" y="38" width="268" height="144" rx="14" fill="#0b1016" stroke="${palette.cyan}" stroke-opacity="0.25"/>
    ${sealedRow(205, 62, 196, 29, 1)}
    ${sealedRow(205, 104, 196, 29, 0.72)}
    ${sealedRow(205, 146, 196, 29, 0.55)}
    <rect x="36" y="52" width="130" height="218" rx="24" fill="#05070a" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
    <rect x="48" y="80" width="106" height="160" rx="14" fill="#0b1016" stroke="${palette.mint}" stroke-opacity="0.22"/>
    ${sealedRow(62, 104, 76, 24, 1)}
    ${sealedRow(62, 142, 76, 24, 0.75)}
    ${sealedRow(62, 180, 76, 24, 0.56)}
    <path d="M138 64C226 -16 328 -18 420 52" fill="none" stroke="${palette.cyan}" stroke-opacity="0.72" stroke-width="2"/>
    <path d="M145 84C220 32 315 34 402 88" fill="none" stroke="${palette.mint}" stroke-opacity="0.55" stroke-width="2"/>
    <circle cx="235" cy="18" r="6" fill="${palette.cyan}"/>
    <circle cx="320" cy="31" r="5" fill="${palette.mint}"/>
  </g>`
}

function sealedRow (x, y, w, h, opacity = 1) {
  return `<g opacity="${opacity}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 3}" fill="#15202a" stroke="${palette.cyan}" stroke-opacity="0.22"/>
    <rect x="${x + 16}" y="${y + h * 0.36}" width="${w * 0.28}" height="3" rx="1.5" fill="${palette.cyan}" opacity="0.56"/>
    <rect x="${x + 16}" y="${y + h * 0.58}" width="${w * 0.5}" height="3" rx="1.5" fill="#ffffff" opacity="0.16"/>
    <circle cx="${x + w - 21}" cy="${y + h / 2}" r="${h * 0.19}" fill="${palette.mint}" opacity="0.82"/>
  </g>`
}

function headerAsset ({ name, w, h, title, title2, subtitle, eyebrow, footer, kind }) {
  const margin = Math.round(Math.min(w, h) * 0.14)
  const compact = h < 680
  const logoY = Math.round(h * (compact ? 0.22 : 0.2))
  const longestTitle = [title, title2].filter(Boolean).reduce((max, line) => Math.max(max, line.length), 1)
  const titleFit = (w - margin * 2) / (longestTitle * 0.58)
  const titleSize = Math.round(Math.min(w * 0.052, h * (compact ? 0.14 : 0.13), titleFit))
  const bodySize = Math.round(Math.min(w * 0.02, h * (compact ? 0.045 : 0.046)))
  const titleY = Math.round(h * (compact ? 0.52 : 0.46))
  const titleLineHeight = Math.round(titleSize * 1.08)
  const subtitleY = titleY + titleLineHeight * ([title, title2].filter(Boolean).length) + Math.round(bodySize * 1.2)
  const footerY = h - Math.round(h * (compact ? 0.16 : 0.15))
  const showSubtitle = !compact && subtitle
  const svg = svgFile(name, w, h, `
    ${backdrop(w, h, { imageOpacity: 0.86, shade: 0.42, focus: 'xMidYMid' })}
    ${wordmark(margin, logoY, Math.round(titleSize * (compact ? 0.56 : 0.48)), { subtitle: kind || brand.subtagline })}
    ${eyebrow ? textLines([eyebrow], margin, Math.round(h * (compact ? 0.38 : 0.34)), { size: Math.round(bodySize * 0.76), fill: palette.mint, weight: 720 }) : ''}
    ${textLines([title, title2].filter(Boolean), margin, titleY, { size: titleSize, lineHeight: titleLineHeight, fill: palette.text, weight: 780 })}
    ${showSubtitle ? textLines([subtitle], margin, subtitleY, { size: bodySize, lineHeight: Math.round(bodySize * 1.35), fill: palette.muted, weight: 520 }) : ''}
    ${footer ? pill(margin, footerY, footer, { height: Math.round(bodySize * 2.05), size: Math.round(bodySize * 0.78), width: Math.round(w * 0.3) }) : ''}
  `)
  return addLocalDefsForFade(svg)
}

function socialPreview ({ name, w, h, title, title2, subtitle, chips = [] }) {
  const margin = Math.round(w * 0.075)
  const titleSize = Math.round(w * 0.065)
  const bodySize = Math.round(w * 0.023)
  let chipMarkup = ''
  chips.forEach((chip, index) => {
    chipMarkup += pill(margin + index * Math.round(w * 0.22), h - Math.round(h * 0.18), chip, {
      width: Math.round(w * 0.19),
      height: Math.round(h * 0.065),
      size: Math.round(h * 0.03)
    })
  })
  const svg = svgFile(name, w, h, `
    ${backdrop(w, h, { imageOpacity: 0.86, shade: 0.46, focus: 'xMidYMid' })}
    ${wordmark(margin, Math.round(h * 0.21), Math.round(w * 0.046), { subtitle: brand.subtagline })}
    ${textLines([title, title2].filter(Boolean), margin, Math.round(h * 0.44), { size: titleSize, lineHeight: Math.round(titleSize * 1.08), fill: palette.text, weight: 800 })}
    ${textLines([subtitle], margin, Math.round(h * 0.68), { size: bodySize, fill: palette.muted, weight: 540 })}
    ${chipMarkup}
  `)
  return addLocalDefsForFade(svg)
}

function squarePost ({ name, title, title2, subtitle, mode = 'launch' }) {
  const w = 1080
  const h = 1080
  const isSecurity = mode === 'security'
  const subtitleLines = Array.isArray(subtitle) ? subtitle : [subtitle]
  const panel = isSecurity
    ? `<g transform="translate(560 204) scale(1.15)">
        <rect x="0" y="0" width="328" height="424" rx="28" fill="url(#darkGlass)" stroke="#ffffff" stroke-opacity="0.12" filter="url(#shadow)"/>
        ${sealedRow(42, 62, 244, 50, 1)}
        ${sealedRow(42, 140, 244, 50, 0.76)}
        ${sealedRow(42, 218, 244, 50, 0.58)}
        <text x="42" y="338" fill="${palette.mint}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="22" font-weight="700">verifier: pass</text>
        <text x="42" y="374" fill="${palette.faint}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="18">plaintext: 0 bytes</text>
      </g>`
    : miniDeviceStack(536, 206, 0.95)

  const svg = svgFile(name, w, h, `
    ${backdrop(w, h, { imageOpacity: 0.72, shade: 0.5, focus: 'xMidYMid' })}
    ${wordmark(88, 146, 58, { subtitle: brand.subtagline, subtitleSize: 18 })}
    ${textLines([title, title2].filter(Boolean), 88, 408, { size: 82, lineHeight: 88, fill: palette.text, weight: 810 })}
    ${textLines(subtitleLines, 88, 650, { size: 30, lineHeight: 39, fill: palette.muted, weight: 540 })}
    ${pill(88, 770, isSecurity ? 'Open verifier included' : 'No account required', { width: 286, height: 56, size: 22 })}
    ${panel}
  `)
  return addLocalDefsForFade(svg)
}

function storyAsset () {
  const w = 1080
  const h = 1920
  const svg = svgFile('Paste story', w, h, `
    ${backdrop(w, h, { imageOpacity: 0.72, shade: 0.55, focus: 'xMidYMid' })}
    ${wordmark(92, 216, 68, { subtitle: brand.subtagline, subtitleSize: 21 })}
    ${textLines(['Copy here.', 'Paste there.'], 92, 640, { size: 112, lineHeight: 124, fill: palette.text, weight: 820 })}
    ${textLines(['One private notepad across every device you own.'], 92, 940, { size: 39, fill: palette.muted, weight: 540 })}
    ${miniDeviceStack(164, 1080, 1.5)}
    ${pill(92, 1620, 'Encrypted before sync', { width: 368, height: 64, size: 24 })}
    ${pill(486, 1620, 'No cloud', { width: 218, height: 64, size: 24 })}
  `)
  return addLocalDefsForFade(svg)
}

function featureBullet (x, y, w, title, bodyLines, number) {
  const n = String(number).padStart(2, '0')
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="132" rx="18" fill="#ffffff" fill-opacity="0.035" stroke="#ffffff" stroke-opacity="0.105"/>
    <circle cx="${x + 42}" cy="${y + 44}" r="20" fill="url(#pasteGrad)" opacity="0.95"/>
    <text x="${x + 42}" y="${y + 51}" fill="#04130d" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="16" font-weight="800">${n}</text>
    <text x="${x + 78}" y="${y + 39}" fill="${palette.text}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="24" font-weight="740">${esc(title)}</text>
    ${textLines(bodyLines, x + 78, y + 73, { size: 18, lineHeight: 24, fill: palette.muted, weight: 520 })}
  </g>`
}

function featureOutlinePost ({ name, eyebrow, title, subtitle, features, slide }) {
  const w = 1080
  const h = 1080
  const titleLines = Array.isArray(title) ? title : [title]
  const subtitleLines = Array.isArray(subtitle) ? subtitle : [subtitle]
  const titleY = 360
  const titleLineHeight = 78
  const subtitleY = titleY + titleLines.length * titleLineHeight + 24
  const panelY = 628

  const svg = svgFile(name, w, h, `
    ${backdrop(w, h, { imageOpacity: 0.72, shade: 0.54, focus: 'xMidYMid' })}
    ${wordmark(88, 146, 58, { subtitle: brand.subtagline, subtitleSize: 18 })}
    ${textLines([eyebrow], 88, 282, { size: 21, fill: palette.mint, weight: 760 })}
    ${textLines(titleLines, 88, titleY, { size: 72, lineHeight: titleLineHeight, fill: palette.text, weight: 820 })}
    ${textLines(subtitleLines, 88, subtitleY, { size: 28, lineHeight: 37, fill: palette.muted, weight: 540 })}
    <rect x="72" y="${panelY}" width="936" height="382" rx="30" fill="#05070a" fill-opacity="0.52" stroke="#ffffff" stroke-opacity="0.08"/>
    ${featureBullet(108, panelY + 38, 410, features[0].title, features[0].body, 1)}
    ${featureBullet(562, panelY + 38, 410, features[1].title, features[1].body, 2)}
    ${featureBullet(108, panelY + 206, 410, features[2].title, features[2].body, 3)}
    ${featureBullet(562, panelY + 206, 410, features[3].title, features[3].body, 4)}
    <text x="948" y="150" fill="${palette.faint}" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="18" font-weight="700">${esc(slide)}</text>
  `)
  return addLocalDefsForFade(svg)
}

function wideFeatureOverview () {
  const w = 1600
  const h = 900
  const rows = [
    ['Private clipboard', 'Copy on one device and paste on another.'],
    ['Encrypted notes', 'Save snippets as sealed notes with local keys.'],
    ['Tap-to-decrypt', 'Rows stay sealed until you choose to open them.'],
    ['Peer-to-peer sync', 'No account, no cloud, optional blind relays.'],
    ['Open verifier', 'Inspect local storage and relay exports yourself.']
  ]

  const rowMarkup = rows.map((row, index) => {
    const y = 202 + index * 112
    return `<g>
      <rect x="918" y="${y}" width="556" height="86" rx="18" fill="#ffffff" fill-opacity="0.035" stroke="#ffffff" stroke-opacity="0.1"/>
      <circle cx="956" cy="${y + 43}" r="8" fill="${index % 2 === 0 ? palette.mint : palette.cyan}"/>
      <text x="986" y="${y + 35}" fill="${palette.text}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="25" font-weight="760">${esc(row[0])}</text>
      <text x="986" y="${y + 62}" fill="${palette.muted}" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-size="18" font-weight="520">${esc(row[1])}</text>
    </g>`
  }).join('\n')

  const svg = svgFile('Paste feature overview', w, h, `
    ${backdrop(w, h, { imageOpacity: 0.82, shade: 0.5, focus: 'xMidYMid' })}
    ${wordmark(96, 150, 62, { subtitle: brand.subtagline, subtitleSize: 18 })}
    ${textLines(['Product overview'], 96, 292, { size: 24, fill: palette.mint, weight: 760 })}
    ${textLines(['One private', 'notepad for', 'every device.'], 96, 388, { size: 72, lineHeight: 78, fill: palette.text, weight: 830 })}
    ${textLines(['Paste syncs clipboard text and private notes', 'across your own devices, encrypted locally', 'before anything touches the network.'], 96, 650, { size: 28, lineHeight: 38, fill: palette.muted, weight: 540 })}
    ${pill(96, 760, 'No account', { width: 188, height: 54, size: 22 })}
    ${pill(308, 760, 'No cloud', { width: 170, height: 54, size: 22 })}
    ${pill(502, 760, 'Open source', { width: 214, height: 54, size: 22 })}
    <rect x="882" y="154" width="628" height="642" rx="34" fill="#05070a" fill-opacity="0.54" stroke="#ffffff" stroke-opacity="0.08"/>
    ${rowMarkup}
  `)
  return addLocalDefsForFade(svg)
}

function profilePicture () {
  const w = 1080
  const h = 1080
  return svgFile('Paste profile picture', w, h, `
    <rect width="${w}" height="${h}" rx="236" fill="${palette.bg}"/>
    <circle cx="540" cy="540" r="470" fill="url(#mintGlow)"/>
    <circle cx="540" cy="540" r="382" fill="#0b1016" stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
    <circle cx="540" cy="540" r="312" fill="#101821" stroke="url(#pasteGrad)" stroke-opacity="0.28" stroke-width="3"/>
    ${pasteMark(264, 236, 552)}
    <circle cx="744" cy="300" r="34" fill="${palette.mint}" opacity="0.22" filter="url(#blurGlow)"/>
    <circle cx="332" cy="812" r="42" fill="${palette.cyan}" opacity="0.16" filter="url(#blurGlow)"/>
  `)
}

function socialIcon () {
  const w = 1024
  const h = 1024
  return svgFile('Paste social icon', w, h, `
    <rect width="${w}" height="${h}" rx="224" fill="${palette.bg}"/>
    <rect x="64" y="64" width="896" height="896" rx="198" fill="url(#darkGlass)" stroke="#ffffff" stroke-opacity="0.1" stroke-width="4"/>
    <circle cx="512" cy="512" r="410" fill="url(#mintGlow)"/>
    ${pasteMark(248, 216, 528)}
  `)
}

function transparentMark () {
  return svgFile('Paste transparent mark', 512, 512, `
    ${pasteMark(64, 44, 384)}
  `, { transparent: true })
}

const editableAssets = [
  {
    file: 'og-image.svg',
    section: 'headers',
    png: 'og-image-1200x630.png',
    w: 1200,
    h: 630,
    usage: 'Open Graph / website preview',
    svg: socialPreview({
      name: 'Paste Open Graph image',
      w: 1200,
      h: 630,
      title: 'One notepad.',
      title2: 'Every device you own.',
      subtitle: brand.description,
      chips: ['No accounts', 'Encrypted local-first', 'Open verifier']
    })
  },
  {
    file: 'github-social-preview.svg',
    section: 'headers',
    png: 'github-social-preview-1280x640.png',
    w: 1280,
    h: 640,
    usage: 'GitHub repository social preview',
    svg: socialPreview({
      name: 'Paste GitHub social preview',
      w: 1280,
      h: 640,
      title: 'Private clipboard sync,',
      title2: 'open source and auditable.',
      subtitle: 'Paste keeps notes and clips encrypted on-device before peer-to-peer sync.',
      chips: ['Apache-2.0', 'No telemetry', 'Verifier included']
    })
  },
  {
    file: 'x-header.svg',
    section: 'banners',
    png: 'x-header-1500x500.png',
    w: 1500,
    h: 500,
    usage: 'X / Twitter profile header',
    svg: headerAsset({
      name: 'Paste X header',
      w: 1500,
      h: 500,
      title: 'One notepad.',
      title2: 'Every device you own.',
      subtitle: 'Private clipboard and notes sync. Encrypted on-device.',
      eyebrow: 'Copy here. Paste there.',
      footer: '',
      kind: 'private clipboard'
    })
  },
  {
    file: 'linkedin-banner.svg',
    section: 'banners',
    png: 'linkedin-banner-1584x396.png',
    w: 1584,
    h: 396,
    usage: 'LinkedIn company page banner',
    svg: headerAsset({
      name: 'Paste LinkedIn banner',
      w: 1584,
      h: 396,
      title: 'Private notes and clips,',
      title2: 'wherever you work.',
      subtitle: 'Encrypted locally before peer-to-peer sync.',
      eyebrow: 'Paste for every device',
      footer: 'Open source and auditable',
      kind: 'encrypted on-device'
    })
  },
  {
    file: 'facebook-cover.svg',
    section: 'banners',
    png: 'facebook-cover-1640x624.png',
    w: 1640,
    h: 624,
    usage: 'Facebook page cover',
    svg: headerAsset({
      name: 'Paste Facebook cover',
      w: 1640,
      h: 624,
      title: 'Copy here.',
      title2: 'Paste there.',
      subtitle: 'One private notepad that follows you across devices.',
      eyebrow: 'Private clipboard / notes sync',
      footer: 'Encrypted on-device',
      kind: 'no account / no cloud'
    })
  },
  {
    file: 'youtube-header.svg',
    section: 'banners',
    png: 'youtube-header-2560x1440.png',
    w: 2560,
    h: 1440,
    usage: 'YouTube channel art, centered for the safe area',
    svg: headerAsset({
      name: 'Paste YouTube header',
      w: 2560,
      h: 1440,
      title: 'One notepad.',
      title2: 'Every device you own.',
      subtitle: 'Private clipboard and notes sync. Encrypted on-device.',
      eyebrow: 'Copy here. Paste there.',
      footer: 'No account / no cloud / open verifier',
      kind: 'private clipboard'
    })
  },
  {
    file: 'website-hero.svg',
    section: 'headers',
    png: 'website-hero-2400x900.png',
    w: 2400,
    h: 900,
    usage: 'Wide website hero or press-kit banner',
    svg: headerAsset({
      name: 'Paste website hero',
      w: 2400,
      h: 900,
      title: 'One notepad.',
      title2: 'Every device you own.',
      subtitle: 'Copy on your laptop, paste on your phone. Fully encrypted before sync.',
      eyebrow: 'Private clipboard / encrypted on-device',
      footer: 'No account / no cloud / no plaintext on relays',
      kind: 'open source and auditable'
    })
  },
  {
    file: 'launch-post.svg',
    section: 'posts',
    png: 'launch-post-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Square launch post',
    svg: squarePost({
      name: 'Paste launch post',
      title: 'Copy here.',
      title2: 'Paste there.',
      subtitle: 'One private notepad across every device you own.'
    })
  },
  {
    file: 'security-post.svg',
    section: 'posts',
    png: 'security-post-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Square security post',
    svg: squarePost({
      name: 'Paste security post',
      title: 'No account.',
      title2: 'No cloud.',
      subtitle: ['Encrypted before sync.', 'Verifier included.'],
      mode: 'security'
    })
  },
  {
    file: 'feature-product-overview.svg',
    section: 'features',
    png: 'feature-product-overview-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Feature card: product overview',
    svg: featureOutlinePost({
      name: 'Paste product overview feature card',
      eyebrow: 'What Paste does',
      title: ['One notepad', 'for every device.'],
      subtitle: ['Clipboard text and private notes,', 'encrypted locally before sync.'],
      slide: '01 / 05',
      features: [
        { title: 'Private clipboard', body: ['Copy text, links, and code', 'between your own devices.'] },
        { title: 'Private notes', body: ['Save snippets as encrypted', 'notes you can pin.'] },
        { title: 'Local search', body: ['Find clips and notes without', 'sending queries away.'] },
        { title: 'Open verifier', body: ['Audit local storage for', 'plaintext yourself.'] }
      ]
    })
  },
  {
    file: 'feature-cross-device-sync.svg',
    section: 'features',
    png: 'feature-cross-device-sync-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Feature card: cross-device sync',
    svg: featureOutlinePost({
      name: 'Paste cross-device sync feature card',
      eyebrow: 'Copy here. Paste there.',
      title: ['Your clipboard,', 'already there.'],
      subtitle: ['Devices sync directly when they can,', 'then catch up when they reconnect.'],
      slide: '02 / 05',
      features: [
        { title: 'Peer-to-peer sync', body: ['Built on the Pear and', 'Holepunch stack.'] },
        { title: 'Offline-first', body: ['Your notes stay usable', 'with zero network.'] },
        { title: 'Blind relays', body: ['Optional availability for', 'encrypted blocks only.'] },
        { title: 'Clipboard TTL', body: ['Recent clips expire instead', 'of lingering forever.'] }
      ]
    })
  },
  {
    file: 'feature-security-model.svg',
    section: 'features',
    png: 'feature-security-model-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Feature card: security model',
    svg: featureOutlinePost({
      name: 'Paste security model feature card',
      eyebrow: 'Security model',
      title: ['Encrypted', 'on-device.'],
      subtitle: ['No account. No cloud. No plaintext', 'on relays. That is the line.'],
      slide: '03 / 05',
      features: [
        { title: 'Local-only keys', body: ['Keys are derived and kept', 'on your own device.'] },
        { title: 'Ciphertext relays', body: ['Relays store encrypted', 'blocks, never notes.'] },
        { title: 'Signed changes', body: ['Devices sign each operation', 'before it is accepted.'] },
        { title: 'Tap-to-decrypt', body: ['Rows stay sealed until', 'you open or copy.'] }
      ]
    })
  },
  {
    file: 'feature-notes-search.svg',
    section: 'features',
    png: 'feature-notes-search-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Feature card: notes and search',
    svg: featureOutlinePost({
      name: 'Paste notes and search feature card',
      eyebrow: 'Notes and search',
      title: ['Save, pin,', 'and find it fast.'],
      subtitle: ['Keep snippets close without turning', 'your notes into cloud data.'],
      slide: '04 / 05',
      features: [
        { title: 'Encrypted notes', body: ['Titles and bodies are', 'sealed before storage.'] },
        { title: 'Pinned snippets', body: ['Keep frequent clips ready', 'without hunting.'] },
        { title: 'Blinded index', body: ['Search tokens are keyed', 'for local lookup.'] },
        { title: 'Fast local search', body: ['Search happens on-device,', 'not on a server.'] }
      ]
    })
  },
  {
    file: 'feature-pairing-recovery.svg',
    section: 'features',
    png: 'feature-pairing-recovery-1080x1080.png',
    w: 1080,
    h: 1080,
    usage: 'Feature card: pairing and recovery',
    svg: featureOutlinePost({
      name: 'Paste pairing and recovery feature card',
      eyebrow: 'Pairing and recovery',
      title: ['Add devices', 'without accounts.'],
      subtitle: ['Pair with proof, revoke devices,', 'recover from your phrase.'],
      slide: '05 / 05',
      features: [
        { title: 'QR pairing', body: ['Add a device with a', 'local approval flow.'] },
        { title: 'Human check', body: ['Confirm a short phrase', 'before trusting.'] },
        { title: 'Device keys', body: ['Each device gets its own', 'signing identity.'] },
        { title: 'Recovery phrase', body: ['A 24-word phrase restores', 'your vault.'] }
      ]
    })
  },
  {
    file: 'feature-overview-wide.svg',
    section: 'features',
    png: 'feature-overview-wide-1600x900.png',
    w: 1600,
    h: 900,
    usage: 'Wide feature overview image',
    svg: wideFeatureOverview()
  },
  {
    file: 'story.svg',
    section: 'posts',
    png: 'story-1080x1920.png',
    w: 1080,
    h: 1920,
    usage: 'Instagram / TikTok / YouTube Shorts story',
    svg: storyAsset()
  },
  {
    file: 'profile-picture.svg',
    section: 'profiles',
    png: 'profile-picture-800x800.png',
    w: 800,
    h: 800,
    extraExports: [
      { section: 'profiles', png: 'profile-picture-400x400.png', w: 400, h: 400 }
    ],
    usage: 'Social account profile picture',
    svg: profilePicture()
  },
  {
    file: 'social-icon.svg',
    section: 'icons',
    png: 'social-icon-512x512.png',
    w: 512,
    h: 512,
    extraExports: [
      { section: 'icons', png: 'social-icon-256x256.png', w: 256, h: 256 },
      { section: 'icons', png: 'social-icon-1024x1024.png', w: 1024, h: 1024 }
    ],
    usage: 'Marketing social icon',
    svg: socialIcon()
  },
  {
    file: 'paste-mark.svg',
    section: 'icons',
    png: 'paste-mark-512x512.png',
    w: 512,
    h: 512,
    extraExports: [
      { section: 'icons', png: 'paste-mark-64x64.png', w: 64, h: 64 },
      { section: 'icons', png: 'paste-mark-128x128.png', w: 128, h: 128 },
      { section: 'icons', png: 'paste-mark-256x256.png', w: 256, h: 256 }
    ],
    usage: 'Transparent Paste mark',
    svg: transparentMark()
  }
]

write(path.join(dirs.source, 'palette.css'), `:root {
  --paste-bg: ${palette.bg};
  --paste-bg-2: ${palette.bg2};
  --paste-surface: ${palette.surface};
  --paste-text: ${palette.text};
  --paste-muted: ${palette.muted};
  --paste-faint: ${palette.faint};
  --paste-mint: ${palette.mint};
  --paste-cyan: ${palette.cyan};
  --paste-blue: ${palette.blue};
  --paste-violet: ${palette.violet};
  --paste-gradient: linear-gradient(120deg, ${palette.mint} 0%, ${palette.cyan} 60%, ${palette.blue} 100%);
}
`)

write(path.join(dirs.source, 'paste-mark.svg'), svgFile('Paste mark source', 512, 512, `
  ${pasteMark(64, 44, 384)}
`, { transparent: true }))

if (!fs.existsSync(path.join(dirs.source, 'campaign-backdrop-prompt.md'))) {
  write(path.join(dirs.source, 'campaign-backdrop-prompt.md'), `# Campaign Backdrop Prompt

Generated with the built-in image generation tool.

Use case: ads-marketing
Asset type: no-text campaign backdrop for Paste social banners and launch graphics
Primary request: Create a premium dark marketing backdrop for a privacy-first encrypted clipboard and notes app called Paste. No text, no logos, no watermarks.
Scene/backdrop: deep near-black interface-inspired environment with subtle layered glass panels, sealed-note rows, device-to-device sync arcs, and a restrained mint/cyan glow. It should feel private, technical, calm, and trustworthy, with visual hints of local encryption and peer-to-peer syncing.
Subject: abstract product world for a secure cross-device clipboard app, no readable UI text.
Composition: wide, clean negative space through the center and upper left so precise brand typography can be overlaid later. Avoid busy clutter.
Style: polished product-marketing render, crisp but understated, dark background, mint #4ade80 and cyan #22d3ee accents with a tiny amount of blue-violet, no single-color monotony.
Constraints: absolutely no words, no letters, no numbers, no people, no corporate stock-photo style, no giant lock icon, no watermark.
`)
}

for (const asset of editableAssets) {
  write(path.join(dirs.editable, asset.file), asset.svg)
}

write(path.join(dirs.icons, 'paste-mark.svg'), transparentMark())
write(path.join(dirs.icons, 'social-icon.svg'), socialIcon())

const exports = []
function exportedPngPath (section, file) {
  return section === 'icons' ? path.join('icons', file) : path.join('png', section, file)
}

for (const asset of editableAssets) {
  exports.push({
    source: path.join(dirs.editable, asset.file),
    out: path.join(dirs[asset.section], asset.png),
    w: asset.w,
    h: asset.h,
    usage: asset.usage,
    editable: path.join('editable', asset.file),
    png: exportedPngPath(asset.section, asset.png)
  })
  for (const extra of asset.extraExports || []) {
    exports.push({
      source: path.join(dirs.editable, asset.file),
      out: path.join(dirs[extra.section], extra.png),
      w: extra.w,
      h: extra.h,
      usage: asset.usage,
      editable: path.join('editable', asset.file),
      png: exportedPngPath(extra.section, extra.png)
    })
  }
}

let rsvgAvailable = true
for (const item of exports) {
  const result = spawnSync('rsvg-convert', [
    '--width', String(item.w),
    '--height', String(item.h),
    '--keep-aspect-ratio',
    '--format', 'png',
    '--output', item.out,
    item.source
  ], { cwd: root, encoding: 'utf8' })

  if (result.status !== 0) {
    rsvgAvailable = false
    console.error(result.stderr || result.stdout || `Failed to render ${item.out}`)
    break
  }
}

const manifest = {
  brand,
  generatedWith: 'assets/marketing/generate.mjs',
  source: {
    palette: 'source/palette.css',
    mark: 'source/paste-mark.svg',
    backdrop: hasBackdrop ? 'source/campaign-backdrop.png' : null,
    backdropPrompt: 'source/campaign-backdrop-prompt.md'
  },
  assets: exports.map(item => ({
    usage: item.usage,
    editable: item.editable,
    png: item.png,
    width: item.w,
    height: item.h
  }))
}

write(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

write(path.join(root, 'README.md'), `# Paste Marketing Assets

Upload-ready marketing assets for Paste social profiles, launch posts, website previews, and press materials.

## Quick Picks

- Profile picture: \`png/profiles/profile-picture-400x400.png\`
- X / Twitter header: \`png/banners/x-header-1500x500.png\`
- LinkedIn banner: \`png/banners/linkedin-banner-1584x396.png\`
- YouTube channel art: \`png/banners/youtube-header-2560x1440.png\`
- Open Graph image: \`png/headers/og-image-1200x630.png\`
- GitHub social preview: \`png/headers/github-social-preview-1280x640.png\`
- Launch post: \`png/posts/launch-post-1080x1080.png\`
- Security post: \`png/posts/security-post-1080x1080.png\`
- Feature overview: \`png/features/feature-overview-wide-1600x900.png\`
- Feature card carousel:
  - \`png/features/feature-product-overview-1080x1080.png\`
  - \`png/features/feature-cross-device-sync-1080x1080.png\`
  - \`png/features/feature-security-model-1080x1080.png\`
  - \`png/features/feature-notes-search-1080x1080.png\`
  - \`png/features/feature-pairing-recovery-1080x1080.png\`
- Story format: \`png/posts/story-1080x1920.png\`
- Transparent mark: \`icons/paste-mark-512x512.png\`

## Brand

- Display name: \`${brand.name}\`
- Tagline: \`${brand.tagline}\`
- Support line: \`${brand.subtagline}\`
- Short copy: \`${brand.description}\`

Use \`source/palette.css\` for colors and \`source/paste-mark.svg\` for the canonical mark.

## Editable Sources

The \`editable/\` SVG files are the source of truth for layout and exact copy. PNG exports live under \`png/\`, grouped by usage.

## Regenerate

\`\`\`sh
node assets/marketing/generate.mjs
\`\`\`

To replace the no-text campaign backdrop, generate or choose a new PNG and run:

\`\`\`sh
node assets/marketing/generate.mjs --backdrop /absolute/path/to/backdrop.png
\`\`\`

This script uses \`rsvg-convert\` for PNG export. If it is missing, the editable SVG files are still usable.
`)

if (!rsvgAvailable) {
  process.exitCode = 1
} else {
  console.log(`Generated ${exports.length} PNG exports in ${path.relative(process.cwd(), root)}`)
}
