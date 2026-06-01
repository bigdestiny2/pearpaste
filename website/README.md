# Paste — marketing site

Static, self-contained marketing site for **Paste** (internal package name:
`pearpaste`). No build step, no framework, **no remote assets or network
calls** — deliberately on-brand: the product never phones home, neither does
its site.

```
website/
  index.html      all sections (hero, features, security, proof, how, platforms, honesty, FAQ, CTA)
  styles.css       design system: dark, aurora field, glass cards, fully responsive, reduced-motion aware
  app.js           scroll-reveal, mobile drawer, sticky header, hero copy→paste demo, tap-to-decrypt
  assets/logo.svg  gradient clipboard+lock mark (also the favicon / og image)
```

## Preview locally

```sh
cd website
python3 -m http.server 8899
# open http://localhost:8899
```

Any static server works (`npx serve`, `caddy file-server`, etc.).

## Deploy

It's plain static files — drop `website/` on any static host:

- **Netlify / Vercel / Cloudflare Pages**: point the project at `website/` (no build command, output dir `.`).
- **GitHub Pages**: publish the `website/` folder.
- **Pear / HiveRelay**: it can also be staged and pinned like any static bundle
  so the marketing page is itself peer-to-peer hosted.

No environment variables, no secrets, no backend.

## Copy compliance (important)

All copy honors the technical spec's wording rules:

- **§4 / §19** — the site never claims "anonymous", "guaranteed deletion",
  "no metadata leakage", "provable physical deletion", or unqualified
  "fully encrypted guaranteed". Those phrases appear **only** as explicit
  *disclaimers* in the "What we won't claim" section, the FAQ, and the footer.
- The honesty is treated as a feature ("Radical honesty" section), which is
  both compliant and a genuine differentiator.

If you edit copy, keep the guard green:

```sh
node -e 'const h=require("fs").readFileSync("website/index.html","utf8");
for (const r of [/\bno metadata leakage\b/i,/\bguaranteed anonymous\b/i,/\bunhackable\b/i,/\bcloud sync\b/i])
  if (r.test(h)) { console.error("FORBIDDEN CLAIM:", r.source); process.exit(1) }
console.log("wording OK")'
```

(Disclaiming "provable physical deletion" / "anonymous" is required and
expected — only *claiming* them is forbidden.)
