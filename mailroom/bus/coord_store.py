"""Resolve the private Mailroom state directory for the server and CLI."""
from __future__ import annotations

import os
from pathlib import Path
import sys


def resolve_store() -> tuple[Path, str]:
    value = os.environ.get("COORD_STORE")
    if value:
        return Path(value).expanduser().resolve(), "env"
    root = Path(__file__).resolve().parents[2]
    return root / ".mailroom-data", "default"


if __name__ == "__main__":
    store, source = resolve_store()
    missing = [name for name in ("bus", "attachments") if not (store / name).is_dir()]
    print(f"store={store} source={source} missing={','.join(missing) or 'none'}")
    sys.exit(bool(missing))
