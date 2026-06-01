/* Paste site — tiny, dependency-free, no network calls. */
(function () {
  'use strict'
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Year
  var yr = document.getElementById('yr')
  if (yr) yr.textContent = new Date().getFullYear()

  // Header shadow on scroll
  var header = document.querySelector('header')
  var onScroll = function () {
    if (!header) return
    header.classList.toggle('scrolled', window.scrollY > 8)
  }
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })

  // Mobile drawer
  var btn = document.getElementById('menuBtn')
  var drawer = document.getElementById('drawer')
  function setDrawer (open) {
    if (!drawer || !btn) return
    drawer.classList.toggle('open', open)
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  if (btn) btn.addEventListener('click', function () {
    setDrawer(!drawer.classList.contains('open'))
  })
  if (drawer) drawer.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') setDrawer(false)
  })
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false) })

  // Scroll reveal
  var reveals = [].slice.call(document.querySelectorAll('.reveal'))
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in') })
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) }
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
    reveals.forEach(function (el) { if (!el.classList.contains('in')) io.observe(el) })
  }

  // Hero copy→paste demo
  var typedText = document.getElementById('typedText')
  var sealMsg = document.getElementById('sealMsg')
  var noteCard = document.getElementById('noteCard')
  var revealText = document.getElementById('revealText')
  var SNIPPET = 'ssh deploy@paste.prod -i ~/.keys/id_ed25519'

  function type (str, i, done) {
    if (!typedText) return
    typedText.textContent = str.slice(0, i)
    if (i <= str.length) setTimeout(function () { type(str, i + 1, done) }, 34)
    else if (done) setTimeout(done, 650)
  }

  var sealed = true
  function sealView () {
    sealed = true
    if (noteCard) noteCard.classList.remove('revealed')
    if (revealText) revealText.textContent = 'Sealed clip — tap to decrypt'
  }
  function revealView () {
    sealed = false
    if (noteCard) noteCard.classList.add('revealed')
    if (revealText) revealText.textContent = SNIPPET
  }
  if (noteCard) {
    noteCard.style.cursor = 'pointer'
    noteCard.setAttribute('role', 'button')
    noteCard.setAttribute('tabindex', '0')
    noteCard.setAttribute('aria-label', 'Sealed clip — activate to decrypt on this device')
    var toggle = function () { sealed ? revealView() : sealView() }
    noteCard.addEventListener('click', toggle)
    noteCard.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
    })
  }

  function runDemo () {
    if (reduce) {
      if (typedText) typedText.textContent = SNIPPET
      if (sealMsg) sealMsg.textContent = 'Sealed with a local-only key · synced peer-to-peer'
      return
    }
    type(SNIPPET, 0, function () {
      if (sealMsg) sealMsg.textContent = 'Sealed with a local-only key · syncing peer-to-peer…'
      setTimeout(function () {
        if (sealMsg) sealMsg.textContent = 'Sealed · delivered to your other devices'
      }, 1100)
    })
  }
  // Kick the demo when the hero is on screen
  var demo = document.querySelector('.demo')
  if (demo && 'IntersectionObserver' in window && !reduce) {
    var dio = new IntersectionObserver(function (e) {
      if (e[0].isIntersecting) { runDemo(); dio.disconnect() }
    }, { threshold: 0.3 })
    dio.observe(demo)
  } else {
    runDemo()
  }

  // Smooth-scroll offset for sticky header on hash links
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]')
    if (!a) return
    var id = a.getAttribute('href')
    if (id === '#' || id === '#top') return
    var t = document.querySelector(id)
    if (!t) return
    e.preventDefault()
    var y = t.getBoundingClientRect().top + window.scrollY - 74
    window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' })
    history.replaceState(null, '', id)
  })
})()
