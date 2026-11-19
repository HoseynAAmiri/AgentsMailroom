#!/usr/bin/env python3
"""Locate the agents-mailroom private store for the server and CLI.

Resolution order:

  1. environment variable COORD_STORE
  2. <app_dir>/coord_store.local        (one path line; relative resolves against <app_dir>)
  3. $XDG_CONFIG_HOME/<app>/coord_store (default ~/.config/agents-mailroom/coord_store)
  4. default store: <app_dir>/.mailroom-data, if it exists
  5. in-place store: <app_dir>, if both bus/ and attachments/ directories exist there
  6. otherwise <app_dir>/.mailroom-data (reported as missing by `check`)

Usage: python3 mailroom/bus/coord_store.py [show|check]
"""
from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
import sys

DEFAULT_NAME = ".mailroom-data"
APP_DIR = Path(__file__).resolve().parents[2]
LOCAL_CONFIG = "coord_store.local"
DEFAULT_CONFIG_APP = "agents-mailroom"


def _expand_user(raw: str, env: Mapping[str, str]) -> str:
    home = env.get("HOME")
    if home and (raw == "~" or raw.startswith("~/")):
        return home.rstrip("/") + raw[1:]
    return os.path.expanduser(raw)


def _read_config(path: Path, base: Path, env: Mapping[str, str]) -> Path | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            p = Path(_expand_user(line, env))
            return (p if p.is_absolute() else base / p).resolve()
    return None


def resolve_store(
    environ: Mapping[str, str] | None = None,
    app_dir: Path | None = None,
    config_app: str | None = None,
) -> tuple[Path, str]:
    """Return the resolved store path and the rule name that selected it."""
    env = os.environ if environ is None else environ
    base = (app_dir or APP_DIR).resolve()
    value = env.get("COORD_STORE", "").strip()
    if value:
        return Path(_expand_user(value, env)).resolve(), "env"
    local = _read_config(base / LOCAL_CONFIG, base, env)
    if local:
        return local, "local-config"
    xdg_raw = env.get("XDG_CONFIG_HOME", "").strip()
    home_raw = env.get("HOME", "").strip()
    home = Path(home_raw) if home_raw else Path.home()
    xdg = Path(_expand_user(xdg_raw, env)) if xdg_raw else home / ".config"
    app = (config_app or env.get("COORD_STORE_APP", "").strip() or DEFAULT_CONFIG_APP)
    user = _read_config(xdg / app / "coord_store", base, env)
    if user:
        return user, "user-config"
    default = (base / DEFAULT_NAME).resolve()
    if default.is_dir():
        return default, "default"
    if (base / "bus").is_dir() and (base / "attachments").is_dir():
        return base, "in-place"
    return default, "default-missing"


def main(argv: list[str]) -> int:
    store, source = resolve_store()
    cmd = argv[1] if len(argv) > 1 else "show"
    if cmd == "show":
        print(f"{store}\t{source}")
        return 0
    if cmd == "check":
        missing = [name for name in ("bus", "attachments") if not (store / name).is_dir()]
        print(f"store={store} source={source} missing={','.join(missing) or 'none'}")
        return 1 if missing else 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
