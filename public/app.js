/* Number Guessing — vanilla client.
 * Realtime contract: SSE events are cache-invalidation hints only — the
 * server sends NAMED events (hello, lobby.updated, invite.updated,
 * game.updated), each of which triggers a full GET /api/state refetch, so
 * reconnects and missed events self-heal. Note: `onmessage` fires only for
 * events without an `event:` field, so every named type is registered via
 * addEventListener in connectEvents(). */

import {
  createSubmitLock,
  focusLookup,
  restoreFocus,
  restoreInputs,
  snapshotFocus,
  snapshotInputs,
} from "./game-inputs.js";

const TOKEN_KEY = "number-guessing.token";
const $ = (id) => document.getElementById(id);

const els = {
  meChip: $("me-chip"),
  flash: $("flash"),
  viewRegister: $("view-register"),
  viewLobby: $("view-lobby"),
  viewGame: $("view-game"),
  userList: $("user-list"),
  noUsers: $("no-users"),
  invitesIn: $("invites-in"),
  noInvitesIn: $("no-invites-in"),
  invitesOut: $("invites-out"),
  noInvitesOut: $("no-invites-out"),
  gameList: $("game-list"),
  noGames: $("no-games"),
  gameBoard: $("game-board"),
};

let token = localStorage.getItem(TOKEN_KEY);
let state = null; // last /api/state snapshot
let selectedGameId = null;
let eventSource = null;
let pollTimer = null;
let flashTimer = null;

/* ------------------------------ plumbing -------------------------------- */

// One submit at a time. This lives in JavaScript, not on a button node, because
// every render replaces the nodes: a `btn.disabled = true` from a click is
// undone by the next re-render (lobby.updated is broadcast on every
// registration) and the matching `= false` then writes to a detached node.
// Controls that opt in with `data-submit` reflect the lock's state on demand.
// The keyed control the keyboard player is holding a place on. It is armed when
// a submit *acquires* the lock, not when focus is next read: the line below
// disables that control, and a disabled element is not focusable, so the browser
// blurs it immediately and a snapshot taken after that finds nothing.
let focusKey = null;

// Focus is "nowhere" only when the rebuild or the disable dropped it — never
// when the player has since moved it on purpose, which must not be overwritten.
function focusIsLost() {
  const el = document.activeElement;
  return !el || el === document.body;
}

function syncSubmitControls() {
  if (submitLock.pending) {
    // Arm before disabling. `?? focusKey` keeps the previous place when focus
    // sits in a plain field (the guess input has no key) — that field is
    // restored with its caret by restoreInputs(), so there is nothing to hand
    // back here and no stale button to grab the keyboard for.
    focusKey = snapshotFocus(document.activeElement) ?? focusKey;
  }
  for (const el of document.querySelectorAll("[data-submit]")) {
    el.disabled = submitLock.pending;
  }
  // Releasing is the first moment the armed control can take focus again.
  if (!submitLock.pending && focusIsLost()) {
    restoreFocus(focusKey, focusLookup(document));
  }
}
const submitLock = createSubmitLock(syncSubmitControls);

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function signedOut() {
  // token invalid/expired (e.g. server restarted): back to a clean register
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  stopPolling();
  els.meChip.hidden = true;
  showView("register");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON (shouldn't happen on /api) */
  }
  if (!res.ok) {
    if (res.status === 401 && token) signedOut();
    const msg = data?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function flash(message, ok = false) {
  els.flash.textContent = message;
  els.flash.classList.toggle("ok", ok);
  els.flash.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    els.flash.hidden = true;
  }, 3000);
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      flash(err.message);
      await refresh().catch(() => {}); // server may have moved on; resync
    }
  };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/* ------------------------------ realtime -------------------------------- */

const SSE_EVENTS = ["hello", "lobby.updated", "invite.updated", "game.updated"];

function connectEvents() {
  if (eventSource) eventSource.close();
  stopPolling();
  if (!token) return;
  eventSource = new EventSource(`/api/events[REDACTED:url_query_credential]`);
  const onEvent = () => refresh().catch(() => {});
  // Named events never reach `onmessage` — register each type explicitly.
  for (const type of SSE_EVENTS) eventSource.addEventListener(type, onEvent);
  eventSource.onmessage = onEvent; // unnamed events, should the server add any
  eventSource.onopen = stopPolling;
  eventSource.onerror = () => {
    // EventSource auto-reconnects; when it gives up, poll as a degraded path.
    if (eventSource?.readyState === EventSource.CLOSED && !pollTimer) {
      pollTimer = setInterval(() => refresh().catch(() => {}), 5000);
    }
  };
}

async function refresh() {
  state = await api("/api/state");
  render();
}

/* -------------------------------- views ---------------------------------- */

function showView(name) {
  els.viewRegister.hidden = name !== "register";
  els.viewLobby.hidden = name !== "lobby";
  els.viewGame.hidden = name !== "game";
}

function render() {
  if (!state) return;
  // Every branch below replaces nodes, so focus is taken before anything is
  // wiped and handed back afterwards: a keyboard player parked on Invite,
  // Accept, Cancel or Open otherwise loses their place, and `lobby.updated`
  // arrives whenever *anyone* registers. Fields inside the board are covered
  // separately (with their caret) by snapshotInputs/restoreInputs.
  // While a submit is in flight the focused control is disabled, and a disabled
  // control is not focusable — so activeElement is `body` here and a plain
  // snapshot would read "nothing was focused", discarding the place armed at
  // acquire and leaving nothing to hand back when the lock releases. Keep the
  // armed key unless this render genuinely sees a keyed control (the player
  // moved on purpose), and track live focus normally when nothing is pending.
  const liveKey = snapshotFocus(document.activeElement);
  if (liveKey || !submitLock.pending) focusKey = liveKey;
  renderMeChip();
  if (selectedGameId && state.games.some((g) => g.id === selectedGameId)) {
    renderGame(state.games.find((g) => g.id === selectedGameId));
    showView("game");
  } else {
    selectedGameId = null;
    renderLobby();
    showView("lobby");
  }
  // Order matters: apply the disabled state to the fresh nodes *first*, then
  // hand focus back. Restoring focus onto a control that is about to be
  // disabled is pointless — blurring it is what the browser does next, which is
  // the very loss this is meant to prevent. syncSubmitControls() owns the
  // hand-back because it is also the lock's release callback: while a request
  // is in flight the focus cannot land on a disabled control, so `focusKey`
  // stays armed and the same function retries it the moment the lock releases.
  syncSubmitControls();
  // Settled: nothing is in flight, so the position has been handed back (or
  // legitimately disappeared) and an unrelated click on empty page later must
  // not resurrect a stale one.
  if (!submitLock.pending) focusKey = null;
}

function renderMeChip() {
  els.meChip.hidden = false;
  els.meChip.innerHTML =
    `<span class="name">${esc(state.me.username)}</span>` +
    `<span class="num">#${state.me.userId}</span>` +
    `<button class="small ghost" id="btn-signout" data-focus-key="signout" type="button" title="Forget this device">Sign out</button>`;
  $("btn-signout").addEventListener("click", () => {
    signedOut();
  });
}

/* -------------------------------- lobby ---------------------------------- */

function renderLobby() {
  els.userList.innerHTML = "";
  els.noUsers.hidden = state.users.length > 0;
  for (const u of state.users) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="dot ${u.online ? "online" : ""}" title="${u.online ? "online" : "offline"}"></span>` +
      `<span class="grow">${esc(u.username)}</span>` +
      `<span class="num">#${u.userId}</span>`;
    const btn = document.createElement("button");
    btn.className = "small";
    btn.type = "button";
    btn.textContent = "Invite";
    btn.dataset.focusKey = `invite:${u.userId}`;
    btn.addEventListener("click", guard(() => submitLock.run(async () => {
      await api("/api/invite", { to: u.username });
      flash(`Invite sent to ${u.username}`, true);
      await refresh();
    })));
    li.append(btn);
    els.userList.append(li);
  }

  els.invitesIn.innerHTML = "";
  els.noInvitesIn.hidden = state.incomingInvites.length > 0;
  for (const inv of state.incomingInvites) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow">from <b>${esc(inv.from.username)}</b> <span class="num">#${inv.from.userId}</span></span>`;
    const accept = document.createElement("button");
    accept.className = "small";
    accept.type = "button";
    accept.textContent = "Accept";
    accept.dataset.focusKey = `accept:${inv.id}`;
    accept.addEventListener("click", guard(() => submitLock.run(async () => {
      await api("/api/invite/respond", { inviteId: inv.id, accept: true });
      await refresh();
    })));
    const decline = document.createElement("button");
    decline.className = "small secondary";
    decline.type = "button";
    decline.textContent = "Decline";
    decline.dataset.focusKey = `decline:${inv.id}`;
    decline.addEventListener("click", guard(() => submitLock.run(async () => {
      await api("/api/invite/respond", { inviteId: inv.id, accept: false });
      await refresh();
    })));
    li.append(accept, decline);
    els.invitesIn.append(li);
  }

  els.invitesOut.innerHTML = "";
  els.noInvitesOut.hidden = state.outgoingInvites.length > 0;
  for (const inv of state.outgoingInvites) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="grow">to <b>${esc(inv.to.username)}</b> <span class="num">#${inv.to.userId}</span> — waiting</span>`;
    const cancel = document.createElement("button");
    cancel.className = "small secondary";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.dataset.focusKey = `cancel:${inv.id}`;
    cancel.addEventListener("click", guard(() => submitLock.run(async () => {
      await api("/api/invite/respond", { inviteId: inv.id, accept: false });
      await refresh();
    })));
    li.append(cancel);
    els.invitesOut.append(li);
  }

  els.gameList.innerHTML = "";
  els.noGames.hidden = state.games.length > 0;
  for (const g of state.games) {
    const li = document.createElement("li");
    const label =
      g.phase === "setup" ? "setting sequences"
      : g.phase === "playing" ? (g.turn === "me" ? "your turn" : `${g.opponent.username} to move`)
      : g.winner === "me" ? "you won"
      : "you lost";
    li.innerHTML =
      `<span class="grow">vs <b>${esc(g.opponent.username)}</b> <span class="num">#${g.opponent.userId}</span></span>` +
      `<span class="num">${esc(label)}</span>`;
    const open = document.createElement("button");
    open.className = "small";
    open.type = "button";
    open.textContent = "Open";
    open.dataset.focusKey = `open:${g.id}`;
    open.addEventListener("click", () => {
      selectedGameId = g.id;
      render();
    });
    li.append(open);
    els.gameList.append(li);
  }
}

/* -------------------------------- game ----------------------------------- */

function digitTile(d, mark = "plain", sm = false) {
  return `<span class="digit ${sm ? "sm " : ""}${mark}">${d}</span>`;
}

function tilesOf(seq, marks, sm = false) {
  return `<span class="digits-cell">${seq
    .map((d, i) => digitTile(d, marks ? marks[i] : "plain", sm))
    .join("")}</span>`;
}

function renderGame(game) {
  const g = game;

  // The board is rebuilt wholesale via innerHTML, which recreates every field
  // in it. Snapshot the player's in-progress entry — the secret *and* the
  // guess, with focus and caret — so a refresh that lands mid-typing (the
  // opponent submitting their sequence pushes game.updated to both players)
  // cannot erase what they have typed.
  const typedInputs = snapshotInputs(
    [...els.gameBoard.querySelectorAll("input")],
    document.activeElement
  );

  const head = `
    <div class="game-head">
      <h2>vs ${esc(g.opponent.username)} <span class="num">#${g.opponent.userId}</span></h2>
      <span class="phase-chip">${g.phase === "setup" ? "Setup" : g.phase === "playing" ? "Playing" : "Finished"}</span>
    </div>`;

  let body = "";

  if (g.phase === "setup") {
    body += g.mySetup
      ? `<p>Your sequence is set: <span class="secret-tiles">${g.mySecret.map((d) => digitTile(d, "plain")).join("")}</span></p>
         <p class="muted">${g.opponentSetup ? "Starting…" : `Waiting for ${esc(g.opponent.username)} to choose a sequence…`}</p>`
      : `<h3>Choose your secret sequence</h3>
         <p class="muted">4 digits, 0–9. Repeats allowed, leading zeros count.</p>
         <div class="secret-row">
           <input id="input-secret" type="text" class="digits" inputmode="numeric" maxlength="4"
                  pattern="\\d{4}" placeholder="0000" autocomplete="off" />
           <button id="btn-secret-manual" type="button" data-submit data-focus-key="secret-manual">Set</button>
           <button id="btn-secret-random" class="secondary" type="button" data-submit data-focus-key="secret-random">🎲 Random</button>
         </div>`;
  }

  if (g.phase === "playing") {
    body += g.turn === "me"
      ? `<div class="turn-banner mine">Your turn — guess ${esc(g.opponent.username)}'s sequence.</div>
         <div class="guess-row">
           <input id="input-guess" type="text" class="digits" inputmode="numeric" maxlength="4"
                  pattern="\\d{4}" placeholder="0000" autocomplete="off" />
           <button id="btn-guess" type="button" data-submit data-focus-key="guess">Guess</button>
           <span class="muted">Your secret: <span class="secret-tiles">${g.mySecret.map((d) => digitTile(d, "plain", true)).join("")}</span></span>
         </div>`
      : `<div class="turn-banner theirs">${esc(g.opponent.username)} is guessing… <span class="muted">(${g.opponentGuessCount} guesses so far)</span></div>`;
  }

  if (g.phase === "finished") {
    body += g.winner === "me"
      ? `<div class="banner win">🏆 You cracked their sequence!</div>`
      : `<div class="banner lose">💥 ${esc(g.opponent.username)} cracked yours first.</div>`;
    body += `<div class="reveal">
        <div class="side"><h4>Their sequence was</h4><span class="secret-tiles">${g.opponentSecret.map((d) => digitTile(d, "plain")).join("")}</span></div>
        <div class="side"><h4>Your sequence was</h4><span class="secret-tiles">${g.mySecret.map((d) => digitTile(d, "plain")).join("")}</span></div>
      </div>`;
  }

  let history = "";
  if (g.myHistory.length > 0) {
    history = `<table class="results">
      <thead><tr>
        <th>#</th><th>Guess</th>
        <th title="Right digit, right place">✔ Correct place</th>
        <th title="Right digit, wrong place">➜ Wrong place</th>
        <th title="Not in their sequence">✖ Incorrect</th>
      </tr></thead>
      <tbody>${g.myHistory
        .map(
          (row, i) => `<tr>
            <td>${i + 1}</td>
            <td>${tilesOf(row.guess, row.marks, true)}</td>
            <td class="c-ok">${row.counts.correct}</td>
            <td class="c-part">${row.counts.misplaced}</td>
            <td class="c-none">${row.counts.incorrect}</td>
          </tr>`
        )
        .join("")}</tbody></table>`;
  }

  els.gameBoard.innerHTML = head + body + history;
  restoreInputs(typedInputs, $);

  const bind = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  bind("btn-secret-manual", "click", guard(async () => {
    const field = $("input-secret");
    const secret = field?.value ?? "";
    if (!/^\d{4}$/.test(secret)) {
      flash("Secret must be exactly 4 digits (0-9)");
      field?.focus();
      return;
    }
    // Through the lock: without it a double-click sends a second setup request
    // that the server rejects with 409 already_set, so the player who just
    // succeeded is shown an error toast for their own success.
    await submitLock.run(async () => {
      await api("/api/game/setup", { gameId: g.id, mode: "manual", secret });
      await refresh();
    });
  }));
  bind("input-secret", "keydown", (e) => {
    if (e.key === "Enter") $("btn-secret-manual").click();
  });
  bind("btn-secret-random", "click", guard(async () => {
    await submitLock.run(async () => {
      await api("/api/game/setup", { gameId: g.id, mode: "random" });
      await refresh();
    });
  }));
  bind("btn-guess", "click", submitGuess(g));
  bind("input-guess", "keydown", (e) => {
    if (e.key === "Enter") submitGuess(g)();
  });
}

function submitGuess(g) {
  return guard(async () => {
    const field = $("input-guess");
    const guess = field?.value ?? "";
    if (!/^\d{4}$/.test(guess)) {
      flash("Guess must be exactly 4 digits (0-9)");
      field?.focus();
      return;
    }
    await submitLock.run(async () => {
      await api("/api/game/guess", { gameId: g.id, guess });
      // Discard the guess only now that the server accepted it, and write it to
      // the field that is on screen *now*: a game.updated can rebuild the board
      // while this request is in flight, and clearing the node the click came
      // from would leave the digits in front of the player.
      const live = $("input-guess");
      if (live) live.value = "";
      await refresh();
    });
  });
}

/* ------------------------------- startup --------------------------------- */

$("btn-back").addEventListener("click", () => {
  selectedGameId = null;
  render();
});

$("form-register").addEventListener(
  "submit",
  guard(async (e) => {
    e.preventDefault();
    const username = $("input-username").value.trim();
    await submitLock.run(async () => {
      const res = await api("/api/register", { username });
      token = res.token;
      localStorage.setItem(TOKEN_KEY, token);
      connectEvents();
      await refresh();
      flash(`Welcome, ${res.username}! You are #${res.userId}.`, true);
    });
  })
);

(async function start() {
  if (token) {
    try {
      await refresh();
      connectEvents();
      return;
    } catch {
      /* stale token or server down — fall through to register */
    }
  }
  showView("register");
})();
