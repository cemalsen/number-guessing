# Design brief — Number Guessing (web client)

Audience and primary task: two players on one LAN/host taking turns cracking each
other's 4-digit code; the screen must answer "is it my turn, what do I type, what
did my last guess tell me" at a glance.

System and scope: greenfield, zero-dependency static client (no framework, no kit).
Design direction stated here instead of adopting a kit — the app is 3 small views.

Direction: **dark game console**. Near-black navy backdrop, raised panel surfaces,
digits as monospace tiles (Mastermind-peg metaphor) — the tile is the product's
signature object, used for secrets, guesses and result marks alike. Status colors
are semantic, not decorative: green = correct position, amber = wrong position,
grey = incorrect, blue = the single primary action.

Content priority: (1) whose turn / what action is mine now, (2) my guess input,
(3) my results table, (4) lobby lists and metadata (muted).

Layout and type: single system-ui stack; one accent; centered ≤1080px column;
lobby = responsive card grid; game view = vertical flow (head → turn banner →
action → history table). Tables keep numeric alignment, no prose measure.

States: disabled guess off-turn; empty lists copy; flash error toast with server
message; win/lose banner; setup waiting state; reduced-motion N/A (no animation).

Avoid: gradient hero, marketing copy, emoji walls, wrapping every paragraph in a
card, decorative buttons that do nothing.

Acceptance: main action readable in first screen; guess disabled off-turn; table
renders all three categories per guess; long usernames wrap without overflow;
keyboard-only register→invite→guess works.

Assumptions: no theming requirement, no i18n, single accent is enough; players
share one screen/browser per device (two tabs is the tested path).
