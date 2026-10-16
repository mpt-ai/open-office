# Agent Office — notes

Local browser UI that watches OpenCode agents and sub-agents as a cartoon
office: one root session = one meeting room, each agent/sub-agent session is a
seat at the table, activity shows as speech bubbles + a whiteboard.

Data source: `~/.local/share/opencode/opencode.db` opened **read-only** via
Node's built-in `node:sqlite` (zero deps, no auth needed — the OpenCode HTTP
API at `127.0.0.1:<port>` is Basic-auth protected, we deliberately do not use
it). Poll our own JSON API every ~2.2s.

## Home = ONE open-plan virtual office (v4)

The cards are gone: home is a single big stage (`#floorStage`, `.co-stage`) —
one shared room with a back wall, **one office door**, wall board (“THE BOARD”),
clock, window, coffee corner. Each root session is a **desk pod** (`fl-tab` oval
table + taped name sign + invisible hit area) placed on the same floor with
per-room hash jitter (staggered rows, varied desk sizes) so it reads like a real
office, not a grid.
- `/api/sessions` returns `crew_live` = `id‟agent` pairs of sub-agents whose
  newest message is NOT `idle` (still working). **One actor per live session id**
  — identities, not decoration.
- Life cycle: new live id → actor spawns at the door (door swings, sign reads
  “worker arrived”), walks door→lane→seat and works while the pod is busy;
  report filed (id vanishes from `crew_live`) → stands, walks out the same door
  (“goodbye”), node removed at the doorway. Leads seat instantly on first paint
  (no 20-person stampede) and thereafter walk in through the door like everyone.
- Rooms dropping out of the top-18 (or unseen for ~20 s) evict: whole pod files
  out through the door, props fade.
- Departed actors join `FLD.ghosts` and keep stepping in `flFrame` until they
  reach the door (or 14 s hard cap) — dropping a pod never freezes anyone.
  `stopFloor` wipes actors/pods/ghosts so no nodes leak across views.
- Click any table/sign → that meeting room (`#/room/<id>`).

## Floor = miniature offices per card (v3, superseded)

Kept for history: mini stage per room card, `crew`-driven sitter mix, 2 rovers
per card cycling `gone → inming → visit → outgoing`. Replaced by v4 because a
wall of little rooms still read as cards, not as one virtual office.

## The stage engine (v2 — full animation)

`showRoom()` builds one cartoon office "stage" (wall + floor in one element).
Every agent/sub-agent session = an actor `<div>` (inline SVG body) that the
rAF loop drives: feet-position `x,y`, `z-index = y` (painter's algorithm —
actors walk behind/in front of the table), facing flips (L/R/away), classes
`moving|seated|typing|hammering|gazing|zzz-on` drive CSS keyframe animation.

Sim model (app.js, "SIM" section):
- states: `enter | work | rest | exit`; micro-role `kind`: lead/sit/roam/board
- slots: lead head-seat, inner ring 11, outer ring 12, couch×3, bench×2;
  `used` claims keep two actors out of one chair; resize re-matches slots
  (`buildSlotsPreserving`) and snap-vs-rewalks so scrollbar jitter doesn't
  trigger inches of marching
- routing: `shortVia()` = invisible-node graph with a back-wall corridor and
  a front hall; segment sampling skips the table rect, so nobody walks through
  furniture
- life: working seat → sit at chair (legs fold `seated`), typing/hammering/
  thinking from DB state; idle →.todo couch/bench (zzz); tester/explore roam
  to the wall desk, doc-writer/reviewer walk to the TODAY'S BRIEF board;
  micro-trips to coffee (66 px/s × speed dial 0.5–3×); archived → walk out the
  door (door swings + amber LED), node removed; fresh open seeds recent
  sub-agents as staggered walk-ins (420 ms beats), old ones materialize seated
- human: your seat by the coffee; walks to the lead and displays your latest
  prompt in a bubble; click anyone = peek (quiet room + dossier bubble)

## TODO — replace polling with WebSocket (realtime)

Current latency = poll interval (~2s) + one fresh SQLite aggregate query per
tick. Fine for a toy, but every seat redraw is a full `/api/room` payload.

Two paths, pick one:

### A. Server pushes what changed (recommended, keeps zero-dep)

- Add `ws` upgrade handling to `server.mjs` with a tiny hand-rolled RFC6455
  frame writer (text frames only, no extensions — ~60 lines), or add the
  `ws` npm package if that's acceptable.
- Detect changes by watching the DB, not by heavy polling:
  - `fs.watch` on the db file + the `-wal` file gets a touch on every commit.
  - Cheap existence probe instead of full queries:
    `SELECT MAX(seq) FROM session_message WHERE session_id IN (...)` or a
    global `SELECT MAX(time_updated) FROM session_v2` — compare against the
    last seen value, only rebuild the payload when it moved.
- Message shape: `{type:"room", id, seats:[...], board:{...}}` and
  `{type:"floor", rooms:[...]}`. Client swaps `setInterval(loadRoom)` for
  `ws.onmessage` and keeps polling only as a fallback when the socket drops.
- Debounce bursts (a chatty agent commits many times per second): coalesce to
  one push every ~150–300ms.
- Do the work in `activityFor()` incrementally: remember last seen
  `(session_id, seq)` per room and only re-summarize messages that moved.

### B. Subscribe to OpenCode's own event stream

- OpenCode exposes a server-sent-events endpoint (same host/port as the API),
  so it also needs the Basic-auth credentials from `auth.json` — do not hardcode
  them; read from an env var the user exports.
- Events of interest: `session.updated`, `message.updated`,
  `message.part.updated` (see the `event` table for the shapes it persists).
- Pro: instant, no polling, includes in-flight streaming state (today we only
  see a message once its row is written). Con: couples us to the running
  server's auth + an API that moves between versions.

Notes either way:
- Keep `GET /api/room` as the initial-state fetch; socket only carries deltas.
- Room view must survive reconnects: on `onclose`, back off 1s→2s→5s and refetch.
- Never open the DB read-write. SQLite in read-only mode tolerates a live WAL
  writer; if a read hits `SQLITE_BUSY`, catch it and skip that tick rather
  than killing the server.

## Small stuff noticed while building

- `session_v2.parent_id` is what marks a sub-agent spawn (`agent` column holds
  the role name: developer, tester, explore…); `agent:'task'` tool calls in the
  parent are the moment it was created.
- Active-only inference is a heuristic: `state.running` comes from tool status
  on the newest assistant message; a room with no message written in 3+ minutes
  counts as resting.
- Big rooms hide retired sub-agents past 24 seats (`hidden_children`), the lead
  is `×N` of the spawn tree.
- Busy/idle timeouts live at the top of `server.mjs` (2/3 min active windows,
  40 min nap window).
```
