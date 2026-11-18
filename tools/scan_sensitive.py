#!/usr/bin/env python3
"""Scan a tree for secret-like and personal-data-like content. Prints path, rule and
count only (never the matched text). Usage: scan_secrets.py ROOT [--max-bytes N]"""
import os, re, sys, pwd, socket
from collections import Counter
from pathlib import Path

SECRET_RULES = [
    ("private_key_block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("github_token", r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    ("openai_anthropic_key", r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b"),
    ("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    ("aws_key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("bearer_header", r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{16,}"),
    ("assignment_secret", r"(?i)\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"),
    ("tailscale_authkey", r"\btskey-[A-Za-z0-9-]{10,}\b"),
]
PERSONAL_RULES = [
    ("email", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    ("tailscale_ipv4", r"(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])"),
    ("ssh_user_at_host", r"\b[a-z_][a-z0-9_-]{2,}@(?:\d{1,3}\.){3}\d{1,3}\b"),
    ("abs_home_path", r"/home/[A-Za-z0-9_.-]+/"),
]

def identity_rules():
    toks = set()
    for k in ("USER", "LOGNAME"):
        if os.environ.get(k): toks.add(os.environ[k])
    try:
        pw = pwd.getpwuid(os.getuid()); toks.add(pw.pw_name)
        g = pw.pw_gecos.split(",")[0].strip()
        if g: toks.update(g.split())
    except KeyError: pass
    toks.add(socket.gethostname())
    out = []
    for t in sorted(toks):
        for part in re.split(r"[-_.\s@]+", t):
            if len(part) >= 4 and part.lower() not in {"ubuntu", "linux", "desktop"}:
                out.append(("identity_token", re.escape(part)))
    return out

def main():
    root = Path(sys.argv[1]); maxb = 8 * 1024 * 1024
    rules = [(n, re.compile(p.encode()), "secret") for n, p in SECRET_RULES]
    rules += [(n, re.compile(p.encode()), "personal") for n, p in PERSONAL_RULES]
    rules += [(n, re.compile(p.encode(), re.I), "personal") for n, p in identity_rules()]
    name_rx = re.compile(r"(^\.env|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa)|token|secret|credential)", re.I)
    hits = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in (".git", "node_modules", ".next")]
        for fn in fns:
            p = Path(dp) / fn; rel = p.relative_to(root).as_posix()
            if name_rx.search(fn): hits.append((rel, "secret", "suspicious_filename", 1))
            try:
                if p.is_symlink() or p.stat().st_size > maxb: continue
                data = p.read_bytes()
            except OSError: continue
            if b"\x00" in data[:4096]: continue
            c = Counter()
            for n, rx, kind in rules:
                k = len(rx.findall(data))
                if k: c[(kind, n)] += k
            for (kind, n), k in sorted(c.items()): hits.append((rel, kind, n, k))
    for h in hits: print("\t".join(map(str, h)))

if __name__ == "__main__": main()
