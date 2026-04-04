import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

const dbPath = join(homedir(), ".claude-peers.db");
const db = new Database(dbPath);

const count = db.query("SELECT COUNT(*) as c FROM messages").get() as { c: number };
console.log(`Existing messages: ${count.c}`);

// Migrate: rename old -> create new -> copy -> remove old
db.run("ALTER TABLE messages RENAME TO messages_old");
db.run(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  room_id TEXT,
  FOREIGN KEY (from_id) REFERENCES peers(id)
)`);
db.run("INSERT INTO messages (id, from_id, to_id, text, sent_at, delivered, room_id) SELECT id, from_id, to_id, text, sent_at, delivered, room_id FROM messages_old");

// Remove old table
db.exec("DROP TABLE messages_old");

const newSchema = db.query("SELECT sql FROM sqlite_master WHERE name='messages'").get();
console.log("New schema:", JSON.stringify(newSchema));
console.log("Migration complete");
