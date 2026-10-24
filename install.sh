#!/bin/sh
# Install or update Perch with one line in Terminal:
#
#     curl -fsSL https://raw.githubusercontent.com/mossfinch/perch/main/install.sh | sh
#
# Run it again later to update: it replaces the Perch in Applications with this release.
#
# What it does, and nothing else: downloads the release named below from GitHub, checks its
# checksum against the one written here, puts Perch in /Applications and opens it. It never
# asks for an administrator password, never changes a macOS security setting, and never
# touches Claude Code's or codex's settings; you connect them yourself with Connect on the card.
#
# Why this skips the "cannot verify" warning a browser download gets: macOS marks what a
# browser downloads, and Perch is not notarized, so a marked copy has to be allowed by hand
# and may first run from a temporary copy that cannot connect. A file curl downloads carries
# no mark. The checksum makes sure what arrived is this exact release; it cannot help if the
# GitHub account that publishes both this script and the release is itself taken over.
set -eu

version=2.9
checksum=8e30792514d3e523b23d5a92fb4123d1420f2990d601033bf60bbac0fc446e2a
url="https://github.com/mossfinch/perch/releases/download/v$version/Perch-$version.zip"
app=/Applications/Perch.app
id=io.github.mossfinch.perch

say() { printf 'perch: %s\n' "$*"; }
fail() { printf 'perch: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Perch runs on macOS only."
os=$(sw_vers -productVersion)
[ "${os%%.*}" -ge 15 ] || fail "Perch needs macOS 15 or later; this Mac has $os."

# Something else at that path stays where it is.
if [ -e "$app" ]; then
    found=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)
    [ "$found" = "$id" ] || fail "$app is a different app (${found:-unknown}); leaving it alone."
fi
[ -w /Applications ] || fail "This account cannot write to /Applications."
# Another account's copy in the shared Applications folder is theirs to update: this account
# could move it aside but not remove what is inside it, and would stop halfway.
me=$(id -u)
if [ -e "$app" ] && [ "$(stat -f %u "$app")" != "$me" ]; then
    fail "The Perch in /Applications was installed by another account on this Mac; update it from that account."
fi

# A Perch built from source has a launchd job that restarts it the moment it quits, so it
# would come back halfway through the swap. It updates the way it was installed.
[ ! -e "$HOME/Library/LaunchAgents/$id.plist" ] ||
    fail "This Perch was built from source; update it with install-island-app.py from its checkout."

# The app is shared by every account on this Mac, and this script can only quit this
# account's Perch: with another account's running, the bundle would vanish under it.
all=$(pgrep -x Perch 2>/dev/null | wc -l | tr -d ' ')
mine=$(pgrep -x -U "$me" Perch 2>/dev/null | wc -l | tr -d ' ')
[ "$all" = "$mine" ] || fail "Perch is running in another account on this Mac; quit it there first."

work=$(mktemp -d)
staged="/Applications/.Perch-install-$$.app"
# The old copy waits here, outside what the cleanup removes, until the new one is in place.
old="/Applications/.Perch-previous-$$.app"
trap 'rm -rf "$work" "$staged"' EXIT

say "Downloading Perch $version"
curl -fsSL -o "$work/Perch.zip" "$url" || fail "Download failed: $url"
got=$(shasum -a 256 "$work/Perch.zip" | cut -d ' ' -f 1)
[ "$got" = "$checksum" ] || fail "The download does not match this release (expected $checksum, got $got). Nothing was installed."

ditto -x -k "$work/Perch.zip" "$work/unzipped"
[ -d "$work/unzipped/Perch.app" ] || fail "The download holds no Perch.app. Nothing was installed."
codesign --verify --deep --strict "$work/unzipped/Perch.app" || fail "Perch's signature does not verify. Nothing was installed."

# The new copy goes in beside the old one first, so a failure halfway leaves the old one working.
ditto "$work/unzipped/Perch.app" "$staged"
if pgrep -x -U "$me" Perch >/dev/null 2>&1; then
    say "Quitting the Perch that is running"
    pkill -x -U "$me" Perch 2>/dev/null || true
    tries=0
    while pgrep -x -U "$me" Perch >/dev/null 2>&1; do
        tries=$((tries + 1))
        [ "$tries" -le 10 ] || fail "Perch did not quit; quit it from its menu and run this again. Nothing was changed."
        sleep 0.5
    done
fi
if [ -e "$app" ]; then mv "$app" "$old"; fi
if ! mv "$staged" "$app"; then
    [ -e "$old" ] || fail "Could not put Perch in /Applications. Nothing else was changed."
    mv "$old" "$app" 2>/dev/null ||
        fail "Could not put the new Perch in place, nor the previous one back. The previous one is at $old; move it back to $app."
    fail "Could not put the new Perch in place; the previous one is back where it was."
fi
rm -rf "$old"

say "Installed Perch $version in /Applications"
open "$app"
say "Perch is in your notch. Press Connect on its card to hook up Claude Code and codex."
