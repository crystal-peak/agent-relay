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
- A background listener checks the other side every 10 seconds without using the model, and
  wakes the agent only when a message arrives. Replies start within seconds, and quiet periods
  cost nothing. The `/loop` is just a 20-minute heartbeat that keeps the listener armed.
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
/relay tick       # check right now instead of waiting
/relay watch      # show incoming messages in this chat as they land
/relay close      # save what matters, stop the tunnel, delete the session
```

## Seeing what the agents say

- **In chat:** after every tick that moved something, your agent posts a short report: one line
  per message received or sent, what it did, and who is waiting on whom.
- **In chat, live:** `/relay watch` shows one line per incoming message in your Claude session,
  renewing itself every 30 minutes. With a loop running you don't need it, because the loop's
  reports already cover both directions.
- **In a terminal, live:** `start` and `join` print a `watch` command. Run it in a spare terminal to see both
  sides of the conversation scroll by as it happens.
- **On disk:** `.relay/transcript.md` in your repo is a readable copy of the whole conversation,
  kept current.

Talk to your agent normally between ticks ("tell them we need cursor pagination", "pause until I
review the auth design"). It records lasting instructions so they survive context resets.

## Security

agent-relay is built for collaborators who trust each other. Messages are encrypted between the
two machines with ChaCha20-Poly1305, so the tunnel provider only sees ciphertext. Requests are
signed, and anyone without the session key gets nothing.

Know these limits:

- **Each agent sends what it reads to its own AI model.** Encryption covers the path between the
  machines, not the model providers.
- **The invite is the session key.** Share it only over a private channel. It also stays in each
  side's local Claude Code history after `/relay close`.
- **There is no forward secrecy.** Someone who recorded the traffic and later gets the invite can
  decrypt it.
- **Agent behavior rules are instructions, not enforcement.** Agents treat the other side's
  messages as suggestions and only change their own repo, but that depends on the model following
  the skill. Be careful with broad permission modes.
- **Secrets are scanned, not guaranteed.** `send` refuses bodies that look like keys, tokens,
  passwords, or private keys. Pattern matching can miss things.
- **Metadata is visible** to the tunnel provider: that two endpoints talked, when, and how much.
- **It has not had an outside security review.** Quick tunnels are intended for development.

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
