#!/usr/bin/env bash
# Runs one shell command on a GX10 through a Paseo terminal (the user-authorized channel; mac-mini cannot ssh there).
#   remote.sh <host:port> <terminal-id> '<command>' [timeout-seconds]
# The command's output goes to a file on the remote side; this prints it once a done marker shows up.
set -euo pipefail
host=$1; term=$2; cmd=$3; limit=${4:-300}
tag="APMDONE$RANDOM$RANDOM"
log="\$HOME/.cache/agentpm-deploy/$tag.log"
wrapped="mkdir -p ~/.cache/agentpm-deploy; ( $cmd ) > $log 2>&1; echo \"$tag rc=\$?\"; cat $log | tail -c 6000; echo ${tag}END"
paseo terminal send-keys --host "$host" -l "$term" "clear" >/dev/null
paseo terminal send-keys --host "$host" "$term" Enter >/dev/null
paseo terminal send-keys --host "$host" -l "$term" "$wrapped" >/dev/null
paseo terminal send-keys --host "$host" "$term" Enter >/dev/null
start=$(date +%s)
while :; do
  out=$(paseo terminal capture --host "$host" "$term" -S 2>/dev/null || true)
  if printf '%s' "$out" | grep -q "^${tag}END"; then
    printf '%s\n' "$out" | awk -v t="$tag" '$0 ~ "^"t" rc=" {p=1} p {print} $0 ~ "^"t"END" {exit}' | grep -v "^${tag}END"
    exit 0
  fi
  if [ $(( $(date +%s) - start )) -gt "$limit" ]; then echo "remote.sh: timed out after ${limit}s"; printf '%s\n' "$out" | tail -20; exit 1; fi
  sleep 2
done
