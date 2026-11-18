#!/usr/bin/env bash
# Point git at the versioned hooks in .githooks/ (pre-commit guard, push refusal).
set -euo pipefail
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
chmod +x .githooks/* tools/*.py tools/*.sh 2>/dev/null || true
echo "hooks installed: $(git config core.hooksPath)"
