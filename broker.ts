#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  LeaveRoomRequest,
  PostRoomRequest,
  ListRoomsResponse,
  Room,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    room_id TEXT,
    FOREIGN KEY (from_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, peer_id),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id),
    FOREIGN KEY (peer_id) REFERENCES peers(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS room_deliveries (
    message_id INTEGER NOT NULL,
    peer_id TEXT NOT NULL,
    PRIMARY KEY (message_id, peer_id),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (peer_id) REFERENCES peers(id)
  )
`);

// Migration: add room_id column to messages if missing (existing DBs)
try {
  db.run("ALTER TABLE messages ADD COLUMN room_id TEXT");
} catch {
  // Column already exists, ignore
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// Room prepared statements

const insertRoom = db.prepare(`
  INSERT INTO rooms (room_id, name, created_at) VALUES (?, ?, ?)
`);

const insertRoomMember = db.prepare(`
  INSERT OR IGNORE INTO room_members (room_id, peer_id, joined_at) VALUES (?, ?, ?)
`);

const deleteRoomMember = db.prepare(`
  DELETE FROM room_members WHERE room_id = ? AND peer_id = ?
`);

const selectRoomsByPeer = db.prepare(`
  SELECT r.room_id, r.name, r.created_at
  FROM rooms r
  JOIN room_members rm ON r.room_id = rm.room_id
  WHERE rm.peer_id = ?
`);

const selectRoomMembers = db.prepare(`
  SELECT peer_id FROM room_members WHERE room_id = ?
`);

const insertRoomMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, room_id)
  VALUES (?, NULL, ?, ?, 0, ?)
`);

const selectUndeliveredRoomMessages = db.prepare(`
  SELECT m.* FROM messages m
  JOIN room_members rm ON m.room_id = rm.room_id
  WHERE rm.peer_id = ?
    AND m.from_id != ?
    AND m.room_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM room_deliveries rd
      WHERE rd.message_id = m.id AND rd.peer_id = rm.peer_id
    )
  ORDER BY m.sent_at ASC
`);

const insertRoomDelivery = db.prepare(`
  INSERT OR IGNORE INTO room_deliveries (message_id, peer_id) VALUES (?, ?)
`);

const selectRoom = db.prepare(`
  SELECT * FROM rooms WHERE room_id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

// --- Room handlers ---

function handleCreateRoom(body: CreateRoomRequest): CreateRoomResponse {
  const room_id = generateId();
  const now = new Date().toISOString();
  insertRoom.run(room_id, body.name, now);
  return { room_id, name: body.name };
}

function handleJoinRoom(body: JoinRoomRequest): { ok: boolean; error?: string } {
  const room = selectRoom.get(body.room_id) as Room | null;
  if (!room) {
    return { ok: false, error: `Room ${body.room_id} not found` };
  }
  insertRoomMember.run(body.room_id, body.peer_id, new Date().toISOString());
  return { ok: true };
}

function handleLeaveRoom(body: LeaveRoomRequest): { ok: boolean } {
  deleteRoomMember.run(body.room_id, body.peer_id);
  return { ok: true };
}

function handlePostRoom(body: PostRoomRequest): { ok: boolean; error?: string } {
  const room = selectRoom.get(body.room_id) as Room | null;
  if (!room) {
    return { ok: false, error: `Room ${body.room_id} not found` };
  }
  insertRoomMessage.run(body.from_id, body.message, new Date().toISOString(), body.room_id);
  return { ok: true };
}

function handleListRooms(body: { peer_id: string }): ListRoomsResponse {
  const rooms = selectRoomsByPeer.all(body.peer_id) as Room[];
  return { rooms };
}

function handlePollRoomMessages(body: { peer_id: string }): PollMessagesResponse {
  const messages = selectUndeliveredRoomMessages.all(body.peer_id, body.peer_id) as Message[];
  // Per-member delivery tracking: record that this peer has received each message
  for (const msg of messages) {
    insertRoomDelivery.run(msg.id, body.peer_id);
  }
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        case "/create-room":
          return Response.json(handleCreateRoom(body as CreateRoomRequest));
        case "/join-room":
          return Response.json(handleJoinRoom(body as JoinRoomRequest));
        case "/leave-room":
          return Response.json(handleLeaveRoom(body as LeaveRoomRequest));
        case "/post-room":
          return Response.json(handlePostRoom(body as PostRoomRequest));
        case "/list-rooms":
          return Response.json(handleListRooms(body as { peer_id: string }));
        case "/poll-room-messages":
          return Response.json(handlePollRoomMessages(body as { peer_id: string }));
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
