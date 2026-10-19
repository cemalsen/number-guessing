# Number Guessing

A server-based, two-player number-guessing game (bulls & cows style) with a user system,
invites, and turn-based play. Zero dependencies — plain Node.js (>= 18) on the server,
vanilla HTML/CSS/JS on the client.

## Run

```bash
npm start          # serves http://localhost:3000  (PORT env var overrides)
npm test           # scoring unit tests + end-to-end HTTP/SSE game test
```

Data lives in server memory only; restarting the server clears all users and games.

## How it plays

1. **Register** — pick a username. Usernames must be unique (case-insensitive).
   The system assigns every user a number (starting at **#1001**).
2. **Invite** — invite another user by username. The invitee accepts or declines.
3. **Set your sequence** — when the game starts, each player either types their own
   4-digit secret sequence (digits 0–9, repeats allowed) or clicks *Random* to let the
   system generate one.
4. **Guess** — players alternate guessing each other's secret sequence. After every
   guess, results are shown in a table classifying the guessed digits into:

   | Column | Meaning |
   |---|---|
   | ✔ Correct position | digit matches the secret **and** is in the right slot |
   | ➜ Wrong position | digit is in the secret but in a different slot |
   | ✖ Incorrect | digit is not in the secret (beyond what is already matched) |

   Classification handles repeated digits correctly (standard multiset matching:
   exact matches are counted first, misplacements only against digits left over).
5. **Win** — the first player to guess the opponent's full sequence wins; both
   secrets are revealed at game end.

## Layout

```
server.js            HTTP server, routing, sessions, SSE, in-memory store
lib/scoring.js       pure sequence parsing + scoring (unit-tested)
public/              client UI (index.html, app.js, game-inputs.js, style.css)
test/scoring.test.js node --test suite for the scoring core
test/game.test.js    e2e smoke test: boots the real server, plays a full game
```

## HTTP API (JSON, token auth via `Authorization: Bearer <token>`)

| Endpoint | Purpose |
|---|---|
| `POST /api/register` `{username}` | create user, returns assigned number + token |
| `GET /api/state` | everything the current user needs (profile, users, invites, games) |
| `POST /api/invite` `{to}` | invite user by username |
| `POST /api/invite/respond` `{inviteId, accept}` | accept/decline/cancel an invite |
| `POST /api/game/setup` `{gameId, mode, secret?}` | set secret: `{mode:"manual", secret:"1234"}` or `{mode:"random"}` |
| `POST /api/game/guess` `{gameId, guess}` | submit a 4-digit guess on your turn |
| `GET /api/events?token=..` | SSE stream: lobby/game changes push `{type}` events; client re-fetches `/api/state` |

## Security notes (by-design limits)

Intended for a trusted LAN, not the public internet: state is in-memory and
protected only by the Bearer token (no rate limits, no persistence). The SSE
token rides in a query string because `EventSource` cannot set headers —
mitigated with `Referrer-Policy: no-referrer`; secrets use `node:crypto`
random digits.
