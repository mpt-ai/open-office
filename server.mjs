#!/usr/bin/env node
// Agent Office — local visualizer for OpenCode sessions.
// Reads opencode.db (read-only, via built-in node:sqlite) and serves a tiny
// JSON API + static UI. Zero dependencies. Node >= 22.5 required.
//
// Usage: node server.mjs [--port 7777] [--db ~/.local/share/opencode/opencode.db]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', process.env.PORT || 7777));
const DB_PATH = arg(
  '--db',
  process.env.OPENCODE_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db')
);
const DAY = 24 * 60 * 60 * 1000;
const ALL_WINDOW = 90 * DAY;   // sessions listed in the hallway
const LIVE_WINDOW = 10 * DAY;  // sub-agent status polling window

if (!fs.existsSync(DB_PATH)) {
  console.error(`opencode.db not found at: ${DB_PATH}\nUse --db <path> to point at it.`);
  process.exit(1);
}

let db = null;
function getDb() {
  // reopen if the file was replaced (opencode may recreate/migrate)
  if (db) return db;
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  return db;
}

// ---------------------------------------------------------------- helpers
function parseJSON(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
function relTime(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function clip(s, n = 90) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
const TOOL_VERB = {
  shell: 'running a command', bash: 'running a command',
  read: 'reading a file', glob: 'searching files', grep: 'searching code',
  edit: 'editing a file', write: 'writing a file', patch: 'patching a file',
  task: 'spawning an agent', subagent: 'spawning an agent', agent: 'spawning an agent',
  webfetch: 'browsing the web', websearch: 'searching the web',
  todowrite: 'updating the todo board', todo: ' updating the todo board', todo_write: 'updating the todo board',
  question: 'asking the human', skill: 'loading a skill',
  lsp: 'querying the language server', doctor: 'doctor check',
  execute: 'running code',
};
function humanTool(name, input) {
  const verb = TOOL_VERB[name] || `using ${name}`;
  if (!input) return verb;
  const hint =
    input.command || input.path || input.url || input.pattern ||
    input.file_path || input.filePath || input.query || input.content || '';
  return hint ? `${verb} · ${clip(hint, 70)}` : verb;
}

// Summarize one assistant session_message row -> activity info
function summarizeMessage(raw) {
  const msg = parseJSON(raw, null);
  if (!msg) return null;
  const content = Array.isArray(msg.content) ? msg.content : [];
  let lastText = '', lastTool = '', lastToolName = '', toolStatus = '', spawnHint = '';
  let spawned = 0, thinking = false, running = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text) lastText = part.text;
    if (part.type === 'reasoning' && !part.time?.completed) thinking = true;
    if (part.type === 'tool') {
      const st = part.state || {};
      lastToolName = part.name || 'tool';
      lastTool = humanTool(lastToolName, st.input);
      toolStatus = st.status || '';
      running = running || toolStatus === 'running' || toolStatus === 'pending';
      if (lastToolName === 'task' || lastToolName === 'subagent') {
        spawned++;
        spawnHint = st.input?.subagent_type || st.input?.agent || '';
      }
    }
  }
  return {
    finishedAt: msg.time?.completed || msg.time?.created || 0,
    finished: !!msg.finish,
    thinking, running, lastText, lastTool, lastToolName, toolStatus, spawned, spawnHint,
    cost: msg.cost || 0,
    tokens: msg.tokens ? (msg.tokens.output || 0) + (msg.tokens.input || 0) : 0,
  };
}

// latest message + derived status for a set of session ids
function activityFor(ids) {
  const out = {};
  if (!ids.length) return out;
  const d = getDb();
  const marks = ids.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT m.session_id, m.type, m.data FROM session_message m
    WHERE m.session_id IN (${marks})
      AND m.seq = (SELECT MAX(seq) FROM session_message c WHERE c.session_id = m.session_id)
  `).all(...ids);
  for (const r of rows) {
    if (r.type === 'user') {
      const m = parseJSON(r.data, {});
      out[r.session_id] = { running: true, lastText: clip(m.text || ''), lastTool: '', lastToolName: '', spawnHint: '', spawned: 0, thinking: false, finished: false, finishedAt: m.time?.created || 0 };
    } else if (r.type === 'idle') {
      // OpenCode writes an `idle` message when a session's task fully finishes
      out[r.session_id] = { running: false, lastText: '', lastTool: '', lastToolName: '', spawnHint: '', spawned: 0, thinking: false, finished: true, finishedAt: parseJSON(r.data, {})?.time?.created || 0 };
    } else {
      out[r.session_id] = summarizeMessage(r.data);
    }
  }
  return out;
}

// ---------------------------------------------------------------- API

// GET /api/sessions?window=all|live -> room cards for the hallway
function apiSessions() {
  const now = Date.now();
  const d = getDb();
  const cutoff = now - ALL_WINDOW;
  const rooms = d.prepare(`
    SELECT s.id, s.title, s.agent, s.model, s.directory, s.cost,
           s.tokens_input, s.tokens_output, s.time_created, s.time_updated, s.time_archived,
           p.worktree, p.name AS project,
           (SELECT COUNT(*) FROM session_v2 c WHERE c.parent_id = s.id) AS kids,
           (SELECT COUNT(*) FROM session_v2 c WHERE c.parent_id = s.id
             AND c.time_archived IS NULL AND c.time_updated > strftime('%s','now','-15 minutes')*1000) AS kids_active,
           (SELECT group_concat(c.agent) FROM session_v2 c WHERE c.parent_id = s.id) AS crew,
           (SELECT group_concat(c.agent) FROM session_v2 c
             WHERE c.parent_id = s.id AND c.time_archived IS NULL
               AND c.time_updated > strftime('%s','now','-15 minutes')*1000) AS crew_active,
           (SELECT group_concat(c.id || char(31) || c.agent) FROM session_v2 c
             WHERE c.parent_id = s.id AND c.time_archived IS NULL
               AND c.time_updated > strftime('%s','now','-25 minutes')*1000
               AND NOT EXISTS (SELECT 1 FROM session_message m
                 WHERE m.session_id = c.id
                   AND m.seq = (SELECT MAX(seq) FROM session_message m2 WHERE m2.session_id = c.id)
                   AND m.type = 'idle')) AS crew_live,
           (SELECT MAX(c.time_updated) FROM session_v2 c WHERE c.parent_id = s.id) AS last_child
    FROM session_v2 s
    LEFT JOIN project p ON p.id = s.project_id
    WHERE s.parent_id IS NULL
      AND (s.time_updated > ? OR s.time_created > ?)
    ORDER BY s.time_updated DESC
    LIMIT 20
  `).all(cutoff, cutoff);

  const ids = rooms.map((r) => r.id);
  const act = activityFor(ids);

  return rooms.map((r) => {
    const a = act[r.id] || {};
    const last = Math.max(r.time_updated || 0, r.last_child || 0);
    const busy = !r.time_archived && now - last < 3 * 60 * 1000;
    return {
      id: r.id,
      title: r.title || '(untitled)',
      agent: r.agent || 'agent',
      project: r.project || (r.worktree ? path.basename(r.worktree) : ''),
      worktree: r.worktree || r.directory || '',
      time_updated: r.time_updated,
      updated_label: relTime(r.time_updated, now),
      last_label: relTime(last, now),
      cost: r.cost || 0,
      kids: r.kids,
      kids_active: r.kids_active || 0,
      crew: r.crew ? String(r.crew).split(',') : [],
      crew_active: r.crew_active ? String(r.crew_active).split(',') : [],
      crew_live: r.crew_live
        ? String(r.crew_live).split(',').map((s) => {
            const [id, agent] = s.split(String.fromCharCode(31));
            return { id, agent };
          })
        : [],
      busy,
      door: r.time_archived ? 'closed' : busy ? 'open' : 'lit',
      status: a.running ? (a.lastTool || 'working') : clip(a.lastText || (a.thinking ? 'thinking…' : 'idle'), 80),
    };
  });
}

// GET /api/room/:id -> room detail + live agents
function apiRoom(id) {
  const now = Date.now();
  const d = getDb();
  const root = d.prepare(`
    SELECT s.*, p.worktree, p.name AS project FROM session_v2 s
    LEFT JOIN project p ON p.id = s.project_id
    WHERE s.id = ?
  `).get(id);
  if (!root) return { error: 'session not found', status: 404 };

  let children = d.prepare(`
    SELECT id, title, agent, model, cost, tokens_input, tokens_output,
           time_created, time_updated, time_archived, parent_id
    FROM session_v2
    WHERE parent_id = ?
    ORDER BY time_created
    LIMIT 200
  `).all(id);
  // A sub-agent is DONE (clocked out) when its newest message is `idle`
  // (OpenCode writes it when the session's task fully finishes). Done agents
  // keep a seat for a few minutes so the UI can walk them out, then vanish.
  const kidAct0 = activityFor(children.map((c) => c.id));
  const DONE_LINGER = 12 * 60 * 1000;   // grace period to be seen leaving
  const doneAt = (c) => {
    if (c.time_archived) return 0;
    const a = kidAct0[c.id] || {};
    if (a.finished) return a.finishedAt || c.time_updated || 0;   // last msg = `idle` → finished
    return null;
  };
  let clockedOutEarlier = 0;
  {
    const notDone = [], doneRecently = [];
    for (const c of children) {
      const dt = doneAt(c);
      if (dt == null) notDone.push(c);
      else if (now - dt < DONE_LINGER) doneRecently.push(c);
      else clockedOutEarlier++;
    }
    doneRecently.sort((a, b) => (doneAt(b) || 0) - (doneAt(a) || 0));
    children = [...notDone, ...doneRecently.slice(0, 8)];
  }
  // keep the table readable: lead + 24 most recently active sub-agents get seats
  const MAX_SEATS = 24;
  let hiddenCount = clockedOutEarlier;
  if (children.length > MAX_SEATS) {
    const byRecent = [...children].sort((a, b) => (b.time_updated || 0) - (a.time_updated || 0));
    const keep = new Set(byRecent.slice(0, MAX_SEATS).map((c) => c.id));
    hiddenCount += children.length - keep.size;
    children = children.filter((c) => keep.has(c.id));
  }

  // sub-agents of sub-agents (one more level) are shown attached to their parent seat
  const allIds = [id, ...children.map((c) => c.id)];
  const grand = allIds.length > 1
    ? d.prepare(`SELECT id, title, agent, time_created, time_updated, time_archived, parent_id FROM session_v2 WHERE parent_id IN (${allIds.map(() => '?').join(',')}) ORDER BY time_created LIMIT 200`).all(...allIds)
    : [];
  const kidsByParent = {};
  for (const g of grand) (kidsByParent[g.parent_id] ||= []).push(g);

  const windowIds = [...allIds.filter((sid) => {
    const c = children.find((x) => x.id === sid) || (sid === id ? root : null);
    return !c || !c.time_archived || now - (c.time_updated || c.time_created || 0) < LIVE_WINDOW;
  }), ...grand.map((g) => g.id)];
  const act = activityFor(windowIds);

  const roles = new Map(); // agent role -> count of occurrences in this room
  function seat(s, isRoot) {
    const a = act[s.id] || {};
    const role = s.agent || (isRoot ? 'lead' : 'agent');
    const last = s.time_updated || s.time_created || 0;
    const age = now - last;
    const active = !s.time_archived && age < 3 * 60 * 1000;
    let state = 'left';
    if (a.running && active) state = 'working';                 // hammering the desk
    else if (a.thinking && active) state = 'thinking';
    else if (!isRoot && a.finished) state = 'left';              // filed report (idle msg) = clocked out
    else if (!s.time_archived && active) state = 'typing';
    else if (!s.time_archived) state = 'rest';                  // idle but still "in the room"
    else state = 'left';
    roles.set(role, (roles.get(role) || 0) + 1);
    return {
      id: s.id,
      root: !!isRoot,
      title: s.title || '(untitled)',
      role,
      born: s.time_created || 0,
      archived: !!s.time_archived,
      model: clip(parseJSON(s.model, {})?.id || '', 30),
      state,
      active,
      bubble: a.running && a.lastTool ? a.lastTool : clip(a.lastText || (state === 'working' ? '…' : ''), 110),
      spawned_children: (kidsByParent[s.id]?.length || 0) + (a.spawned ? Math.max(0, a.spawned - (kidsByParent[s.id]?.length || 0)) : 0),
      spawn_hint: a.spawnHint || '',
      updated_label: relTime(last, now),
      cost: s.cost || 0,
      children: (kidsByParent[s.id] || []).map((g) => seat(g, false)),
    };
  }

  const seats = [seat(root, true), ...children.map((c) => seat(c, false))];

  // whiteboard: todos of everyone in the room
  const todoRows = windowIds.length
    ? d.prepare(`SELECT session_id, content, status, priority, position, time_updated FROM todo
                 WHERE session_id IN (${windowIds.map(() => '?').join(',')})
                 ORDER BY time_updated DESC LIMIT 120`).all(...windowIds)
    : [];

  // whiteboard: recent finished tool lines, newest first
  const recent = [];
  for (const sid of windowIds) {
    const a = act[sid];
    if (a && a.lastTool) recent.push({ session: sid, tool: a.lastTool, at: a.finishedAt || 0 });
  }
  recent.sort((x, y) => y.at - x.at);

  const titleOf = { [id]: root.title };
  for (const c of children) titleOf[c.id] = c.title;
  for (const g of grand) titleOf[g.id] = g.title;

  return {
    room: {
      id: root.id,
      title: root.title || '(untitled)',
      agent: root.agent || 'lead',
      project: root.project || path.basename(root.worktree || root.directory || ''),
      worktree: root.worktree || root.directory || '',
      cost: root.cost || 0,
      updated_label: relTime(root.time_updated || now, now),
      archived: !!root.time_archived,
      hidden_children: hiddenCount,
    },
    seats,
    roles: [...roles.entries()].map(([role, count]) => ({ role, count })),
    board: {
      todos: todoRows.map((t) => ({
        session: t.session_id, title: clip(titleOf[t.session_id] || t.session_id, 40),
        content: t.content, status: t.status,
      })),
      recent: recent.slice(0, 25),
      currentUser: (() => {
        if (!windowIds.length) return [];
        const rows = d.prepare(`SELECT session_id, data FROM session_message
          WHERE session_id IN (${windowIds.map(() => '?').join(',')}) AND type = 'user'
          ORDER BY seq DESC LIMIT 3`).all(...windowIds);
        return rows.map((r) => clip(parseJSON(r.data, {})?.text || ''));
      })(),
    },
    now,
  };
}

// GET /api/live -> "meeting rooms in use" strip for the hallway
function apiLive() {
  const now = Date.now();
  const d = getDb();
  const cutoff = now - LIVE_WINDOW;
  const rows = d.prepare(`
    SELECT s.id, s.parent_id, s.agent, s.title, s.time_updated, s.time_archived,
           r.id AS root_id, r.title AS root_title
    FROM session_v2 s
    JOIN session_v2 r ON r.id = COALESCE(s.parent_id, s.id)
    WHERE s.parent_id IS NULL OR r.time_updated > ?
    ORDER BY s.time_updated DESC
    LIMIT 400
  `).all(cutoff);
  const living = rows.filter((r) => !r.time_archived && now - (r.time_updated || 0) < 4 * 60 * 60 * 1000);
  const act = activityFor(living.map((r) => r.id));
  const byRoot = {};
  for (const r of living) {
    const a = act[r.id] || {};
    const busy = a.running && now - (r.time_updated || 0) < 2 * 60 * 1000;
    const e = (byRoot[r.root_id] ||= { root: r.root_id, title: r.root_title || '', people: 0, busy: 0, activity: '', activity_role: '' });
    e.people++;
    if (busy) e.busy++;
    if (busy && a.lastTool && now - (r.time_updated || 0) > 0 && !e.activity) {
      e.activity = a.lastTool; e.activity_role = r.agent || 'agent';
    }
  }
  return { rooms: Object.values(byRoot).sort((a, b) => b.busy - a.busy || b.people - a.people).slice(0, 40), now };
}

// ---------------------------------------------------------------- server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/sessions') return sendJSON(res, apiSessions());
    if (url.pathname === '/api/live') return sendJSON(res, apiLive());
    let m = url.pathname.match(/^\/api\/room\/([\w-]+)$/);
    if (m) {
      const room = apiRoom(m[1]);
      return sendJSON(res, room, room.status || 200);
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(__dirname, 'web', safe);
    if (!full.startsWith(path.join(__dirname, 'web')) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    sendJSON(res, { error: String(err && err.message || err) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Office  →  http://127.0.0.1:${PORT}`);
  console.log(`db: ${DB_PATH}`);
});
