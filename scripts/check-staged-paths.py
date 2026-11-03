#!/usr/bin/env python3
"""Reject staged files matching Git ignore rules anywhere in the repository."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        cwd=ROOT, check=True, capture_output=True,
    ).stdout
    paths = [path for path in staged.split(b"\0") if path]
    if not paths:
        return
    result = subprocess.run(
        ["git", "check-ignore", "--no-index", "--stdin", "-z"],
        cwd=ROOT, input=b"\0".join(paths) + b"\0", capture_output=True,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not verify Git ignore rules")
    ignored = [path for path in result.stdout.split(b"\0") if path]
    if ignored:
        print("Refusing to commit ignored files:", file=sys.stderr)
        for path in ignored:
            print("  " + path.decode("utf-8", "backslashreplace"), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"Pi path check failed: {error}", file=sys.stderr)
        raise SystemExit(1)
