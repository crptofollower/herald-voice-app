"""
BACKEND PATCH: Bug 3 / Priority 3 -- Freddie block in morning briefing
File: herald_api.py (or morning_briefing_job.py if extracted)
Issue: Morning message has weather + personal context but no Freddie data.
Fix: Fetch /freddie/status and inject briefing_block for owner users.

Priority: MEDIUM. Apply in next Herald session.
"""

import os
import json
import urllib.request
from datetime import datetime

# ─── Config ───────────────────────────────────────────────────────────────────

FREDDIE_STATUS_URL = "http://143.198.18.66:8082"  # VM webhook port
GITHUB_STATUS_URL = (
    "https://raw.githubusercontent.com/crptofollower/freddie-empire/"
    "main/empire_status.json"
)
OWNER_USER_ID = os.environ.get("HERALD_OWNER_USER_ID", "")
OWNER_AUTH_CODE = os.environ.get("HERALD_OWNER_AUTH_CODE", "")


def fetch_empire_status() -> dict | None:
    """
    Fetch Freddie's empire_status.json from GitHub cache.
    Falls back to None gracefully -- morning briefing still sends without it.
    """
    try:
        req = urllib.request.Request(
            GITHUB_STATUS_URL,
            headers={"Cache-Control": "no-cache"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def build_freddie_briefing_block(status: dict) -> str:
    """
    Build a compact Freddie block for the morning briefing.
    Matches the format in the handoff doc:
    'Freddie: Bear regime, chop window. Gate at 0/20. DOT SHORT at 52. Swarm healthy.'
    """
    if not status:
        return ""

    regime = status.get("regime", "unknown").capitalize()
    window = status.get("window", "unknown").capitalize()
    gate_progress = status.get("gate_progress", 0)
    gate_target = status.get("gate_target", 20)
    health = status.get("health", "unknown")
    near_misses = status.get("near_miss", [])

    # Build near miss string
    if near_misses:
        top = near_misses[0]
        asset_str = f"{top['asset']} {top['direction']} at {top['score']}"
    else:
        asset_str = "no setups near threshold"

    health_str = "Swarm healthy" if health == "healthy" else f"Swarm {health}"

    return (
        f"Freddie: {regime} regime, {window.lower()} window. "
        f"Gate at {gate_progress}/{gate_target}. "
        f"{asset_str}. {health_str}."
    )


# ─── Patch for morning_briefing_job() ─────────────────────────────────────────

# FIND your morning_briefing_job function and add this block
# just before you assemble the final briefing message.

PATCH_EXAMPLE = '''
async def morning_briefing_job():
    """
    Modified morning briefing -- includes Freddie block for owner.
    Add this block to your existing function.
    """
    # ... your existing weather + memory + personal context code ...

    # === FREDDIE BLOCK (owner only) ===
    freddie_block = ""
    if user_id == OWNER_USER_ID:
        empire_status = fetch_empire_status()
        if empire_status:
            freddie_block = build_freddie_briefing_block(empire_status)

    # === Assemble briefing ===
    briefing_parts = [
        weather_section,       # your existing weather
        personal_section,      # your existing personal context
    ]

    if freddie_block:
        briefing_parts.append(freddie_block)

    briefing_text = "\\n\\n".join(p for p in briefing_parts if p)

    # ... rest of your send logic (SendGrid / proactive_queue) ...
'''


# ─── Test it ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Testing empire_status fetch...")
    status = fetch_empire_status()

    if status:
        print("Status fetched successfully:")
        print(json.dumps(status, indent=2))
        block = build_freddie_briefing_block(status)
        print(f"\nFreddie briefing block:")
        print(block)
    else:
        print("Could not fetch empire_status.json from GitHub.")
        print("Check: github.com/crptofollower/freddie-empire/blob/main/empire_status.json")

        # Use mock data for testing
        mock_status = {
            "regime": "BEAR",
            "window": "CHOP",
            "gate_progress": 0,
            "gate_target": 20,
            "health": "healthy",
            "near_miss": [
                {"asset": "DOT", "direction": "SHORT", "score": 52}
            ],
        }
        block = build_freddie_briefing_block(mock_status)
        print(f"\nMock Freddie briefing block:")
        print(block)
