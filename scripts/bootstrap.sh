#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/ishaan-ghosh/pi-dev-setup.git"
REPO_SLUG="ishaan-ghosh/pi-dev-setup"
REPO_TAG="v0.2.0"
REPO_VERSION="0.2.0"
TAG_SOURCE="git:https://github.com/ishaan-ghosh/pi-dev-setup@$REPO_TAG"
RAW_REPO_URL="https://raw.githubusercontent.com/ishaan-ghosh/pi-dev-setup"
PI_PACKAGE="@earendil-works/pi-coding-agent"
PI_VERSION="0.84.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$PI_DIR/settings.json"
STAMP="$(date +%Y%m%d%H%M%S)"
SETTINGS_BACKUP="$SETTINGS.backup.$STAMP"
LOCAL_READ_POLICY="$PI_DIR/extensions/read-policy.ts"
PACKAGE_CHECKOUT="$PI_DIR/git/github.com/ishaan-ghosh/pi-dev-setup"
QUARANTINE_ROOT="$PI_DIR/.bootstrap-quarantine"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is unavailable: $1" >&2
    exit 1
  fi
}

assert_no_symlink_components() {
  local candidate=$1
  local label=$2
  local component
  local current=/
  local path_to_check=$candidate
  local -a components=()

  if [[ "$path_to_check" != /* ]]; then
    path_to_check="$PWD/$path_to_check"
  fi
  IFS='/' read -r -a components <<< "${path_to_check#/}"
  for component in "${components[@]}"; do
    case "$component" in
      ""|.)
        continue
        ;;
      ..)
        if [[ "$current" != / ]]; then
          current=${current%/*}
          [[ -n "$current" ]] || current=/
        fi
        ;;
      *)
        current="${current%/}/$component"
        if [[ -L "$current" ]]; then
          echo "$label contains a symbolic-link component: $current" >&2
          return 1
        fi
        ;;
    esac
  done
}

origin_matches_repo() {
  local origin=$1
  case "$origin" in
    "https://github.com/$REPO_SLUG"|"https://github.com/$REPO_SLUG.git"|"git@github.com:$REPO_SLUG"|"git@github.com:$REPO_SLUG.git"|"ssh://git@github.com/$REPO_SLUG"|"ssh://git@github.com/$REPO_SLUG.git")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

preflight_release() {
  local refs
  local ref_sha
  local ref_name
  local tag_sha=
  local commit_sha=
  local package_json
  local settings_json

  if ! refs=$(git ls-remote --exit-code "$REPO_URL" "refs/tags/$REPO_TAG" "refs/tags/$REPO_TAG^{}" 2>/dev/null); then
    echo "Required Pi setup tag is not published: $REPO_URL $REPO_TAG" >&2
    return 1
  fi
  while read -r ref_sha ref_name; do
    case "$ref_name" in
      "refs/tags/$REPO_TAG") tag_sha=$ref_sha ;;
      "refs/tags/$REPO_TAG^{}") commit_sha=$ref_sha ;;
    esac
  done <<< "$refs"
  commit_sha=${commit_sha:-$tag_sha}
  if [[ ! "$commit_sha" =~ ^[0-9a-f]{40,64}$ ]]; then
    echo "Published Pi setup tag did not resolve to an exact commit: $REPO_TAG" >&2
    return 1
  fi
  if ! package_json=$(curl --fail --silent --show-error --location "$RAW_REPO_URL/$commit_sha/package.json"); then
    echo "Unable to read package.json from published Pi setup commit $commit_sha." >&2
    return 1
  fi
  if ! settings_json=$(curl --fail --silent --show-error --location "$RAW_REPO_URL/$commit_sha/settings.example.json"); then
    echo "Unable to read settings.example.json from published Pi setup commit $commit_sha." >&2
    return 1
  fi
  if ! node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    if (value.name !== "pi-dev-setup" || value.version !== process.argv[1] ||
        value.peerDependencies?.[process.argv[2]] !== process.argv[3]) process.exit(1);
  ' "$REPO_VERSION" "$PI_PACKAGE" "$PI_VERSION" <<< "$package_json"; then
    echo "Published Pi setup package.json does not match the pinned release contract." >&2
    return 1
  fi
  if ! node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const sources = (value.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry?.source);
    if (sources.filter((source) => source === process.argv[1]).length !== 1) process.exit(1);
  ' "$TAG_SOURCE" <<< "$settings_json"; then
	echo "Published Pi setup settings do not contain exactly one pinned package source." >&2
	return 1
  fi
  RELEASE_COMMIT=$commit_sha
  RELEASE_SOURCE="git:https://github.com/$REPO_SLUG@$RELEASE_COMMIT"
  if ! RELEASE_SETTINGS_JSON=$(node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    let replaced = 0;
    value.packages = (value.packages ?? []).map((entry) => {
      if (entry === process.argv[1]) {
        replaced += 1;
        return process.argv[2];
      }
      if (entry && typeof entry === "object" && entry.source === process.argv[1]) {
        replaced += 1;
        return { ...entry, source: process.argv[2] };
      }
      return entry;
    });
    if (replaced !== 1) process.exit(1);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  ' "$TAG_SOURCE" "$RELEASE_SOURCE" <<< "$settings_json"); then
    echo "Unable to persist the resolved Pi setup commit in release settings." >&2
    return 1
  fi
}

configured_sources() {
  [[ -f "$SETTINGS" ]] || return 0
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!value || typeof value !== "object" || (value.packages !== undefined && !Array.isArray(value.packages))) process.exit(1);
    for (const entry of value.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source === "string") console.log(source);
    }
  ' "$SETTINGS"
}

self_package_source() {
  local source=$1
  case "$source" in
    "git:https://github.com/$REPO_SLUG"|"git:https://github.com/$REPO_SLUG.git"|"git:https://github.com/$REPO_SLUG@"*|"git:https://github.com/$REPO_SLUG.git@"*|\
    "git:git@github.com:$REPO_SLUG"|"git:git@github.com:$REPO_SLUG.git"|"git:git@github.com:$REPO_SLUG@"*|"git:git@github.com:$REPO_SLUG.git@"*|\
    "git:ssh://git@github.com/$REPO_SLUG"|"git:ssh://git@github.com/$REPO_SLUG.git"|"git:ssh://git@github.com/$REPO_SLUG@"*|"git:ssh://git@github.com/$REPO_SLUG.git@"*|\
    "https://github.com/$REPO_SLUG"|"https://github.com/$REPO_SLUG.git"|"https://github.com/$REPO_SLUG@"*|"https://github.com/$REPO_SLUG.git@"*|\
    "http://github.com/$REPO_SLUG"|"http://github.com/$REPO_SLUG.git"|"http://github.com/$REPO_SLUG@"*|"http://github.com/$REPO_SLUG.git@"*|\
    "ssh://git@github.com/$REPO_SLUG"|"ssh://git@github.com/$REPO_SLUG.git"|"ssh://git@github.com/$REPO_SLUG@"*|"ssh://git@github.com/$REPO_SLUG.git@"*|\
    "git://github.com/$REPO_SLUG"|"git://github.com/$REPO_SLUG.git"|"git://github.com/$REPO_SLUG@"*|"git://github.com/$REPO_SLUG.git@"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

self_package_filters_match_release() {
  [[ -f "$SETTINGS" && -n "${RELEASE_SOURCE:-}" && -n "${RELEASE_SETTINGS_JSON:-}" ]] || return 1
  node -e '
    const fs = require("fs");
    const filterKeys = ["extensions", "skills", "prompts", "themes"];
    const sourceOf = (entry) => typeof entry === "string" ? entry : entry?.source;
    const filterContract = (entry) => {
      const contract = { autoload: true };
      if (typeof entry !== "string" && Object.hasOwn(entry, "autoload")) {
        if (typeof entry.autoload !== "boolean") throw new Error("invalid autoload filter");
        contract.autoload = entry.autoload;
      }
      for (const key of filterKeys) {
        if (typeof entry === "string" || !Object.hasOwn(entry, key)) {
          contract[key] = null;
          continue;
        }
        if (!Array.isArray(entry[key]) || !entry[key].every((value) => typeof value === "string")) {
          throw new Error(`invalid ${key} filter`);
        }
        contract[key] = entry[key];
      }
      return contract;
    };
    const configured = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const released = JSON.parse(fs.readFileSync(0, "utf8"));
    const source = process.argv[2];
    const configuredEntries = (configured.packages ?? []).filter((entry) => sourceOf(entry) === source);
    const releasedEntries = (released.packages ?? []).filter((entry) => sourceOf(entry) === source);
    if (configuredEntries.length !== 1 || releasedEntries.length !== 1) process.exit(1);
    try {
      if (JSON.stringify(filterContract(configuredEntries[0])) !== JSON.stringify(filterContract(releasedEntries[0]))) {
        process.exit(1);
      }
    } catch {
      process.exit(1);
    }
  ' "$SETTINGS" "$RELEASE_SOURCE" <<< "$RELEASE_SETTINGS_JSON"
}

checkout_matches_release() {
  [[ -n "${RELEASE_COMMIT:-}" && -d "$PACKAGE_CHECKOUT/.git" ]] || return 1
  origin_matches_repo "$(git -C "$PACKAGE_CHECKOUT" remote get-url origin 2>/dev/null)" || return 1
  [[ "$(git -C "$PACKAGE_CHECKOUT" rev-parse HEAD 2>/dev/null)" == "$RELEASE_COMMIT" ]] || return 1
  [[ "$(node -e '
    const fs = require("fs");
    process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version));
  ' "$PACKAGE_CHECKOUT/package.json" 2>/dev/null)" == "$REPO_VERSION" ]] || return 1
  git -C "$PACKAGE_CHECKOUT" diff --quiet --exit-code || return 1
  git -C "$PACKAGE_CHECKOUT" diff --cached --quiet --exit-code || return 1
  node "$ROOT/scripts/verify-installed-checkout.mjs" "$PACKAGE_CHECKOUT" "$RELEASE_COMMIT" || return 1
  [[ -z "$(git -C "$PACKAGE_CHECKOUT" status --porcelain --untracked-files=all -- . ':(exclude)package-lock.json')" ]]
}

settings_match_release() {
  local sources
  local source
  local exact_count=0
  local family_count=0
  if ! sources=$(configured_sources); then
    return 1
  fi
  while IFS= read -r source; do
    [[ -n "$source" ]] || continue
    if self_package_source "$source"; then
      ((family_count += 1))
      [[ "$source" == "$RELEASE_SOURCE" ]] && ((exact_count += 1))
    fi
  done <<< "$sources"
  (( family_count == 1 && exact_count == 1 )) && self_package_filters_match_release
}

verify_installed_state() {
  settings_match_release && checkout_matches_release
}

quarantine_new_checkout() {
  local quarantine_root
  local quarantine_path
  if [[ "${CHECKOUT_WAS_ABSENT:-0}" != "1" || ( ! -e "$PACKAGE_CHECKOUT" && ! -L "$PACKAGE_CHECKOUT" ) ]]; then
    return 0
  fi
  quarantine_root="$QUARANTINE_ROOT"
  assert_no_symlink_components "$quarantine_root" "Pi bootstrap quarantine path" || return 1
  quarantine_path="$quarantine_root/pi-dev-setup.$STAMP.$$"
  mkdir -p "$quarantine_root"
  if [[ -e "$quarantine_path" || -L "$quarantine_path" ]]; then
    echo "Refusing to overwrite an existing bootstrap quarantine path: $quarantine_path" >&2
    return 1
  fi
  if ! mv -- "$PACKAGE_CHECKOUT" "$quarantine_path"; then
    echo "Unable to quarantine the known-new partial checkout: $PACKAGE_CHECKOUT" >&2
    return 1
  fi
  echo "Quarantined the known-new partial checkout at $quarantine_path." >&2
}

claim_absent_checkout() {
  assert_no_symlink_components "$PACKAGE_CHECKOUT" "Pi setup checkout path" || return 1
  if [[ -e "$PACKAGE_CHECKOUT" || -L "$PACKAGE_CHECKOUT" ]]; then
    echo "Pi setup checkout appeared after preflight; refusing to install or quarantine it: $PACKAGE_CHECKOUT" >&2
    return 1
  fi
  CHECKOUT_WAS_ABSENT=1
}

rollback_install() {
  local action=$1
  local backup_path=${2:-}
  local rollback_failed=0
  case "$action" in
    install-new-settings)
      rm -f -- "$SETTINGS" || rollback_failed=1
      ;;
    install-existing-settings)
      cp -- "$backup_path" "$SETTINGS" || rollback_failed=1
      ;;
  esac
  quarantine_new_checkout || rollback_failed=1
  return "$rollback_failed"
}

inspect_local_state() {
  local sources
  local source
  local exact_count=0
  local family_count=0

  assert_no_symlink_components "$SETTINGS" "Pi settings path" || return 1
  assert_no_symlink_components "$PACKAGE_CHECKOUT" "Pi setup checkout path" || return 1
  assert_no_symlink_components "$LOCAL_READ_POLICY" "Pi local read-policy path" || return 1
  assert_no_symlink_components "$QUARANTINE_ROOT" "Pi bootstrap quarantine path" || return 1
  if [[ -e "$PI_DIR" && ! -d "$PI_DIR" ]]; then
    echo "Pi agent path exists but is not a directory: $PI_DIR" >&2
    return 1
  fi
  if [[ -L "$SETTINGS" || ( -e "$SETTINGS" && ! -f "$SETTINGS" ) ]]; then
    echo "Pi settings path is a symbolic link or non-file entry: $SETTINGS" >&2
    return 1
  fi
  if [[ -L "$PACKAGE_CHECKOUT" ]]; then
    echo "Pi setup checkout path is a symbolic link: $PACKAGE_CHECKOUT" >&2
    return 1
  fi
  if [[ -e "$LOCAL_READ_POLICY" || -L "$LOCAL_READ_POLICY" ]]; then
    echo "A duplicate local read-policy exists at $LOCAL_READ_POLICY." >&2
    echo "Explicitly preserve, rename, or remove it, then rerun this bootstrap." >&2
    return 1
  fi
  if [[ -f "$SETTINGS" ]]; then
    if ! sources=$(configured_sources); then
      echo "Existing Pi settings are invalid or contain a non-array packages field: $SETTINGS" >&2
      return 1
    fi
    while IFS= read -r source; do
      [[ -n "$source" ]] || continue
      if self_package_source "$source"; then
        ((family_count += 1))
        [[ "$source" == "$RELEASE_SOURCE" ]] && ((exact_count += 1))
      fi
    done <<< "$sources"
  fi

  if (( family_count != exact_count )); then
    echo "A conflicting or unpinned Pi setup source is configured in $SETTINGS." >&2
    echo "Remove that exact package explicitly, then rerun this bootstrap." >&2
    return 1
  fi
  if (( exact_count > 1 )); then
    echo "The pinned Pi setup source is configured more than once in $SETTINGS." >&2
    return 1
  fi
  if (( exact_count == 1 )); then
    if ! self_package_filters_match_release; then
      echo "The pinned Pi setup entry's autoload and extensions, skills, prompts, and themes filters do not match the reviewed release settings." >&2
      return 1
    fi
    if ! checkout_matches_release; then
      echo "The configured Pi setup checkout is missing, modified, or not at published commit $RELEASE_COMMIT: $PACKAGE_CHECKOUT" >&2
      return 1
    fi
    INSTALL_ACTION=keep
    return 0
  fi
  if [[ -e "$PACKAGE_CHECKOUT" ]]; then
    echo "An unconfigured Pi setup checkout blocks the pinned install: $PACKAGE_CHECKOUT" >&2
    echo "Preserve or remove it explicitly, then rerun this bootstrap." >&2
    return 1
  fi
  if [[ -f "$SETTINGS" ]]; then
	if [[ -e "$SETTINGS_BACKUP" || -L "$SETTINGS_BACKUP" ]]; then
	  echo "Refusing to overwrite an existing settings backup: $SETTINGS_BACKUP" >&2
	  return 1
	fi
	INSTALL_ACTION=install-existing-settings
  else
    INSTALL_ACTION=install-new-settings
  fi
}

require_command git
require_command curl
require_command node
require_command npm

preflight_failed=0
RELEASE_COMMIT=
RELEASE_SOURCE=
RELEASE_SETTINGS_JSON=
INSTALL_ACTION=blocked
CHECKOUT_WAS_ABSENT=0
preflight_release || preflight_failed=1
inspect_local_state || preflight_failed=1
if (( preflight_failed )); then
  echo "Bootstrap preflight failed; no global or user configuration changes were made." >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1 || [[ "$(pi --version 2>/dev/null)" != "$PI_VERSION" ]]; then
  echo "Installing supported Pi version $PI_VERSION..."
  npm install -g --ignore-scripts "$PI_PACKAGE@$PI_VERSION"
fi
if ! command -v pi >/dev/null 2>&1 || [[ "$(pi --version 2>/dev/null)" != "$PI_VERSION" ]]; then
  echo "Supported Pi version $PI_VERSION is still unavailable after installation." >&2
  exit 1
fi

mkdir -p "$PI_DIR"

case "$INSTALL_ACTION" in
  keep)
    echo "Pinned Pi setup is already installed at published commit $RELEASE_COMMIT."
    ;;
  install-new-settings)
	claim_absent_checkout || exit 1
	printf '%s\n' "$RELEASE_SETTINGS_JSON" > "$SETTINGS"
    chmod 600 "$SETTINGS" 2>/dev/null || true
    echo "Wrote $SETTINGS from the verified $REPO_TAG release settings"
	if ! pi install "$RELEASE_SOURCE" --no-approve || ! verify_installed_state; then
	  rollback_install "$INSTALL_ACTION" || echo "Bootstrap rollback was incomplete; inspect the reported paths." >&2
	  echo "Pi package installation or exact-commit verification failed; removed the newly created settings file." >&2
	  exit 1
	fi
	;;
  install-existing-settings)
	claim_absent_checkout || exit 1
	backup="$SETTINGS_BACKUP"
    cp "$SETTINGS" "$backup"
    echo "Existing settings found; backed up to $backup"
    echo "Installing this pi package into current settings instead of overwriting settings.json"
	if ! pi install "$RELEASE_SOURCE" --no-approve || ! verify_installed_state; then
	  rollback_install "$INSTALL_ACTION" "$backup" || echo "Bootstrap rollback was incomplete; inspect the reported paths." >&2
	  echo "Pi package installation or exact-commit verification failed; restored settings from $backup." >&2
	  exit 1
	fi
    ;;
esac

cat <<'MSG'

Next steps:
  1. Start pi and authenticate: /login
     Or configure API keys via environment variables / secret manager.
  2. If pi is already running, use /reload.
  3. This package is pinned. Upgrade by selecting and installing a reviewed tag.

MSG
