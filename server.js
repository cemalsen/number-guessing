#!/usr/bin/env node
/**
 * Number Guessing — zero-dependency game server.
 *
 * Plain node:http + Server-Sent Events. All state is kept in memory;
 * restarting the server clears users, invites and games.
 *
 * Realtime contract: SSE events are cache-invalidation hints only (they carry
 * no authoritative data); clients re-fetch GET /api/state after each event and
 * after reconnect, so lost/duplicate events self-heal via snapshot reconcile.
 *
 * Env: PORT (default 3000), HOST (default 127.0.0.1; set 0.0.0.0 for LAN play).
 */
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSequence,
  randomSequence,
  score,
  isSolved,
} from "./lib/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const rawPort = process.env.PORT === undefined || process.env.PORT === "" ? "3000" : process.env.PORT;
const PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Number Guessing: invalid PORT "${rawPort}" — expected an integer 0-65535`);
  process.exit(1);
}
const HOST = process.env.HOST || "127.0.0.1";

const MAX_BODY_BYTES = 8 * 1024; // request bodies are tiny JSON; cap them
const USERNAME_RE = /^[A-Za-z0-9_-]{2,24}$/;

/* ------------------------------- store ---------------------------------- */

const store = {
  users: new Map(), // userId -> user
  byUsername: new Map(), // lowercased username -> user
  tokens: new Map(), // token -> user
  invites: new Map(), // inviteId -> invite
  games: new Map(), // gameId -> game
  nextUserId: 1001, // "the system assigns every user a number"
};

/* ------------------------------ helpers ---------------------------------- */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return; // response already sent; drain silently
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        // Write the 413 BEFORE touching the socket — destroying first would
        // leave the client with an empty reply instead of the error.
        sendJson(res, 413, {
          error: { code: "body_too_large", message: "Request body too large" },
        });
        const err = new Error("body too large");
        err.responseAlreadySent = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) return;
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new HttpError(400, "invalid_json", "Request body must be JSON"));
      }
    });
    req.on("error", (e) => {
      if (overflow) return;
      reject(e);
    });
  });
}

function requireUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const user = m ? store.tokens.get(m[1]) : null;
  if (!user) {
    throw new HttpError(401, "unauthorized", "Sign in required");
  }
  return user;
}

const publicUser = (u) => ({ userId: u.userId, username: u.username });

const pairOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function pushEvent(user, type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of user.sseClients) {
    try {
      client.write(payload);
    } catch {
      user.sseClients.delete(client);
    }
  }
}

function pushToUserIds(userIds, type, data) {
  for (const id of userIds) {
    const u = store.users.get(id);
    if (u) pushEvent(u, type, data);
  }
}

function broadcast(type, data = {}) {
  for (const u of store.users.values()) pushEvent(u, type, data);
}

/* ------------------------------ domain ----------------------------------- */

function createGame(playerAId, playerBId) {
  const game = {
    id: randomUUID(),
    playerIds: [playerAId, playerBId],
    secrets: new Map(), // userId -> number[4]
    setup: new Set(), // userIds that submitted a secret
    histories: new Map([
      [playerAId, []],
      [playerBId, []],
    ]),
    phase: "setup", // setup -> playing -> finished
    turn: null, // userId whose turn it is (playing only)
    winnerId: null,
    createdAt: Date.now(),
  };
  store.games.set(game.id, game);
  return game;
}

function otherPlayer(game, userId) {
  return game.playerIds.find((id) => id !== userId);
}

/** Per-view projection: opponent secrets/histories stay private until game end. */
function gameView(game, user) {
  const oppId = otherPlayer(game, user.userId);
  const finished = game.phase === "finished";
  return {
    id: game.id,
    opponent: publicUser(store.users.get(oppId)),
    phase: game.phase,
    mySetup: game.setup.has(user.userId),
    mySecret: game.secrets.get(user.userId) ?? null,
    opponentSetup: game.setup.has(oppId),
    turn:
      game.phase !== "playing" || game.turn === null
        ? null
        : game.turn === user.userId
          ? "me"
          : "them",
    myHistory: game.histories.get(user.userId),
    opponentGuessCount: game.histories.get(oppId).length,
    winner: finished
      ? game.winnerId === user.userId
        ? "me"
        : "them"
      : null,
    opponentSecret: finished ? game.secrets.get(oppId) : null,
  };
}

function stateFor(user) {
  return {
    me: publicUser(user),
    users: [...store.users.values()]
      .filter((u) => u.userId !== user.userId)
      .map((u) => ({
        ...publicUser(u),
        online: u.sseClients.size > 0,
      })),
    incomingInvites: [...store.invites.values()]
      .filter((i) => i.toId === user.userId)
      .map((i) => ({
        id: i.id,
        from: publicUser(store.users.get(i.fromId)),
      })),
    outgoingInvites: [...store.invites.values()]
      .filter((i) => i.fromId === user.userId)
      .map((i) => ({ id: i.id, to: publicUser(store.users.get(i.toId)) })),
    games: [...store.games.values()]
      .filter((g) => g.playerIds.includes(user.userId))
      .map((g) => gameView(g, user)),
  };
}

/* ------------------------------ routes ----------------------------------- */

async function handleRegister(req, res) {
  const body = await readJsonBody(req, res);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(
      400,
      "invalid_username",
      "Username must be 2-24 characters: letters, digits, _ or -"
    );
  }
  if (store.byUsername.has(username.toLowerCase())) {
    throw new HttpError(
      409,
      "username_taken",
      `Username "${username}" is already taken`
    );
  }
  const user = {
    userId: store.nextUserId++,
    username,
    token: randomBytes(24).toString("hex"),
    sseClients: new Set(),
  };
  store.users.set(user.userId, user);
  store.byUsername.set(username.toLowerCase(), user);
  store.tokens.set(user.token, user);
  broadcast("lobby.updated");
  sendJson(res, 201, {
    userId: user.userId,
    username: user.username,
    token: user.token,
  });
}

async function handleInvite(req, res) {
  const user = requireUser(req);
  const body = await readJsonBody(req, res);
  const toName = typeof body.to === "string" ? body.to.trim() : "";
  const target = store.byUsername.get(toName.toLowerCase());
  if (!target) {
    throw new HttpError(404, "unknown_user", `No user named "${toName}"`);
  }
  if (target.userId === user.userId) {
    throw new HttpError(400, "self_invite", "You cannot invite yourself");
  }
  const pair = pairOf(user.userId, target.userId);
  for (const inv of store.invites.values()) {
    if (pairOf(inv.fromId, inv.toId) === pair) {
      throw new HttpError(409, "invite_pending", "An invite is already pending");
    }
  }
  for (const g of store.games.values()) {
    if (g.phase !== "finished" && pairOf(...g.playerIds) === pair) {
      throw new HttpError(
        409,
        "game_active",
        `You already have an unfinished game with ${target.username}`
      );
    }
  }
  const invite = {
    id: randomUUID(),
    fromId: user.userId,
    toId: target.userId,
    at: Date.now(),
  };
  store.invites.set(invite.id, invite);
  pushToUserIds([user.userId, target.userId], "invite.updated");
  sendJson(res, 201, { id: invite.id, to: publicUser(target) });
}

async function handleInviteRespond(req, res) {
  const user = requireUser(req);
  const body = await readJsonBody(req, res);
  const invite = store.invites.get(body.inviteId);
  if (!invite) throw new HttpError(404, "not_found", "Invite not found");
  const isInvitee = invite.toId === user.userId;
  const isInviter = invite.fromId === user.userId;
  if (!isInvitee && !isInviter) {
    throw new HttpError(403, "forbidden", "This invite is not yours");
  }
  const accept = body.accept === true;
  if (isInviter && accept) {
    throw new HttpError(400, "invalid_response", "Only the invitee can accept");
  }
  store.invites.delete(invite.id);
  if (accept) createGame(invite.fromId, invite.toId);
  const players = [invite.fromId, invite.toId];
  pushToUserIds(players, "invite.updated");
  pushToUserIds(players, "game.updated");
  sendJson(res, 200, { ok: true, accepted: accept });
}

async function handleGameSetup(req, res) {
  const user = requireUser(req);
  const body = await readJsonBody(req, res);
  const game = store.games.get(body.gameId);
  if (!game || !game.playerIds.includes(user.userId)) {
    throw new HttpError(404, "not_found", "Game not found");
  }
  if (game.phase !== "setup") {
    throw new HttpError(409, "wrong_phase", "This game is not in setup phase");
  }
  if (game.setup.has(user.userId)) {
    throw new HttpError(409, "already_set", "You already chose your sequence");
  }
  let secret;
  if (body.mode === "random") {
    secret = randomSequence();
  } else if (body.mode === "manual") {
    secret = parseSequence(body.secret);
    if (!secret) {
      throw new HttpError(
        400,
        "invalid_secret",
        "Secret must be exactly 4 digits (0-9)"
      );
    }
  } else {
    throw new HttpError(400, "invalid_mode", 'mode must be "manual" or "random"');
  }
  game.secrets.set(user.userId, secret);
  game.setup.add(user.userId);
  if (game.setup.size === game.playerIds.length) {
    game.phase = "playing";
    game.turn = game.playerIds[Math.random() < 0.5 ? 0 : 1]; // random first player
  }
  pushToUserIds(game.playerIds, "game.updated");
  sendJson(res, 200, { ok: true, phase: game.phase, yourSecret: secret });
}

async function handleGameGuess(req, res) {
  const user = requireUser(req);
  const body = await readJsonBody(req, res);
  const game = store.games.get(body.gameId);
  if (!game || !game.playerIds.includes(user.userId)) {
    throw new HttpError(404, "not_found", "Game not found");
  }
  if (game.phase !== "playing") {
    throw new HttpError(409, "wrong_phase", "The game is not accepting guesses");
  }
  if (game.turn !== user.userId) {
    throw new HttpError(403, "not_your_turn", "Wait for your turn");
  }
  const guess = parseSequence(body.guess);
  if (!guess) {
    throw new HttpError(
      400,
      "invalid_guess",
      "Guess must be exactly 4 digits (0-9)"
    );
  }
  const oppId = otherPlayer(game, user.userId);
  const result = score(game.secrets.get(oppId), guess);
  game.histories.get(user.userId).push({
    guess,
    marks: result.marks,
    counts: result.counts,
    at: Date.now(),
  });
  if (isSolved(result)) {
    game.phase = "finished";
    game.winnerId = user.userId;
    game.turn = null;
  } else {
    game.turn = oppId;
  }
  pushToUserIds(game.playerIds, "game.updated");
  sendJson(res, 200, { result, solved: game.phase === "finished" });
}

function handleEvents(req, res, url) {
  const user = store.tokens.get(url.searchParams.get("token") || "");
  if (!user) throw new HttpError(401, "unauthorized", "Valid token required");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("event: hello\ndata: {}\n\n");
  user.sseClients.add(res);
  // A write to a half-closed response surfaces as an async 'error' event,
  // not a synchronous throw — without this listener one dead socket could
  // emit an unhandled 'error' and take down the process.
  res.on("error", () => user.sseClients.delete(res));
  req.on("close", () => user.sseClients.delete(res));
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/events") {
    return handleEvents(req, res, url);
  }
  if (req.method === "GET" && p === "/api/state") {
    const user = requireUser(req);
    return sendJson(res, 200, stateFor(user));
  }
  if (req.method === "POST" && p === "/api/register") {
    return handleRegister(req, res);
  }
  if (req.method === "POST" && p === "/api/invite") {
    return handleInvite(req, res);
  }
  if (req.method === "POST" && p === "/api/invite/respond") {
    return handleInviteRespond(req, res);
  }
  if (req.method === "POST" && p === "/api/game/setup") {
    return handleGameSetup(req, res);
  }
  if (req.method === "POST" && p === "/api/game/guess") {
    return handleGameGuess(req, res);
  }
  throw new HttpError(404, "not_found", "Unknown API endpoint");
}

/* ---------------------------- static files -------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "bad_request", "Malformed percent-encoding in path");
  }
  const rel = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel)); // traversal still blocked by the prefix check below
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(404, "not_found", "Not found");
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(err);
    throw new HttpError(404, "not_found", "Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
  });
  res.end(req.method === "HEAD" ? undefined : data);
}

/* ------------------------------ server ------------------------------------ */

const server = http.createServer((req, res) => {
  // A malformed Host (or absolute-form/"*" request target) makes `new URL`
  // throw synchronously — before any promise exists to catch it. Without
  // this guard one raw packet would take down the whole in-memory server.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, {
      error: { code: "bad_request", message: "Malformed request target or Host header" },
    });
    return;
  }
  res.setHeader("Referrer-Policy", "no-referrer"); // SSE token travels in a query string
  const work = url.pathname.startsWith("/api/")
    ? handleApi(req, res, url)
    : serveStatic(req, res, url.pathname);
  work.catch((err) => {
    if (err?.responseAlreadySent) return; // e.g. 413 fully written by readJsonBody
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: {
          code: status === 500 ? "internal" : err.code,
          message: status === 500 ? "Internal server error" : err.message,
        },
      });
    } else {
      res.end();
    }
  });
});

// keep idle SSE connections alive through proxies
const heartbeat = setInterval(() => {
  for (const u of store.users.values()) {
    for (const client of u.sseClients) {
      try {
        client.write(": ping\n\n");
      } catch {
        u.sseClients.delete(client);
      }
    }
  }
}, 25_000);
heartbeat.unref();

function shutdown() {
  clearInterval(heartbeat);
  for (const u of store.users.values()) {
    for (const client of u.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    u.sseClients.clear();
  }
  // Drain normally (close() also ends idle keep-alive sockets on Node 18+);
  // the 500ms timer is the hard stop so SIGINT stays snappy.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, shutdown);
}

server.listen(PORT, HOST, () => {
  const { port } = server.address(); // resolves 0 to the real ephemeral port
  console.log(`Number Guessing listening on http://${HOST}:${port}`);
});
