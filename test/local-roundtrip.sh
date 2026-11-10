#!/usr/bin/env bash
# Same-machine round trip: a host and a guest exchange messages over 127.0.0.1.
# Usage: test/local-roundtrip.sh            (local, no tunnel)
#        TUNNEL=1 test/local-roundtrip.sh   (real cloudflared quick tunnels)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
R="node $HERE/../skills/relay/scripts/relay.mjs"
T="$(mktemp -d)"
A="$T/host" B="$T/guest"
MODE=--local; [ "${TUNNEL:-}" = 1 ] && MODE=
cleanup() { RELAY_HOME=$A $R close --purge >/dev/null 2>&1 || true; RELAY_HOME=$B $R close --purge >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
# Tick until the peer is reachable. New quick-tunnel hostnames take ~15s to hit public DNS.
tick() { local out; for _ in $(seq 1 20); do out=$(RELAY_HOME=$1 $R tick); echo "$out" | grep -q '"peer_reachable": true' && break; sleep 3; done; echo "$out"; }

INVITE=$(RELAY_HOME=$A $R start $MODE | grep '^relay1\.')
[ -n "$INVITE" ] || fail "no invite"
J=$(RELAY_HOME=$B $R join "$INVITE" $MODE 2>&1) || true
echo "$J" | grep -q "Connected to session" || fail "join: $J"

RELAY_HOME=$A $R send proposal --body "GET /users/:id returns {id,name}" >/dev/null
echo "Body from stdin" | RELAY_HOME=$A $R send question >/dev/null

OUT=$(tick $B)
echo "$OUT" | grep -q '"received_now": 2' || fail "guest did not receive 2: $OUT"
echo "$OUT" | grep -q 'GET /users/:id' || fail "guest missing body"
RELAY_HOME=$B $R ack 1 2 >/dev/null
RELAY_HOME=$B $R send accept --re 1 --body "Accepted." >/dev/null

OUT=$(tick $A)
echo "$OUT" | grep -q '"received_now": 1' || fail "host did not receive reply: $OUT"
echo "$OUT" | grep -q 'Accepted.' || fail "host missing body"

# Second tick receives nothing new (cursor works).
tick $B | grep -q '"received_now": 0' || fail "duplicate delivery"

# Wrong key cannot read: a forged session with the right sid but a different key.
FORGED=$(node -e '
const [p]=process.argv.slice(1); const o=JSON.parse(Buffer.from(p.slice(7),"base64url"));
o.k=require("crypto").randomBytes(32).toString("base64url");
console.log("relay1."+Buffer.from(JSON.stringify(o)).toString("base64url"))' "$INVITE")
C="$T/eve"
E=$(RELAY_HOME=$C $R join "$FORGED" --local 2>&1) && fail "forged join succeeded"
echo "$E" | grep -q "host rejected the handshake" || fail "forged join wrong error: $E"
RELAY_HOME=$C $R tick | grep -q '"peer_error": "peer answered 401"' || fail "forged key could read messages"
RELAY_HOME=$C $R close --purge >/dev/null

# Done handshake.
RELAY_HOME=$A $R send done --body "Host done." >/dev/null
RELAY_HOME=$B $R send done --body "Guest done." >/dev/null
tick $A | grep -q '"both_done": true' || fail "both_done not detected"

# Restart: stop guest, tick brings it back and re-announces.
RELAY_HOME=$B $R stop >/dev/null
tick $B | grep -q '"peer_reachable": true' || fail "guest restart"
tick $A | grep -q '"peer_reachable": true' || fail "host cannot reach restarted guest"

echo "PASS (${MODE:-tunnel})"
