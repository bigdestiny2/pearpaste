// Paste fleet configuration — EMPTY by default. Pure DHT auto-discovery.
//
// Paste is a Pear-native app. The Pear runtime gives us real UDP sockets and
// HyperDHT, so `p2p-hiverelay-client` discovers relays automatically over its
// hardcoded `RELAY_DISCOVERY_TOPIC` — every operator's relays appear there.
// No operator-specific config is required to pair, sync, or use store-and-
// forward. Out of the box: `new HiveRelayClient({ swarm, store }); await
// client.start()` — that's it. (Previously this file shipped 5 hardcoded
// "trust floor" pubkeys; that was scaffolding from a non-native architecture
// and centralised trust on a single operator's fleet, so it's gone.)
//
// This file remains ONLY as a deployment knob for advanced operators who
// genuinely want to pin a fleet (e.g. a private corporate deployment that
// ONLY trusts its own relays). Leave everything empty for the default
// behaviour any normal user wants.
//
// Override at install time without rebuilding:
//   - Per-install: drop `fleet-relays.json` into Pear.config.storage with the
//                  same shape: { foundationPubkeys, knownRelays, bootstrap }.
//   - Env var:     PEARPASTE_RELAYS="wss://host=hex,wss://host=hex" (WSS-bridge
//                  pinning for browser/mobile clients only — not relevant to
//                  Pear-native desktop).

export default {
  // Pinned operator fleet (DHT identities). Empty = trust whatever the SDK
  // discovers over `RELAY_DISCOVERY_TOPIC`. This is the right default for
  // every native Pear deployment.
  foundationPubkeys: [],

  // WSS DHT-bridge pinning for clients that can't speak the DHT directly
  // (browser, WebView/PWA mobile shells). Pear-native desktop doesn't need
  // this — empty by default.
  knownRelays: {
    // 'wss://dht-relay.example.com': '<64-hex-pubkey>'
  },

  // Extra DHT bootstrap pubkeys (Pear/Hyperswarm defaults work; never set
  // unless you know exactly which DHT you're talking to).
  bootstrap: []
}
