#!/bin/bash
# Installs the extension and the savewin command. It starts working at your next login.
#   ./install.sh            install or update
#   ./install.sh --remove   uninstall (saved layouts in ~/.local/state/savewinplacement stay)
set -eu
cd "$(dirname "$0")"
extensions=~/.local/share/gnome-shell/extensions
source=extension/savewinplacement@local
# GNOME installs what extensions.gnome.org offers for a user extension's UUID as an update, so a
# UUID anyone can read here could be taken over there. Each install makes up its own.
installed=$(find "$extensions" -maxdepth 1 -name 'savewinplacement-*@local' 2>/dev/null | head -1)
uuid=$(basename "${installed:-savewinplacement-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')@local}")
target=$extensions/$uuid

enabled() { gsettings get org.gnome.shell enabled-extensions; }
set_enabled() { gsettings set org.gnome.shell enabled-extensions "$1"; }

if [ "${1:-}" = --remove ]; then
    set_enabled "$(enabled | python3 -c "
import ast, sys
text = sys.stdin.read().replace('@as ', '')
print([e for e in ast.literal_eval(text) if e != '$uuid'])")"
    rm -rf "$target"
    rm -f ~/.local/bin/savewin
    echo "Removed. Log out and in to finish."
    exit
fi

mkdir -p "$target" ~/.local/bin
cp -r "$source/." "$target/"
sed -i "s/\"uuid\": \"[^\"]*\"/\"uuid\": \"$uuid\"/" "$target/metadata.json"
ln -sf "$PWD/bin/savewin" ~/.local/bin/savewin
set_enabled "$(enabled | python3 -c "
import ast, sys
current = ast.literal_eval(sys.stdin.read().replace('@as ', ''))
print(current if '$uuid' in current else current + ['$uuid'])")"
echo "Installed. On Wayland GNOME loads new extensions only at login: log out and back in once."
