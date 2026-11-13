#!/bin/sh
# Installs the Go trierarch (docs/trierarch.md, "A machine joins"):
#
#   curl -fsSL https://raw.githubusercontent.com/ThomasHendrickx/aeolus-fleet-trierarch/main/install.sh | sh -s -- init-flags...
#
# It takes the binary for this system and chip from the GitHub Release, checks
# it against the release's SHA256SUMS, and with gh against its GitHub artifact
# attestation, signed by the release workflow, puts it in ~/.local/bin and runs
# `aeolus-trierarch init` with the arguments it was given, after a marked
# block in the login files has put the folder on PATH for new terminals. A binary that fails
# a check is installed nowhere. Without gh the checksum alone is checked, the
# script says so and shows the command that verifies the attestation by hand.
#
# AEOLUS_TRIERARCH_VERSION   the version to install, else the latest release
# AEOLUS_TRIERARCH_BIN_DIR   the folder for the binary, else ~/.local/bin
set -eu

repository=ThomasHendrickx/aeolus-fleet-trierarch
api=${AEOLUS_TRIERARCH_RELEASES_URL:-https://api.github.com}
downloads=${AEOLUS_TRIERARCH_DOWNLOAD_URL:-https://github.com/$repository/releases/download}
bin_dir=${AEOLUS_TRIERARCH_BIN_DIR:-$HOME/.local/bin}
verify_args="--repo $repository --signer-workflow $repository/.github/workflows/release.yml"

fail() {
  echo "aeolus-trierarch install: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) system=linux ;;
  Darwin) system=darwin ;;
  *) fail "no binary for the system $(uname -s): there are builds for Linux and macOS" ;;
esac
case $(uname -m) in
  x86_64 | amd64) chip=amd64 ;;
  aarch64 | arm64) chip=arm64 ;;
  *) fail "no binary for the chip $(uname -m): there are builds for amd64 and arm64" ;;
esac
asset=aeolus-trierarch-$system-$chip

command -v curl > /dev/null 2>&1 || fail "curl is needed to download the binary"
if command -v sha256sum > /dev/null 2>&1; then
  digest_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum > /dev/null 2>&1; then
  digest_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is needed to check the binary's checksum"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

version=${AEOLUS_TRIERARCH_VERSION:-}
if [ -z "$version" ]; then
  curl -fsSL "$api/repos/$repository/releases/latest" -o "$work/latest.json" || fail "cannot read the latest release of $repository"
  version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$work/latest.json" | head -n 1)
  [ -n "$version" ] || fail "the latest release of $repository names no version"
fi
version=${version#v}

echo "Installing aeolus-trierarch $version for $system $chip"
curl -fsSL "$downloads/v$version/SHA256SUMS" -o "$work/SHA256SUMS" || fail "cannot download SHA256SUMS of v$version"
curl -fsSL "$downloads/v$version/$asset" -o "$work/$asset" || fail "cannot download $asset of v$version"

expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS" | head -n 1)
[ -n "$expected" ] || fail "SHA256SUMS of v$version does not name $asset"
[ "$(digest_of "$work/$asset")" = "$expected" ] || fail "the checksum of $asset is not the one SHA256SUMS names: not installed"

if command -v gh > /dev/null 2>&1; then
  gh attestation verify "$work/$asset" $verify_args > /dev/null || fail "the attestation of $asset does not hold: not installed"
  checked="its checksum and its attestation"
else
  checked="its checksum only"
fi

mkdir -p "$bin_dir"
chmod +x "$work/$asset"
# Moved from the same folder, so the file is replaced whole.
cp "$work/$asset" "$bin_dir/.aeolus-trierarch.$$"
mv -f "$bin_dir/.aeolus-trierarch.$$" "$bin_dir/aeolus-trierarch"
echo "Installed $bin_dir/aeolus-trierarch, having checked $checked"
if [ "$checked" = "its checksum only" ]; then
  echo "gh is not installed, so the attestation was not checked. To check it by hand (https://cli.github.com):" >&2
  echo "  gh attestation verify $bin_dir/aeolus-trierarch $verify_args" >&2
fi

# A marked block puts the folder on PATH in every new login shell: in the login
# file of the person's $SHELL and in ~/.profile. A folder PATH holds already
# gets none, and a block already there is left as it is.
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    case $bin_dir in
      "$HOME"/*) folder="\$HOME/${bin_dir#"$HOME"/}" ;;
      *) folder=$bin_dir ;;
    esac
    add_block() {
      login_file=$1
      if [ -f "$login_file" ] && grep -q '^# >>> aeolus-trierarch >>>$' "$login_file"; then
        return
      fi
      {
        # A blank line first ends a last line that has no newline, so the marker starts its own line.
        if [ -s "$login_file" ]; then echo; fi
        echo '# >>> aeolus-trierarch >>>'
        echo "case \":\$PATH:\" in *\":$folder:\"*) ;; *) export PATH=\"$folder:\$PATH\" ;; esac"
        echo '# <<< aeolus-trierarch <<<'
      } >> "$login_file"
      echo "Added $bin_dir to PATH in $login_file: open a new terminal to use aeolus-trierarch there"
    }
    case ${SHELL:-} in
      */zsh) add_block "$HOME/.zprofile" ;;
      */bash) add_block "$HOME/.bash_profile" ;;
    esac
    add_block "$HOME/.profile"
    ;;
esac

"$bin_dir/aeolus-trierarch" init "$@"
