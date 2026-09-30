#!/usr/bin/env bash
# Build the current CLI tag, run the three-runtime comparison on a Linux host,
# and export validated raw data plus a generated summary for this tag.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
host="${1:-}"
if [ -z "$host" ]; then
  echo "usage: $0 user@linux-host" >&2
  exit 2
fi

prepared="$(cd "$repo" && bun "$here/prepare.ts")"
payload="${prepared##*Prepared Linux payload: }"
if [ ! -f "$payload/payload.json" ]; then
  echo "Payload preparation did not produce payload.json" >&2
  exit 1
fi
name="$(basename "$payload")"
remote_root=".local/share/sproutboat-bench"
remote_dir="$remote_root/$name"

ssh "$host" "mkdir -p ~/$remote_root"
scp -rq "$payload" "$host:~/$remote_root/"
ssh "$host" "cd ~/$remote_dir && taskset -c 1 python3 measure.py"
scp -q "$host:~/$remote_dir/results.json" "$payload/results.json"
python3 "$here/report.py" "$payload/results.json" --export "$here/../benchmarks"
printf '\nTagged comparison retained in %s\n' "$payload"
