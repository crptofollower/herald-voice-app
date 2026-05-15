================================================================================
HERALD BACKEND PATCHES -- Apply to herald_api.py v7.8 on Railway
Generated: May 12, 2026
================================================================================

Two patches. Apply in order. Git push after both. Railway auto-deploys (~60s).

────────────────────────────────────────────────────────────────────────────────
PATCH 1: Bug 2 -- Memory sync (session_id → user_id)
Root cause: Desktop and mobile generate different session_ids.
            Memory written on mobile is invisible on desktop (and vice versa).
Fix: Normalize memory reads/writes to use user_id as the key, not session_id.
────────────────────────────────────────────────────────────────────────────────

In herald_api.py v7.8, memory is stored as profile["memories"] (JSON list).
The session_id normalization fix is in how session_id is resolved, not the
memory table itself. Apply this in the /ask endpoint body parser:

FIND (near top of /ask endpoint, where body fields are extracted):
─────────────────────────────────────────────────────────────────
    session_id = body.get("session_id", "default")

REPLACE WITH:
─────────────────────────────────────────────────────────────────
    # Bug 2 fix (May 12, 2026): normalize session_id to user_id.
    # This ensures desktop + mobile both read the same memory.
    # If the client sends a session_id, honor it for logging only --
    # never use it as the memory key.
    session_id = body.get("session_id") or user_id

────────────────────────────────────────────────────────────────────────────────
ALSO: Wherever memories are saved to the profile, ensure user_id is checked,
not session_id. In the LLM learning loop (save_memory / extract_facts):

FIND (in LLM learning loop, memory write block):
─────────────────────────────────────────────────────────────────
    profile = get_profile(session_id)   ← if this pattern exists

REPLACE WITH:
─────────────────────────────────────────────────────────────────
    profile = get_profile(user_id)      ← always key by user_id

────────────────────────────────────────────────────────────────────────────────
ALSO: In build_system() / build_ask_context(), wherever memories are loaded:

FIND:
─────────────────────────────────────────────────────────────────
    memories = profile.get("memories", [])  ← already correct if
                                               profile loaded by user_id

Verify the profile load at the TOP of /ask uses user_id:
─────────────────────────────────────────────────────────────────
    profile = get_profile(user_id)   ← this line should already exist

If it does, Patch 1 is likely already correct. The session_id normalization
line above is the only addition needed.

────────────────────────────────────────────────────────────────────────────────
PATCH 2: Bug 3 -- Freddie block in morning briefing (owner only)
Root cause: morning_briefing_job() generates weather + life context for owner
            but does not include Freddie swarm status.
Fix: Fetch empire_status.json (already fetched elsewhere via fetch_empire())
     and inject a Freddie summary block for owner only.
────────────────────────────────────────────────────────────────────────────────

In herald_api.py v7.8, find morning_briefing_job() (APScheduler 07:00 ET).

FIND the section that builds the briefing prompt for owner (look for
profile.get("is_owner") or is_owner() check inside the job):
─────────────────────────────────────────────────────────────────

    # Somewhere in morning_briefing_job(), the briefing text is assembled.
    # It currently includes: weather_section + life_section + struggles/goals.
    # We're adding: freddie_block (owner only).

ADD this function above morning_briefing_job() if fetch_empire() exists:
─────────────────────────────────────────────────────────────────

def build_freddie_morning_block(empire: dict) -> str:
    """
    Build compact Freddie line for morning briefing.
    Example output: "Freddie: Bear regime, chop window. Gate 0/20. DOT SHORT 52. Swarm healthy."
    Only called for owner. empire dict comes from fetch_empire().
    """
    if not empire:
        return ""
    regime        = empire.get("regime", "unknown").capitalize()
    window        = empire.get("window", "unknown").lower()
    gate_p        = empire.get("gate_progress", empire.get("gate", {}).get("progress", 0))
    gate_t        = empire.get("gate_target",   empire.get("gate", {}).get("target",   20))
    health        = empire.get("health", "unknown")
    near_misses   = empire.get("near_miss", [])

    nm_str = ""
    if near_misses:
        top    = near_misses[0]
        nm_str = f"{top.get('asset','')} {top.get('direction','')} {top.get('score','')}"
    else:
        nm_str = "no setups near threshold"

    health_str = "Swarm healthy" if health == "healthy" else f"Swarm {health}"

    return (
        f"Freddie: {regime} regime, {window} window. "
        f"Gate {gate_p}/{gate_t}. {nm_str}. {health_str}."
    )

─────────────────────────────────────────────────────────────────

THEN inside morning_briefing_job(), FIND where briefing_parts is assembled
(the list that gets joined into the final message sent to Haiku):

FIND (approximate -- match to your actual variable names):
─────────────────────────────────────────────────────────────────
    briefing_parts = [
        weather_section,
        personal_section,
        # ... etc
    ]

ADD before the join:
─────────────────────────────────────────────────────────────────
    # Freddie block -- owner only (Bug 3 fix, May 12 2026)
    if profile.get("is_owner"):
        empire = fetch_empire()   # already in scope if called earlier, or call again
        freddie_block = build_freddie_morning_block(empire)
        if freddie_block:
            briefing_parts.append(freddie_block)

─────────────────────────────────────────────────────────────────

NOTE: fetch_empire() is already in herald_api.py at line 1421. It reads
EMPIRE_URL (empire_status.json from GitHub raw). No new network dependency.

================================================================================
AFTER BOTH PATCHES:
================================================================================

1. git add herald_api.py
2. git commit -m "v7.9: Bug2 memory sync + Bug3 Freddie morning block"
3. git push → Railway auto-deploys (~60s)
4. Check: GET https://web-production-b4083.up.railway.app/health
   Expect: {"version":"7.9","proactive_loop":"enabled"}
5. Test: Send a message from desktop → verify mobile recalls it
6. Test: Wait for next 7am briefing OR hit /cron/morning manually if endpoint exists

VERSION: Bump to 7.9 after both patches applied.

================================================================================
END BACKEND PATCHES
================================================================================
