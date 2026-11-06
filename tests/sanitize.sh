#!/bin/bash
# tests/sanitize.sh: the repository is public; fails on anything private in tracked files or
# commit authors. Your own private words (hostnames, project or person names), one per line,
# go in ~/.claude/toolkit-private-words: a local file, never committed.
set -u
cd "$(dirname "$0")/.."
fail=0
hit() { echo "FAIL  sanitize: $1"; fail=1; }
files=$(git ls-files)
scan() {  # scan LABEL REGEX: grep -E -i over tracked files, skipping this script
    local out; out=$(grep -nEi -- "$2" $files 2>/dev/null | grep -v '^tests/sanitize\.sh:')
    [ -z "$out" ] || hit "$1: $out"
}
scan "email address" '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
scan "IPv4 address" '\b(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}\b'
scan "home path" '/home/[a-z]|/Users/[a-z]|C:\\Users\\'
scan "private key" '-----BEGIN [A-Z ]*PRIVATE KEY'
scan "token" 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-|AIza[0-9A-Za-z_-]{30,}'
if [ -f ~/.claude/toolkit-private-words ]; then
    while read -r word; do
        [ -n "$word" ] && scan "private word" "\\b$word\\b"
    done < ~/.claude/toolkit-private-words
fi
bad_authors=$(git log --format='%ae%n%ce' | sort -u | grep -v '@users\.noreply\.github\.com$' || true)
[ -z "$bad_authors" ] || hit "commit emails that aren't GitHub noreply: $bad_authors"
[ $fail = 0 ] && echo "ok    sanitize"
exit $fail
