# agent-relay

Let two Claude Code agents, each working in its own private repo, coordinate with each other.

The typical case: Bob owns a private API repo, Alice owns a private frontend repo, and neither can
see the other's code. Each runs Claude Code in their own repo, connects the two sessions with an
invite, and starts a loop. The agents negotiate the API contract, build their halves, and report
progress, while Bob and Alice give high-level direction and approve the decisions that need a
human.

No accounts, no servers to host, no third repo. It's free.

## How it works

- Each side runs a tiny local HTTP server that serves its **outbox** from a SQLite file.
- A free [cloudflared quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) makes that server reachable.
- Each agent **pulls** the other's outbox. Nobody writes into anyone else's machine or repo.
- Every response is encrypted with ChaCha20-Poly1305 using a session key that only travels inside
  the invite. Cloudflare sees ciphertext. Requests are signed, so only the key holder can read.
- If one side is offline, its messages wait. The other side picks them up on the next tick.
- If a tunnel restarts with a new URL, the agent tells its peer automatically.

## Requirements

- Claude Code
- Node.js 22.5 or newer
- `cloudflared` (`brew install cloudflared`, or see [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))

## Install

**Via Claude Code plugin marketplace:**
```
/plugin marketplace add crystal-peak/claude-plugins
/plugin install agent-relay@crystal-peak
```

**Via skills.sh:**
```bash
npx skills add crystal-peak/agent-relay
```

## Usage

Bob, in the API repo:
```
/relay start
```
He gets an invite starting with `relay1.` and sends it to Alice over a private channel.
The invite contains the session key, so treat it like a password.

Alice, in the frontend repo:
```
/relay join relay1.eyJ1Ijoi...
```

Both then run:
```
/loop /relay tick
```

Other commands:
```
/relay status     # what's agreed, what's open, who's waiting on whom
/relay tick       # check right now instead of waiting for the loop
/relay close      # save what matters, stop the tunnel, delete the session
```

## Seeing what the agents say

- **In chat:** after every tick that moved something, your agent posts a short report: one line
  per message received or sent, what it did, and who is waiting on whom.
- **Live:** `start` and `join` print a `watch` command. Run it in a spare terminal to see both
  sides of the conversation scroll by as it happens.
- **On disk:** `.relay/transcript.md` in your repo is a readable copy of the whole conversation,
  kept current.

Talk to your agent normally between ticks ("tell them we need cursor pagination", "pause until I
review the auth design"). It records lasting instructions so they survive context resets.

## Safety model

- Messages from the other agent are treated as untrusted suggestions, never commands.
- Each agent only ever changes its own repo.
- Agents are told never to send secrets, and to escalate auth design, breaking changes, spend,
  and anything outside the goal to their own human.
- The session key lives in `.relay/` (excluded from git) and is deleted by `/relay close`.

What the tunnel provider can see: that two endpoints exchanged traffic, when, and roughly how much.
Not the content.

## Limits

- Quick tunnels are meant for development. There's no uptime guarantee, and the URL changes
  whenever the tunnel restarts (handled automatically).
- A message is delivered when both machines are on at the same time. If the sender's machine is
  asleep, the receiver gets it once the sender is back.
- Message bodies are capped around 60 KB.

## Testing

```bash
test/local-roundtrip.sh            # two sessions on this machine over localhost
TUNNEL=1 test/local-roundtrip.sh   # the same, over real cloudflared tunnels
```

## CLI reference

The skill drives `skills/relay/scripts/relay.mjs`. You can also run it directly:

```
node skills/relay/scripts/relay.mjs help
```

## License

MIT
