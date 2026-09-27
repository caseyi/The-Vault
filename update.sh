#!/bin/sh
# update.sh - update (or roll back) The Vault on a Synology NAS / any Docker host
#
# Run it from anywhere; it works on the folder it lives in:
#
#   sudo sh update.sh                  # pull the build named by VAULT_TAG (default: latest)
#   sudo sh update.sh sha-1a2b3c4      # pin / roll back to that build (saved in .env)
#   sudo sh update.sh latest           # go back to tracking the newest build
#   sudo sh update.sh pre-update       # undo the last update (images kept locally)
#
# Options:
#   --skip-backup        don't take the pre-update database snapshot
#   --allow-new-volume   allow starting on a brand-new empty data volume even
#                        though other Vault data volumes exist (see below)
#   -h, --help           show this help
#
# What it does, in order:
#   1. Records which Docker volume the running backend keeps its data in.
#   2. Refuses to continue if this folder would start on a DIFFERENT volume
#      (renamed folder / different Compose project name = new empty database).
#   3. Snapshots the database into ./backups (keeps the newest 5 snapshots).
#   4. Pulls the images, restarts, waits until healthy.
#   5. Verifies the new backend mounts the SAME volume; if not, it stops the new
#      containers and brings the previous version back on the previous volume.
#   6. Prints the deployed version and removes old, unused Vault images.
#
# POSIX sh: works with Synology's /bin/sh, BusyBox ash, dash and bash.

set -eu

# ── Root ─────────────────────────────────────────────────────────────────────
# Docker on Synology needs root. Re-run ourselves through sudo if needed.
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo sh "$0" "$@"
  fi
  echo "✗ Please run as root:  sudo sh $0 $*" >&2
  exit 1
fi

cd "$(dirname "$0")"

# DSM keeps docker in /usr/local/bin, which is not always on root's PATH
# (e.g. when run from Task Scheduler).
PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
export PATH

# .env is the single source of truth for VAULT_TAG; don't let a stray shell
# variable override it.
unset VAULT_TAG 2>/dev/null || true

BACKEND_REPO="ghcr.io/caseyi/stlvault-backend"
FRONTEND_REPO="ghcr.io/caseyi/stlvault-frontend"
OCI_SOURCE="https://github.com/caseyi/The-Vault"
KEEP_SNAPSHOTS=5
BACKUP_HOST_DIR="./backups"
RESTORE_OVERRIDE="$BACKUP_HOST_DIR/.restore-previous.yml"

# ── Helpers ──────────────────────────────────────────────────────────────────
say()  { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

loud() {
  printf '\n' >&2
  printf '%s\n' "############################################################################" >&2
  for line in "$@"; do printf '#  %s\n' "$line" >&2; done
  printf '%s\n' "############################################################################" >&2
}

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

# ── Arguments ────────────────────────────────────────────────────────────────
TAG=""
SKIP_BACKUP=0
ALLOW_NEW_VOLUME=0
for arg in "$@"; do
  case "$arg" in
    -h|--help)          usage; exit 0 ;;
    --skip-backup)      SKIP_BACKUP=1 ;;
    --allow-new-volume) ALLOW_NEW_VOLUME=1 ;;
    rollback)
      die "'update.sh rollback' was replaced by tags.
  Undo the last update:        sudo sh update.sh pre-update
  Go to a specific build:      sudo sh update.sh sha-1a2b3c4
  (build tags are listed at https://github.com/caseyi/The-Vault/pkgs/container/stlvault-backend)" ;;
    -*) die "Unknown option: $arg (see: sh update.sh --help)" ;;
    *)
      [ -z "$TAG" ] || die "Only one tag may be given."
      case "$arg" in
        *[!A-Za-z0-9_.-]*|.*|-*) die "Invalid image tag: '$arg'" ;;
      esac
      TAG="$arg" ;;
  esac
done

# ── Compose command ──────────────────────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  die "Neither 'docker compose' nor 'docker-compose' was found. Is Container Manager installed?"
fi

[ -f docker-compose.yml ] || [ -f compose.yaml ] || [ -f compose.yml ] || [ -f docker-compose.yaml ] \
  || die "No docker-compose.yml in $(pwd). Put update.sh next to your docker-compose.yml."

# ── .env helpers ─────────────────────────────────────────────────────────────
env_get() {  # env_get KEY -> last value of KEY in .env (quotes/CR stripped)
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 \
    | tr -d '\r' | sed "s/^[\"']//; s/[\"']\$//"
}

env_set() {  # env_set KEY VALUE -> replace/append KEY=VALUE, keep file owner/mode
  tmp=".env.update.$$"
  if [ -f .env ]; then
    grep -v "^[[:space:]]*$1[[:space:]]*=" .env > "$tmp" || true
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  if [ -f .env ]; then cat "$tmp" > .env; else mv "$tmp" .env; chmod 600 .env; fi
  rm -f "$tmp"
}

WEB_PORT="$(env_get WEB_PORT)"
WEB_PORT="${WEB_PORT:-8484}"
PREV_TAG="$(env_get VAULT_TAG)"
PREV_TAG_WAS_SET=0
if [ -f .env ] && grep -q '^[[:space:]]*VAULT_TAG[[:space:]]*=' .env; then PREV_TAG_WAS_SET=1; fi

restore_tag_setting() {
  [ -n "$TAG" ] || return 0
  if [ "$PREV_TAG_WAS_SET" = "1" ]; then
    env_set VAULT_TAG "$PREV_TAG"
  elif [ -f .env ]; then
    tmp=".env.update.$$"
    grep -v '^[[:space:]]*VAULT_TAG[[:space:]]*=' .env > "$tmp" || true
    cat "$tmp" > .env
    rm -f "$tmp"
  fi
  say "  (restored the previous VAULT_TAG setting in .env)"
}

dc_ps_id() {  # dc_ps_id SERVICE -> container id (running or stopped), or nothing
  { dc ps -a -q "$1" 2>/dev/null || dc ps -q "$1" 2>/dev/null || true; } | head -n 1
}

container_volume() {  # container_volume ID -> name of the volume mounted at /data
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$1" 2>/dev/null || true
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

expected_volume() {
  # Volume name Compose WILL use for vault_data (Compose v2 prints it in
  # `config`; v1 does not, in which case this prints nothing).
  dc config 2>/dev/null | awk '
    /^[^ #]/            { top = $1 }
    top == "volumes:" && /^  vault_data:/ { inv = 1; next }
    top == "volumes:" && /^  [^ ]/        { inv = 0 }
    inv && /^    name:/ { v = $2; gsub(/["\047]/, "", v); print v; exit }'
}

http_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 "$1" 2>/dev/null
  else
    wget -q -T 5 -O - "$1" 2>/dev/null
  fi
}

json_field() {  # json_field NAME < json   (flat string/number fields only)
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -n 1
}

print_banner() {
  say ""
  say "═══ The Vault - $1 ═══"
}

# ── 0. Banner + tag setting ──────────────────────────────────────────────────
if [ -n "$TAG" ]; then print_banner "switch to '$TAG'"; else print_banner "update"; fi
say "  folder:  $(pwd)"
[ -f .env ] || warn "No .env file here - using the defaults from docker-compose.yml."

if [ -n "$TAG" ]; then
  env_set VAULT_TAG "$TAG"
  say "  VAULT_TAG=$TAG written to .env"
fi
EFFECTIVE_TAG="$(env_get VAULT_TAG)"
EFFECTIVE_TAG="${EFFECTIVE_TAG:-latest}"
say "  image tag: $EFFECTIVE_TAG"

# ── 1. Record what is running now ────────────────────────────────────────────
step "Checking the current installation..."
OLD_BACKEND_ID="$(dc_ps_id backend)"
OLD_FRONTEND_ID="$(dc_ps_id frontend)"
OLD_VOL=""
if [ -n "$OLD_BACKEND_ID" ]; then
  OLD_VOL="$(container_volume "$OLD_BACKEND_ID")"
  say "  current backend container: $(printf '%.12s' "$OLD_BACKEND_ID")"
  say "  current data volume:       ${OLD_VOL:-<none found!>}"
  [ -n "$OLD_VOL" ] || warn "The running backend has no named volume at /data. Continuing, but the volume check is disabled."
else
  say "  no Vault containers for this folder yet (first install, or they were removed)"
fi

EXPECTED_VOL="$(expected_volume || true)"
if [ -n "$EXPECTED_VOL" ]; then say "  this folder will use:      $EXPECTED_VOL"; fi

# Every existing Vault data volume on this machine (…_vault_data).
EXISTING_VOLS="$(docker volume ls -q 2>/dev/null | grep 'vault_data$' || true)"

# ── 2. Pre-flight volume safety check ────────────────────────────────────────
volume_trap_help() {
  say "  Existing Vault data volumes on this machine:"
  if [ -n "$EXISTING_VOLS" ]; then
    printf '%s\n' "$EXISTING_VOLS" | sed 's/^/      /'
  else
    say "      (none)"
  fi
  say ""
  say "  The volume name is <project>_vault_data, and the project name defaults to"
  say "  this folder's name. To keep using your existing data, either run update.sh"
  say "  from the ORIGINAL folder, or add this line to .env (use the prefix of the"
  say "  volume that holds your data):"
  say "      COMPOSE_PROJECT_NAME=<prefix>        e.g. the-vault for the-vault_vault_data"
  say "  If you really want a fresh, empty library: sudo sh update.sh --allow-new-volume"
}

if [ -n "$OLD_VOL" ] && [ -n "$EXPECTED_VOL" ] && [ "$OLD_VOL" != "$EXPECTED_VOL" ]; then
  loud "STOP: the new configuration would use a DIFFERENT data volume." \
       "running now: $OLD_VOL" "would use:   $EXPECTED_VOL" \
       "Nothing has been changed."
  volume_trap_help
  restore_tag_setting
  exit 1
fi

if [ -z "$OLD_BACKEND_ID" ] && [ -n "$EXISTING_VOLS" ] && [ "$ALLOW_NEW_VOLUME" != "1" ]; then
  if [ -n "$EXPECTED_VOL" ]; then
    if ! printf '%s\n' "$EXISTING_VOLS" | grep -qxF "$EXPECTED_VOL"; then
      loud "STOP: this folder would start on a NEW, EMPTY data volume ($EXPECTED_VOL)" \
           "but other Vault data volumes already exist. Nothing has been changed."
      volume_trap_help
      restore_tag_setting
      exit 1
    fi
  else
    warn "Could not determine the target volume name (old docker-compose v1)."
    warn "The volume will be checked after start-up instead."
  fi
fi

# ── 3. Pre-update database snapshot ──────────────────────────────────────────
mkdir -p "$BACKUP_HOST_DIR"

prune_snapshots() {
  n=0
  for f in "$BACKUP_HOST_DIR"/vault-pre-update-*.db; do
    if [ -e "$f" ]; then n=$((n + 1)); fi
  done
  extra=$((n - KEEP_SNAPSHOTS))
  [ "$extra" -gt 0 ] || return 0
  # Names embed YYYYMMDD-HHMMSS, so glob order == oldest first.
  for f in "$BACKUP_HOST_DIR"/vault-pre-update-*.db; do
    [ "$extra" -gt 0 ] || break
    rm -f "$f"
    say "  removed old snapshot $(basename "$f")"
    extra=$((extra - 1))
  done
}

SNAP_JS='const fs=require("fs"),path=require("path");let S;try{S=require("node:sqlite")}catch(e){console.error("node:sqlite unavailable: "+e.message);process.exit(3)}const dbp=process.env.DB_PATH||"/data/vault.db";if(!fs.existsSync(dbp)){console.log("NODB");process.exit(0)}const dir=process.env.BACKUP_DIR||path.join(path.dirname(dbp),"backups");fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,process.argv[1]);const db=new S.DatabaseSync(dbp);db.exec("VACUUM INTO \x27"+out.replace(/\x27/g,"\x27\x27")+"\x27");db.close();console.log(out)'

if [ "$SKIP_BACKUP" = "1" ]; then
  step "Skipping the database snapshot (--skip-backup)."
elif [ -z "$OLD_BACKEND_ID" ]; then
  step "No running backend - nothing to snapshot."
elif ! container_running "$OLD_BACKEND_ID"; then
  step "The backend container is stopped - skipping the snapshot."
  warn "Start it first (sudo docker compose up -d) if you want a snapshot before updating."
else
  step "Snapshotting the database..."
  SNAP_NAME="vault-pre-update-$(date +%Y%m%d-%H%M%S).db"
  SNAP_OUT=""
  # Node >= 22.13 has node:sqlite unflagged; older 22.x images need the flag.
  if SNAP_OUT="$(dc exec -T backend node --disable-warning=ExperimentalWarning -e "$SNAP_JS" "$SNAP_NAME" 2>&1)"; then :
  elif SNAP_OUT="$(dc exec -T backend node --experimental-sqlite --no-warnings -e "$SNAP_JS" "$SNAP_NAME" 2>&1)"; then :
  else
    loud "Could not snapshot the database, so the update was NOT started." \
         "Output: $SNAP_OUT" \
         "Re-run with --skip-backup to update anyway."
    restore_tag_setting
    exit 1
  fi
  SNAP_OUT="$(printf '%s\n' "$SNAP_OUT" | tail -n 1)"
  if [ "$SNAP_OUT" = "NODB" ]; then
    say "  no database yet - nothing to snapshot"
  elif [ -f "$BACKUP_HOST_DIR/$SNAP_NAME" ]; then
    say "  ✓ $BACKUP_HOST_DIR/$SNAP_NAME"
  else
    # Older containers have no ./backups mount: copy it out, then clean up.
    if docker cp "$OLD_BACKEND_ID:$SNAP_OUT" "$BACKUP_HOST_DIR/$SNAP_NAME" >/dev/null 2>&1; then
      dc exec -T backend rm -f "$SNAP_OUT" >/dev/null 2>&1 || true
      say "  ✓ $BACKUP_HOST_DIR/$SNAP_NAME"
    else
      loud "The snapshot was written inside the container ($SNAP_OUT) but could" \
           "not be copied to $BACKUP_HOST_DIR. The update was NOT started." \
           "Re-run with --skip-backup to update anyway."
      restore_tag_setting
      exit 1
    fi
  fi
  prune_snapshots
fi

# ── 4. Keep the current images as 'pre-update', pull, restart ────────────────
if [ "$EFFECTIVE_TAG" = "pre-update" ]; then
  step "Using the locally kept 'pre-update' images (no download)."
  if ! docker image inspect "$BACKEND_REPO:pre-update" >/dev/null 2>&1 \
     || ! docker image inspect "$FRONTEND_REPO:pre-update" >/dev/null 2>&1; then
    restore_tag_setting
    die "No 'pre-update' images on this machine. Use a build tag instead, e.g. sudo sh update.sh sha-1a2b3c4"
  fi
else
  HAVE_PREV_IMAGES=0
  if [ -n "$OLD_BACKEND_ID" ] && [ -n "$OLD_FRONTEND_ID" ]; then
    OLD_BACKEND_IMG="$(docker inspect -f '{{.Image}}' "$OLD_BACKEND_ID" 2>/dev/null || true)"
    OLD_FRONTEND_IMG="$(docker inspect -f '{{.Image}}' "$OLD_FRONTEND_ID" 2>/dev/null || true)"
    if [ -n "$OLD_BACKEND_IMG" ] && [ -n "$OLD_FRONTEND_IMG" ] \
       && docker tag "$OLD_BACKEND_IMG" "$BACKEND_REPO:pre-update" 2>/dev/null \
       && docker tag "$OLD_FRONTEND_IMG" "$FRONTEND_REPO:pre-update" 2>/dev/null; then
      HAVE_PREV_IMAGES=1
      say ""
      say "  current images kept as ':pre-update' (undo with: sudo sh update.sh pre-update)"
    fi
  fi

  step "Pulling images ($EFFECTIVE_TAG)..."
  if ! dc pull; then
    restore_tag_setting
    die "Pull failed (no internet, or no build called '$EFFECTIVE_TAG'). Nothing was restarted."
  fi
fi

step "Restarting containers..."
UP_OK=1
if dc up --help 2>/dev/null | grep -q -- '--wait'; then
  WAIT_TIMEOUT=""
  if dc up --help 2>/dev/null | grep -q -- '--wait-timeout'; then WAIT_TIMEOUT="--wait-timeout 300"; fi
  # shellcheck disable=SC2086 # WAIT_TIMEOUT is intentionally split
  dc up -d --remove-orphans --wait $WAIT_TIMEOUT || UP_OK=0
else
  dc up -d --remove-orphans || UP_OK=0
fi

# ── 5. Verify the data volume did not change ─────────────────────────────────
NEW_BACKEND_ID="$(dc_ps_id backend)"
NEW_VOL=""
if [ -n "$NEW_BACKEND_ID" ]; then NEW_VOL="$(container_volume "$NEW_BACKEND_ID")"; fi

VOLUME_BAD=""
if [ -n "$OLD_VOL" ] && [ "$NEW_VOL" != "$OLD_VOL" ]; then
  VOLUME_BAD="the new backend uses '${NEW_VOL:-<none>}' instead of '$OLD_VOL'"
elif [ -z "$OLD_BACKEND_ID" ] && [ -n "$EXISTING_VOLS" ] && [ -n "$NEW_VOL" ] \
     && [ "$ALLOW_NEW_VOLUME" != "1" ] \
     && ! printf '%s\n' "$EXISTING_VOLS" | grep -qxF "$NEW_VOL"; then
  VOLUME_BAD="the backend started on a NEW volume '$NEW_VOL' although other Vault data volumes exist"
fi

if [ -n "$VOLUME_BAD" ]; then
  loud "STOP: DATA VOLUME CHANGED - $VOLUME_BAD." \
       "Your data is untouched in the old volume. Stopping the new containers now."
  dc down --remove-orphans || true      # never -v: volumes are kept
  restore_tag_setting
  if [ -n "$OLD_VOL" ]; then
    step "Bringing the previous version back on '$OLD_VOL'..."
    {
      echo "# Written by update.sh after a volume mismatch; safe to delete."
      echo "volumes:"
      echo "  vault_data:"
      echo "    name: $OLD_VOL"
      echo "    external: true"
    } > "$RESTORE_OVERRIDE"
    set -- -f docker-compose.yml
    if [ -f docker-compose.override.yml ]; then set -- "$@" -f docker-compose.override.yml; fi
    set -- "$@" -f "$RESTORE_OVERRIDE"
    if [ "${HAVE_PREV_IMAGES:-0}" = "1" ]; then
      ( VAULT_TAG=pre-update; export VAULT_TAG; dc "$@" up -d --remove-orphans ) || true
    else
      dc "$@" up -d --remove-orphans || true
    fi
    RESTORED_ID="$(dc_ps_id backend)"
    if [ -n "$RESTORED_ID" ] && [ "$(container_volume "$RESTORED_ID")" = "$OLD_VOL" ]; then
      say "  ✓ previous version is running again on '$OLD_VOL'"
    else
      warn "Could not restart the previous version automatically."
    fi
  fi
  say ""
  volume_trap_help
  exit 1
fi

if [ "$UP_OK" != "1" ]; then
  say ""
  dc ps || true
  dc logs --tail 40 backend 2>/dev/null || true
  loud "The containers did not come up healthy (see the logs above)." \
       "Your data volume is unchanged (${NEW_VOL:-$OLD_VOL})." \
       "To go back to the previous version:  sudo sh update.sh pre-update"
  exit 1
fi

# ── 6. Report the deployed version ───────────────────────────────────────────
step "Checking health on port $WEB_PORT..."
HEALTH=""
i=0
while [ $i -lt 45 ]; do
  HEALTH="$(http_get "http://127.0.0.1:$WEB_PORT/api/health" || true)"
  case "$HEALTH" in *'"ok"'*) break ;; esac
  HEALTH=""
  i=$((i + 1))
  sleep 2
done
if [ -n "$HEALTH" ]; then
  VERSION="$(printf '%s' "$HEALTH" | json_field version)"
  GIT_SHA="$(printf '%s' "$HEALTH" | json_field gitSha)"
  BUILD_DATE="$(printf '%s' "$HEALTH" | json_field buildDate)"
  say "  ✓ healthy - version ${VERSION:-?}, commit ${GIT_SHA:-?}, built ${BUILD_DATE:-?}"
else
  warn "No answer from http://127.0.0.1:$WEB_PORT/api/health after 90s."
  warn "Check: sudo docker compose ps   and   sudo docker compose logs backend"
fi
if [ -n "$NEW_VOL" ]; then say "  data volume: $NEW_VOL"; fi

# ── 7. Remove old, unused Vault images ───────────────────────────────────────
step "Removing old Vault images..."
# Untagged images built by our CI (they carry our OCI source label). Only
# dangling images are pruned; ':pre-update' and the running images stay.
docker image prune -f --filter "label=org.opencontainers.image.source=$OCI_SOURCE" >/dev/null 2>&1 || true
# Older builds without the label show up as '<none>' under our repositories.
docker images --format '{{.Repository}} {{.Tag}} {{.ID}}' 2>/dev/null \
  | awk -v b="$BACKEND_REPO" -v f="$FRONTEND_REPO" '($1 == b || $1 == f) && $2 == "<none>" { print $3 }' \
  | while read -r id; do docker rmi "$id" >/dev/null 2>&1 || true; done
say "  done"

say ""
say "✓ The Vault is up:  http://<your-nas-ip>:$WEB_PORT"
say "  Snapshots: $(pwd)/backups    Undo: sudo sh update.sh pre-update"
if [ "$EFFECTIVE_TAG" != "latest" ]; then
  say "  Note: pinned to '$EFFECTIVE_TAG' (VAULT_TAG in .env). Plain updates stay on it;"
  say "        run  sudo sh update.sh latest  to follow new builds again."
fi
say ""
