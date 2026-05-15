"""
BACKEND PATCH: Bug 2 -- Desktop/Mobile Memory Sync
File: herald_api.py
Issue: Desktop says "no record" while mobile recalls Destin, upgrade, Palm Springs.
Root cause: session_id differs between clients; SQLite pulls by session_id not user_id.
Fix: Normalize /ask to always pull memory by user_id, not session_id.

Paste these replacements into herald_api.py.
"""

# ─── FIND this pattern in your /ask endpoint ─────────────────────────────────

# OLD (pulls by session -- breaks desktop):
"""
memory = db.execute(
    "SELECT content FROM memories WHERE session_id = ?",
    (session_id,)
).fetchall()
"""

# NEW (pull by user_id -- works on all clients):
MEMORY_FETCH_PATCH = """
# Normalize: always load memories by user_id, not session_id
# This fixes desktop/mobile sync (Bug 2, May 10 2026)
memory = db.execute(
    \"\"\"
    SELECT content, created_at
    FROM memories
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 40
    \"\"\",
    (user_id,)
).fetchall()
memory_context = "\\n".join(row[0] for row in reversed(memory))
"""

# ─── FIND this pattern in memory write ───────────────────────────────────────

# OLD (stores by session_id):
"""
db.execute(
    "INSERT INTO memories (session_id, content) VALUES (?, ?)",
    (session_id, new_memory)
)
"""

# NEW (stores by user_id + session_id -- readable everywhere):
MEMORY_WRITE_PATCH = """
# Store with user_id so any session can read it (Bug 2 fix)
db.execute(
    \"\"\"
    INSERT INTO memories (user_id, session_id, content, created_at)
    VALUES (?, ?, ?, datetime('now'))
    \"\"\",
    (user_id, session_id, new_memory)
)
db.commit()
"""

# ─── Schema migration (run once on Railway) ──────────────────────────────────

SCHEMA_MIGRATION = """
-- Run this once on your Railway SQLite to add user_id column
-- to existing memories table if it doesn't have one yet.

ALTER TABLE memories ADD COLUMN user_id TEXT;
ALTER TABLE memories ADD COLUMN created_at TEXT DEFAULT (datetime('now'));

-- Back-fill user_id from session_id where possible
-- (You may need to manually set these from your known mapping)
-- UPDATE memories SET user_id = 'miked_user_id' WHERE session_id = 'known_session';

-- Create index for efficient user-scoped queries
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id, created_at);
"""

# ─── /ask endpoint: session_id extraction ────────────────────────────────────

# FIND in your /ask endpoint where session_id is set:
# OLD: session_id = request.headers.get("X-Session-ID", "default")
# NEW:
SESSION_ID_PATCH = """
# Accept session_id from header OR body. Fallback to user_id so
# desktop and mobile always map to the same memory store.
session_id = (
    request.headers.get("X-Session-ID")
    or body.get("session_id")
    or user_id  # <-- This is the key fix: same user = same memories
)
"""

if __name__ == "__main__":
    print("Herald Backend Patch: Bug 2 -- Desktop/Mobile Memory Sync")
    print("Apply the patches above to herald_api.py on Railway.")
    print("Run SCHEMA_MIGRATION on your SQLite database once.")
    print("Deploy and test: Desktop Herald should recall Destin, Palm Springs, etc.")
