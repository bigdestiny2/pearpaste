# PearPaste — Launch Kit (draft)

Copy for launch across social + community channels. Voice: confident, **specific, honest** — the privacy/dev crowd punishes hype, so we lean on *provable* over "maximally secure." Edit freely.

> **Name note:** repo/infra is `pearpaste`; the desktop window says `Paste`. For launch I'd use **PearPaste** everywhere — "Paste" alone is unsearchable/unbrandable and collides with a dozen apps. Lock one name before posting.

> **Fill-ins:** `[download]` (per-OS bundle links) · `[repo]` = github.com/bigdestiny2/pearpaste (must be **public** at launch — it's private now) · `[holepunch]` (their handle).

---

## 0. Core positioning

**One-liner:** Your notes and clipboard, end-to-end encrypted and synced across every device you own — no account, no server, no one (not even us) able to read them. And you don't have to take our word for it.

**Pain point (universal):** You email yourself notes. You paste passwords into Slack to get them to your phone. You AirDrop snippets between your own laptop and desktop. Everyone does it — and it's clumsy *and* leaky.

**The promise:** One private notepad + clipboard that follows you everywhere. Encrypted on your device, synced peer-to-peer between *your* devices. No cloud account. No server holding your data. And a verifier you can run to **prove** there's no plaintext anywhere.

---

## 1. Social posts

### X — hero (launch tweet)
> You email yourself notes. You paste passwords into chat to get them to your phone. We all do it. It's gross.
>
> **PearPaste**: one encrypted notepad + clipboard, synced across all your devices. No account. No server. No one can read it — and you can *prove* it.
>
> Free + open source 🍐🔒 [download]

### X — thread
1/ We all do the same leaky thing: email ourselves notes, paste secrets into chat, AirDrop snippets between our own devices. There's never been a clean, private way to just *have your stuff everywhere*. So we built one.

2/ PearPaste is an end-to-end encrypted notepad + clipboard that syncs across your Mac, Windows & Linux (iOS/Android in weeks). Pair devices with a QR code. Your notes + copied text follow you — encrypted the whole way.

3/ No account. No server. No company in the middle — not even us. It's pure peer-to-peer (built on Pear / [holepunch]). Your devices talk directly; the relays that help them find each other only ever see ciphertext.

4/ Here's the part nobody else does — **provable privacy**. Most apps say "we can't read your data, trust us." PearPaste ships an open verifier: run it, it scans the stored bytes and shows you there's *zero* plaintext. Encryption you can audit, not a policy you have to believe.

5/ It's open source (Apache-2.0). Devs — the full repo's on GitHub. Audit it, run it, try to break it. We *want* the scrutiny. [repo]

6/ And for everyone else: just download the app and go. You never need to know there's a P2P network under the hood. Mac/Windows/Linux today; iOS + Android in the coming weeks.

7/ Free. Private. Yours. → [download]

### Show HN
**Title:** Show HN: PearPaste – E2E-encrypted notes + clipboard sync, no servers, with a verifier

**Body:**
> PearPaste is a personal notes + clipboard sync app with no servers and no accounts. It's built on Pear/Holepunch (Hypercore, Autobase multiwriter, Hyperswarm/HyperDHT), so your devices sync peer-to-peer; everything is end-to-end encrypted with libsodium, and the relays that help peers find each other (and hold encrypted data while a device is offline) only ever receive ciphertext, encrypted roots, and signed receipts — never plaintext or keys.
>
> The thing I most want feedback on is **provable privacy**. Instead of asking you to trust a privacy policy, it ships a verifier (CLI + in-app) that scans on-disk storage, relay exports, and logs for a plaintext marker and confirms every stored record is AEAD-encrypted and signed — so you can independently confirm there's no leak. There's a spec to build your own.
>
> Open source (Apache-2.0). Native bundles for macOS/Windows/Linux so non-technical folks can use it without knowing Pear is underneath; iOS + Android soon. Recovery is a BIP39 phrase; pairing is a QR code. Threat model, security model, and the verifier spec are all in /docs.
>
> Roast the crypto and the multiwriter sync model. [repo]

### Dev chat / Holepunch community (audit invite)
> Built something on Pear I'd genuinely like eyes on: **PearPaste** — E2E-encrypted notes + clipboard sync, fully P2P (Hypercore + Autobase multiwriter + Hyperswarm), libsodium envelopes (XChaCha20-Poly1305 + Ed25519-signed ops), blind HiveRelay store-and-forward (relays only ever get ciphertext / roots / signed receipts — never plaintext or keys). Recovery via BIP39, pairing via QR + a libsodium sealed-box handshake.
>
> Full repo's on GitHub — inviting a real audit, especially: the Autobase multiwriter **authorization** model (device add/revoke, key epochs), the envelope/**AAD** domain separation, the pairing handshake, and the **relay-blindness** guard. Threat model + security doc + an independent verifier spec are all in /docs. `npm run test:all`, run the verifier against a vault, try to find plaintext. Roast it. [repo]

### Reddit (r/privacy / r/selfhosted)
**Title:** I built an E2E-encrypted notes + clipboard sync app with no servers — and a verifier so you can *prove* the privacy yourself [open source]

**Body:** (use the normie + "how it's private" explanations below; lead with "no server, no account, and you can run the verifier to confirm there's no plaintext.")

---

## 2. Community explanations

### For everyone ("normie")
**What is it?** PearPaste is a private notepad that's on all your devices at once. Write a note on your laptop — it's on your phone. Copy something on your phone — paste it on your desktop.

**Why it's different:** Your stuff is locked (encrypted) on your own device *before* it moves, and it travels straight between your devices — it never sits on some company's server. There's no account to create and nothing to log into. Even we can't see your notes.

**How to use it:** Download it for Mac, Windows, or Linux. Scan a QR code to link your devices. That's it. (iOS and Android are coming very soon.)

### How it's private — and why you don't have to trust us
1. **End-to-end encrypted.** Your notes and clips are encrypted on your device with keys only your devices hold. They're only ever decrypted on your devices.
2. **No servers.** There's no cloud database with your data — your devices sync directly, peer-to-peer. The only helpers in the network ("relays") just pass along *encrypted* blobs when a device is offline; they only ever see ciphertext, never your content or your keys.
3. **Provable, not promised.** Most privacy apps ask you to trust them. PearPaste ships a **verifier** — run it and it inspects everything stored on disk (and anything a relay holds) and confirms there's no readable text, only encrypted + signed data. Prove the claim yourself, or read the spec and build your own checker.

Recovery is a 24-word phrase you keep (like a crypto wallet). Lose a device → restore from the phrase. We never have it.

### For developers (architecture + what to audit)
Built on the **Pear/Holepunch** stack. Each device is a **Hypercore** writer; multi-device state is an **Autobase** multiwriter log materialized into a *sealed* **Hyperbee** view; devices find + sync over **Hyperswarm/HyperDHT**. Crypto is **libsodium**: XChaCha20-Poly1305 AEAD envelopes, Ed25519-signed ops, an HKDF key hierarchy rooted in a BIP39 seed. An optional **HiveRelay** layer does encrypted store-and-forward + "atomic blind custody" for clips — relays receive only ciphertext, roots, commitments, and signed receipts, enforced by an explicit blindness guard.

**Worth auditing:** the multiwriter authorization model (device add/revoke, key epochs), envelope/AAD domain separation, the pairing handshake, and relay-blindness enforcement. See `docs/THREAT_MODEL.md`, `docs/SECURITY.md`, `docs/VERIFIER_SPEC.md`. `npm run test:all`, then run the verifier against a real vault.

---

## 3. FAQ / talking points
- **What's the catch?** None. No server means nothing to monetize and nothing to breach. Open source so you can confirm it.
- **Do I need to know Pear/Holepunch?** No. Download the app and use it. Pear is the engine; you just drive.
- **Is it free?** Yes — free and open source (Apache-2.0).
- **Can *you* read my notes?** No. No server holds your data and we hold no key — and the verifier lets you prove it.
- **Is it anonymous?** It keeps your *content* private (encrypted, server-blind). It's not an anonymity tool — peers/relays still operate at the network layer. We're precise about that on purpose.
- **Lost device?** Your 24-word recovery phrase restores everything.
- **iOS/Android?** In the coming weeks.

---

## 4. Pre-launch checklist (so the copy stays honest)
- [ ] **Ship the silent-note-loss fix** in the bundles before posting (sync must be rock-solid for "syncs across your devices" claims).
- [ ] **Build + host the native bundles** (mac/win/linux) and fill `[download]` — the install-flow page is staged; flip to real links.
- [ ] **Make the repo public** (`[repo]` is private now) — the audit invite needs it.
- [ ] **Lock the public name** (PearPaste vs Paste).
- [ ] **Stage + seed the production `pear://` link** so installs actually run.
- [ ] Confirm the verifier one-liner in the README so the "prove it" CTA lands instantly.
</content>
