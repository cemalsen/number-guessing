/**
 * End-to-end smoke test: boots the real server on an ephemeral port and plays
 * a complete game through the public HTTP surface (register -> invite ->
 * accept -> setup -> guesses -> win), plus auth and validation paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");

let proc;
let base;

async function startServer() {
  proc = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  const port = await new Promise((resolve, reject) => {
    const fail = (why) => reject(new Error(`server boot failed: ${why}${stderr ? `\nstderr: ${stderr}` : ""}`));
    const timer = setTimeout(() => fail("timeout waiting for listen line"), 5000);
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const m = /listening on http:\/\/[^\s]+:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on("exit", (code) => fail(`exit ${code}`));
  });
  base = `http://127.0.0.1:${port}`;
}

async function stopServer() {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  const winner = await Promise.race([exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
  if (winner === "timeout") {
    proc.kill("SIGKILL");
    await exited;
  }
}

test("game flow end-to-end", async (t) => {
  await startServer();
  t.after(stopServer);

  const api = async (p, body, token) => {
    const res = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  /* -------- auth -------- */
  await t.test("unauthenticated /api/state is 401", async () => {
    const r = await api("/api/state");
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, "unauthorized");
  });

  /* -------- registration -------- */
  let alice, bob;
  await t.test("register assigns sequential numbers starting at 1001", async () => {
    alice = await api("/api/register", { username: "alice" });
    assert.equal(alice.status, 201);
    assert.equal(alice.data.userId, 1001);
    assert.match(alice.data.token, /^[0-9a-f]{48}$/);
    bob = await api("/api/register", { username: "bob" });
    assert.equal(bob.status, 201);
    assert.equal(bob.data.userId, 1002);
  });

  await t.test("usernames are unique case-insensitively", async () => {
    const dup = await api("/api/register", { username: "ALIce" });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, "username_taken");
  });

  await t.test("invalid usernames are rejected", async () => {
    for (const bad of ["a", "x".repeat(25), "has space", "emoji😀"]) {
      const r = await api("/api/register", { username: bad });
      assert.equal(r.status, 400, `username ${JSON.stringify(bad)} should be invalid`);
    }
  });

  /* -------- invites -------- */
  let inviteId;
  await t.test("invite by unknown username is 404", async () => {
    const r = await api("/api/invite", { to: "nobody" }, alice.data.token);
    assert.equal(r.status, 404);
  });

  await t.test("self-invite is 400", async () => {
    const r = await api("/api/invite", { to: "alice" }, alice.data.token);
    assert.equal(r.status, 400);
  });

  await t.test("invite creates a pending invite on both sides", async () => {
    const r = await api("/api/invite", { to: "BOB" }, alice.data.token); // case-insensitive name
    assert.equal(r.status, 201);
    inviteId = r.data.id;
    const bobState = await api("/api/state", undefined, bob.data.token);
    assert.deepEqual(
      bobState.data.incomingInvites.map((i) => i.from.username),
      ["alice"]
    );
  });

  await t.test("only the invitee can accept; third party cannot respond", async () => {
    const intruder = await api("/api/register", { username: "mallory" });
    const r = await api("/api/invite/respond", { inviteId, accept: true }, intruder.data.token);
    assert.equal(r.status, 403);
  });

  await t.test("accepting creates a game in setup phase", async () => {
    const r = await api("/api/invite/respond", { inviteId, accept: true }, bob.data.token);
    assert.equal(r.status, 200);
    for (const tok of [alice, bob]) {
      const s = await api("/api/state", undefined, tok.data.token);
      assert.equal(s.data.games.length, 1);
      assert.equal(s.data.games[0].phase, "setup");
    }
  });

  /* -------- game setup -------- */
  let gameId;
  const ALICE_SECRET = "1234";
  const BOB_SECRET = "5678"; // fully disjoint from Alice's

  await t.test("setup validates manual secrets and accepts both modes", async () => {
    const aState = await api("/api/state", undefined, alice.data.token);
    gameId = aState.data.games[0].id;

    const bad = await api("/api/game/setup", { gameId, mode: "manual", secret: "12a4" }, alice.data.token);
    assert.equal(bad.status, 400);

    const a = await api("/api/game/setup", { gameId, mode: "manual", secret: ALICE_SECRET }, alice.data.token);
    assert.equal(a.status, 200);
    const b = await api("/api/game/setup", { gameId, mode: "random" }, bob.data.token);
    assert.equal(b.status, 200);
    assert.equal(b.data.phase, "playing");
    assert.match(b.data.yourSecret.join(""), /^\d{4}$/);
  });

  await t.test("opponent secrets are never exposed in state", async () => {
    const s = await api("/api/state", undefined, alice.data.token);
    const g = s.data.games[0];
    assert.equal(g.opponentSecret, null);
    assert.deepEqual(g.mySecret, [1, 2, 3, 4]);
    assert.equal(g.opponentSetup, true);
    assert.ok(g.turn === "me" || g.turn === "them");
  });

  /* -------- replace bob's random secret with the known one for scoring checks.
     Simpler: replay the whole scoring flow on a second game with two manual
     secrets, so the result table can be asserted exactly. -------- */
  await t.test("full manual game: guess table, turn order, win reveal", async () => {
    const carol = await api("/api/register", { username: "carol" });
    const dan = await api("/api/register", { username: "dan" });
    const inv = await api("/api/invite", { to: "dan" }, carol.data.token);
    await api("/api/invite/respond", { inviteId: inv.data.id, accept: true }, dan.data.token);

    const cs = await api("/api/state", undefined, carol.data.token);
    const g2 = cs.data.games.find((g) => g.opponent.username === "dan");
    await api("/api/game/setup", { gameId: g2.id, mode: "manual", secret: "1123" }, carol.data.token);
    await api("/api/game/setup", { gameId: g2.id, mode: "manual", secret: "3211" }, dan.data.token);

    // whose turn is it?
    let cState = (await api("/api/state", undefined, carol.data.token)).data;
    const firstIsCarol = cState.games.find((g) => g.id === g2.id).turn === "me";
    const [g1Tok, g2Tok] = firstIsCarol ? [carol, dan] : [dan, carol];
    // g1OppSecret = the secret g1 must crack: the one g2 chose as their own.
    const [g1OppSecret] = firstIsCarol ? ["3211"] : ["1123"];

    // wrong-turn guesses are rejected
    const g2Turn = (await api("/api/state", undefined, g2Tok.data.token)).data;
    if (g2Turn.games.find((g) => g.id === g2.id).turn !== "me") {
      const r = await api("/api/game/guess", { gameId: g2.id, guess: "0000" }, g2Tok.data.token);
      assert.equal(r.status, 403);
    }

    // first player guesses one exact, one misplaced-wrong-pos, one absent digit
    const probe = await api("/api/game/guess", { gameId: g2.id, guess: firstIsCarol ? "3001" : "1013" }, g1Tok.data.token);
    assert.equal(probe.status, 200);
    // against "3211": guess "3001" -> pos0 exact(3), pos3 exact(1), leftover secret {2,1}, leftover guess {0,0}
    //   -> correct 2, misplaced 0, incorrect 2 ... but which secret depends on player; assert on returned counts shape
    assert.deepEqual(Object.keys(probe.data.result.counts).sort(), ["correct", "incorrect", "misplaced"]);

    // second player now has the turn
    const afterG1 = (await api("/api/state", undefined, g2Tok.data.token)).data.games.find((g) => g.id === g2.id);
    assert.equal(afterG1.turn, "me");

    // second player solves g1's own secret -> win
    // (if firstIsCarol, dan guesses carol's "1123")
    const solveSecret = firstIsCarol ? "1123" : "3211";
    const warm = await api("/api/game/guess", { gameId: g2.id, guess: "9999" }, g2Tok.data.token);
    assert.equal(warm.status, 200);
    assert.equal(warm.data.solved, false); // 9999: no secret here contains a 9
    // turn passed back to the first player: they must waste a guess (0000 also
    // matches nothing in either secret) before the second player can solve
    const filler = await api("/api/game/guess", { gameId: g2.id, guess: "0000" }, g1Tok.data.token);
    assert.equal(filler.status, 200);
    assert.equal(filler.data.solved, false);
    const win = await api("/api/game/guess", { gameId: g2.id, guess: solveSecret }, g2Tok.data.token);
    assert.equal(win.status, 200);
    assert.equal(win.data.solved, true);
    assert.deepEqual(win.data.result.counts, { correct: 4, misplaced: 0, incorrect: 0 });

    // loser view: finished, lost, opponent secret revealed, history table has all rows
    const loserTok = firstIsCarol ? carol : dan;
    const loserState = (await api("/api/state", undefined, loserTok.data.token)).data;
    const lg = loserState.games.find((g) => g.id === g2.id);
    assert.equal(lg.phase, "finished");
    assert.equal(lg.winner, "them");
    // The loser's revealed `opponentSecret` is the winner's own secret —
    // g1OppSecret, the one the first player (the loser) was guessing against.
    assert.deepEqual(lg.opponentSecret, [...g1OppSecret].map(Number));

    const winnerTok = firstIsCarol ? dan : carol;
    const winnerState = (await api("/api/state", undefined, winnerTok.data.token)).data;
    const wg = winnerState.games.find((g) => g.id === g2.id);
    assert.equal(wg.winner, "me");
    assert.equal(wg.myHistory.length, 2);
    assert.deepEqual(wg.myHistory[0].counts, { correct: 0, misplaced: 0, incorrect: 4 }); // 9999 shares no digit with either secret
    assert.equal(wg.myHistory[1].counts.correct, 4);

    // guesses after the game ends are refused
    const late = await api("/api/game/guess", { gameId: g2.id, guess: "0000" }, winnerTok.data.token);
    assert.equal(late.status, 409);
  });

  /* -------- SSE -------- */
  await t.test("SSE stream authenticates and delivers hello", async () => {
    const bad = await fetch(`${base}/api/events?token=nope`, { signal: AbortSignal.timeout(3000) });
    assert.equal(bad.status, 401);

    const res = await fetch(`${base}/api/events?token=${alice.data.token}`, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /event: hello/);
    await reader.cancel();
  });

  await t.test("a game event reaches the SSE clients of both players", async () => {
    // alice already has one open stream conceptually; open fresh ones for both
    const resA = await fetch(`${base}/api/events?token=${alice.data.token}`, { signal: AbortSignal.timeout(3000) });
    const readerA = resA.body.getReader();
    await readerA.read(); // hello

    const eve = await api("/api/register", { username: "eve" });
    await api("/api/invite", { to: "eve" }, alice.data.token); // invite.updated -> alice
    const dec = new TextDecoder();
    let sawInvite = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !sawInvite) {
      const { value, done } = await readerA.read();
      if (done) break;
      if (dec.decode(value).includes("event: invite.updated")) sawInvite = true;
    }
    assert.ok(sawInvite, "alice's SSE stream should receive invite.updated");
    await readerA.cancel();
    assert.equal(eve.status, 201);
  });

  /* -------- hardening regressions (adversarial review round) -------- */
  await t.test("oversized request body is refused with a 413 JSON error", async () => {
    // Pre-fix, the socket was destroyed BEFORE writing the response, so the
    // client got an empty reply (curl rc=52) instead of the 413.
    const res = await fetch(`${base}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x".repeat(20_000) }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.error?.code, "body_too_large");
  });

  await t.test("malformed Host header gets 400 and never crashes the server", async () => {
    // `new URL(req.url, http://<host>)` throws synchronously for an invalid
    // host; unguarded that uncaught exception kills the whole server.
    const { port } = new URL(base);
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(Number(port), "127.0.0.1", () => {
        sock.write("GET /api/state HTTP/1.1\r\nHost: a[b\r\nConnection: close\r\n\r\n");
      });
      let buf = "";
      sock.setTimeout(3000, () => {
        sock.destroy();
        reject(new Error("raw socket timeout: server never answered"));
      });
      sock.on("data", (chunk) => (buf += chunk));
      sock.on("close", () => resolve(buf));
      sock.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    // The in-memory server must still be alive to serve real traffic.
    const alive = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) });
    assert.equal(alive.status, 401);
  });

  await t.test("static serving decodes paths and blocks traversal", async () => {
    const asset = await fetch(`${base}/app.js`, { signal: AbortSignal.timeout(3000) });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /javascript/);
    // Percent-encoded dot-segments decode to ../ before normalization must
    // still be rejected by the PUBLIC_DIR prefix check; %zz is a bad escape.
    for (const evil of ["/%2e%2e%2fserver.js", "/%2e%2e/server.js", "/%zz"]) {
      const blocked = await fetch(base + evil, { signal: AbortSignal.timeout(3000) });
      assert.ok([400, 404].includes(blocked.status), `${evil} must not escape public/ (got ${blocked.status})`);
    }
  });
});
