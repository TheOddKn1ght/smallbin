#!/usr/bin/env bash
# Interactive native Linux deployment, or configuration-only preparation anywhere.

usage() {
  cat <<'EOF'
Usage: bash scripts/setup.sh [--prepare-only] [--help]

Default: build and start Smallbin with Docker Compose, then configure host nginx
and an HTTPS certificate on Debian/Ubuntu with systemd. Existing data is retained.

--prepare-only  Write .env and rendered nginx configs without Docker, network,
                package installation, or host service changes (also works on macOS).
--help          Show this help.

Configuration is reviewed and confirmed before any files are replaced. Existing
files receive timestamped backups. Full deployment may request sudo privileges.
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; return 1; }
trim() { local value=$1; value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"; printf '%s' "$value"; }

# Read literal values only; never execute .env or operating-system metadata.
read_env_value() {
  local file=$1 wanted=$2 line key value result=''
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    key=$(trim "${line%%=*}")
    [[ "$key" == "$wanted" ]] || continue
    value=$(trim "${line#*=}")
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
      *) value=${value%% \#*} ;;
    esac
    result=$value
  done < "$file"
  printf '%s' "$result"
}

initialize_paths() {
  REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  ENV_FILE="$REPO_DIR/.env"
  COMPOSE_FILE="$REPO_DIR/compose.yaml"
  GENERATED_DIR="$REPO_DIR/deploy/generated"
  HTTP_CONFIG="$GENERATED_DIR/nginx-http.conf"
  HTTPS_CONFIG="$GENERATED_DIR/nginx-https.conf"
  NGINX_SITE=/etc/nginx/conf.d/smallbin.conf
  RUN_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP_COUNTER=0
  APP_STARTED=false
  STAGE='configuration review'
}

valid_domain() {
  local domain=$1 label rest
  [[ ${#domain} -le 253 && "$domain" == *.* && "$domain" != *..* ]] || return 1
  [[ "$domain" =~ ^[a-zA-Z0-9.-]+$ ]] || return 1
  [[ ! "$domain" =~ ^[0-9.]+$ ]] || return 1
  rest=$domain
  while [[ -n "$rest" ]]; do
    label=${rest%%.*}
    [[ -n "$label" && ${#label} -le 63 && "$label" != -* && "$label" != *- ]] || return 1
    [[ "$rest" == *.* ]] || break
    rest=${rest#*.}
    [[ -n "$rest" ]] || return 1
  done
}

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 )); }
valid_ipv4() {
  local address=$1 part rest=$1 count=0
  [[ "$address" =~ ^[0-9.]+$ ]] || return 1
  while :; do
    part=${rest%%.*}; count=$((count + 1))
    [[ "$part" =~ ^[0-9]{1,3}$ ]] && (( 10#$part <= 255 )) || return 1
    [[ "$rest" == *.* ]] || break
    rest=${rest#*.}
  done
  [[ "$count" == 4 ]]
}

storage_bytes() {
  local value=$1 whole fraction
  [[ "$value" =~ ^[0-9]{1,6}(\.[0-9]{1,9})?$ ]] || return 1
  whole=${value%%.*}; fraction=''
  [[ "$value" != *.* ]] || fraction=${value#*.}
  fraction="${fraction}000000000"; fraction=${fraction:0:9}
  local bytes=$((10#$whole * 1000000000 + 10#$fraction))
  (( bytes >= 101016421 && bytes <= 999999999999999 )) || return 1
  printf '%s' "$bytes"
}

prompt() {
  local label=$1 default=$2 answer
  if [[ -n "$default" ]]; then printf '%s [%s]: ' "$label" "$default" >&2; else printf '%s: ' "$label" >&2; fi
  if ! IFS= read -r answer; then fail 'Input ended; setup cancelled.'; return 1; fi
  answer=$(trim "$answer")
  printf '%s' "${answer:-$default}"
}

confirm() {
  local answer
  printf '%s [y/N]: ' "$1" >&2
  if ! IFS= read -r answer; then fail 'Input ended; setup cancelled.'; return 1; fi
  case "$answer" in y|Y|yes|YES) return 0 ;; *) fail 'Setup cancelled.'; return 1 ;; esac
}

prepare_inputs() {
  local existing_origin default_domain existing_bytes default_storage answer
  existing_origin=$(read_env_value "$ENV_FILE" PUBLIC_ORIGIN)
  default_domain=${existing_origin#https://}; default_domain=${default_domain%/}
  valid_domain "$default_domain" || default_domain=''
  HOST_PORT=$(read_env_value "$ENV_FILE" PORT); HOST_PORT=${HOST_PORT:-3210}
  valid_port "$HOST_PORT" || HOST_PORT=3210
  existing_bytes=$(read_env_value "$ENV_FILE" MAX_STORAGE_BYTES)
  default_storage=10
  if [[ "$existing_bytes" =~ ^[0-9]{1,15}$ ]] && (( 10#$existing_bytes > 0 )); then
    printf -v default_storage '%d.%09d' "$((10#$existing_bytes / 1000000000))" "$((10#$existing_bytes % 1000000000))"
    while [[ "$default_storage" == *0 ]]; do default_storage=${default_storage%0}; done
    default_storage=${default_storage%.}
  fi
  while :; do DOMAIN=$(prompt 'Domain (for example bin.example.com)' "$default_domain") || return 1; valid_domain "$DOMAIN" && break; printf 'Enter a full domain without a URL, path, wildcard, or port.\n' >&2; done
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  while :; do answer=$(prompt 'Loopback host port' "$HOST_PORT") || return 1; valid_port "$answer" && { HOST_PORT=$((10#$answer)); break; }; printf 'Choose a port from 1024 to 65535.\n' >&2; done
  while :; do STORAGE_GB=$(prompt 'Encrypted storage quota in GB (decimal)' "$default_storage") || return 1; MAX_STORAGE_BYTES=$(storage_bytes "$STORAGE_GB") && break; printf 'Choose 0.101016421 to 999999.999999999 GB (up to 9 decimals).\n' >&2; done
  TRUSTED_PROXIES=$(read_env_value "$ENV_FILE" TRUSTED_PROXIES)
  DATA_DIR=$(read_env_value "$ENV_FILE" DATA_DIR); DATA_DIR=${DATA_DIR:-./data}
  UPLOAD_TIMEOUT_MS=$(read_env_value "$ENV_FILE" UPLOAD_TIMEOUT_MS); UPLOAD_TIMEOUT_MS=${UPLOAD_TIMEOUT_MS:-120000}
  DOWNLOAD_TIMEOUT_MS=$(read_env_value "$ENV_FILE" DOWNLOAD_TIMEOUT_MS); DOWNLOAD_TIMEOUT_MS=${DOWNLOAD_TIMEOUT_MS:-120000}
  SMALLBIN_IMAGE=$(read_env_value "$ENV_FILE" SMALLBIN_IMAGE); SMALLBIN_IMAGE=${SMALLBIN_IMAGE:-smallbin:local}
  if [[ "$PREPARE_ONLY" == false ]]; then
    SMALLBIN_IMAGE="smallbin:setup-$(printf '%s' "$RUN_STAMP" | tr '[:upper:]' '[:lower:]')-$$"
  fi
  for answer in "$UPLOAD_TIMEOUT_MS" "$DOWNLOAD_TIMEOUT_MS"; do
    if [[ ! "$answer" =~ ^[0-9]{1,15}$ ]] || (( 10#$answer <= 0 )); then
      fail 'Existing transfer timeouts must be positive integers.'; return 1
    fi
  done
  printf '\nDomain:       https://%s\nHost port:    127.0.0.1:%s\nStorage:      %s GB (%s bytes)\nImage:        %s\nMode:         %s\nFiles:        %s, %s, %s\n\n' "$DOMAIN" "$HOST_PORT" "$STORAGE_GB" "$MAX_STORAGE_BYTES" "$SMALLBIN_IMAGE" "$([[ "$PREPARE_ONLY" == true ]] && printf 'prepare only' || printf 'full deployment')" "$ENV_FILE" "$HTTP_CONFIG" "$HTTPS_CONFIG"
  confirm 'Write this configuration?' || return 1
  if [[ -e "$ENV_FILE" || -e "$HTTP_CONFIG" || -e "$HTTPS_CONFIG" || ( "$PREPARE_ONLY" == false && -e "$NGINX_SITE" ) ]]; then
    confirm 'Existing configuration found. Replace it and keep timestamped backups?' || return 1
  fi
}

backup_file() {
  local file=$1
  [[ -e "$file" ]] || return 0
  BACKUP_COUNTER=$((BACKUP_COUNTER + 1))
  cp -p "$file" "$file.bak.$RUN_STAMP.$$.$BACKUP_COUNTER"
  [[ "$file" != "$ENV_FILE" ]] || chmod 600 "$file.bak.$RUN_STAMP.$$.$BACKUP_COUNTER"
}

emit_env() {
  local value=$2
  value=${value//\'/\\\'}
  printf "%s='%s'\n" "$1" "$value"
}

write_env() {
  local temporary
  backup_file "$ENV_FILE"
  temporary=$(mktemp "$REPO_DIR/.env.tmp.XXXXXX")
  {
    printf '# Generated by scripts/setup.sh; values are literal, not shell commands.\n'
    emit_env PUBLIC_ORIGIN "https://$DOMAIN"
    emit_env PORT "$HOST_PORT"
    emit_env SMALLBIN_IMAGE "$SMALLBIN_IMAGE"
    emit_env TRUSTED_PROXIES "$TRUSTED_PROXIES"
    emit_env DATA_DIR "$DATA_DIR"
    emit_env MAX_STORAGE_BYTES "$MAX_STORAGE_BYTES"
    emit_env UPLOAD_TIMEOUT_MS "$UPLOAD_TIMEOUT_MS"
    emit_env DOWNLOAD_TIMEOUT_MS "$DOWNLOAD_TIMEOUT_MS"
  } > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

render_nginx() {
  local source=$1 destination=$2 temporary
  backup_file "$destination"
  temporary=$(mktemp "$GENERATED_DIR/.nginx.tmp.XXXXXX")
  # Both replacements contain only validated DNS characters or decimal digits.
  sed -e "s/bin\.example\.com/$DOMAIN/g" -e "s/127\.0\.0\.1:3210/127.0.0.1:$HOST_PORT/g" "$source" > "$temporary"
  chmod 644 "$temporary"
  mv "$temporary" "$destination"
}

write_configuration() {
  mkdir -p "$GENERATED_DIR"
  write_env
  render_nginx "$REPO_DIR/deploy/nginx-http.conf.template" "$HTTP_CONFIG"
  render_nginx "$REPO_DIR/deploy/nginx.conf.template" "$HTTPS_CONFIG"
}

run_root() { if [[ $(id -u) == 0 ]]; then "$@"; else sudo "$@"; fi; }
run_docker() {
  run_root env -u PUBLIC_ORIGIN -u PORT -u SMALLBIN_IMAGE -u TRUSTED_PROXIES -u DATA_DIR -u MAX_STORAGE_BYTES \
    -u UPLOAD_TIMEOUT_MS -u DOWNLOAD_TIMEOUT_MS -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES \
    -u COMPOSE_PROFILES -u DOCKER_HOST -u DOCKER_CONTEXT docker --context default "$@"
}
run_compose() { run_docker compose --project-name smallbin --env-file "$ENV_FILE" --file "$COMPOSE_FILE" "$@"; }

check_host() {
  case "${DOCKER_HOST:-}" in ''|unix:///var/run/docker.sock) ;; *) fail 'Unset DOCKER_HOST: full setup requires the native local Docker daemon.'; return 1 ;; esac
  case "${DOCKER_CONTEXT:-}" in ''|default) ;; *) fail 'Unset DOCKER_CONTEXT: full setup uses the native default Docker context.'; return 1 ;; esac
  [[ $(uname -s) == Linux ]] || { fail 'Full deployment requires Debian/Ubuntu Linux; use --prepare-only on this host.'; return 1; }
  OS_ID=$(read_env_value /etc/os-release ID)
  OS_CODENAME=$(read_env_value /etc/os-release VERSION_CODENAME)
  case "$OS_ID" in debian|ubuntu) ;; *) fail 'Only native Debian and Ubuntu are supported for full deployment.'; return 1 ;; esac
  [[ "$OS_CODENAME" =~ ^[a-zA-Z0-9._-]+$ ]] || { fail 'Cannot determine a valid distribution codename.'; return 1; }
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || { fail 'Full deployment requires systemd as the host service manager.'; return 1; }
  [[ $(id -u) == 0 ]] || command -v sudo >/dev/null || { fail 'Run as root or install sudo first.'; return 1; }
}

install_prerequisites() {
  local missing=false command_name docker_missing=false temporary architecture
  for command_name in docker nginx certbot curl; do command -v "$command_name" >/dev/null || missing=true; done
  if ! command -v docker >/dev/null || ! run_docker compose version >/dev/null 2>&1; then missing=true; docker_missing=true; fi
  [[ "$missing" == true ]] || return 0
  confirm 'Install missing prerequisites using the distribution repositories and Docker official apt repository?' || return 1
  run_root apt-get update
  run_root apt-get install -y --no-remove ca-certificates curl nginx certbot
  if [[ "$docker_missing" == true ]]; then
    architecture=$(dpkg --print-architecture)
    [[ "$architecture" =~ ^[a-z0-9]+$ ]] || { fail 'Invalid package architecture.'; return 1; }
    run_root install -d -m 755 /etc/apt/keyrings
    run_root curl --fail --show-error --silent --location "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
    run_root chmod a+r /etc/apt/keyrings/docker.asc
    temporary=$(mktemp)
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$OS_ID" "$OS_CODENAME" "$architecture" > "$temporary"
    if run_root test -e /etc/apt/sources.list.d/docker.sources; then run_root cp -p /etc/apt/sources.list.d/docker.sources "/etc/apt/sources.list.d/docker.sources.bak.$RUN_STAMP.$$"; fi
    run_root install -m 644 "$temporary" /etc/apt/sources.list.d/docker.sources
    rm -f "$temporary"
    run_root apt-get update
    # Never remove conflicting installed packages automatically; apt failures are reported.
    run_root apt-get install -y --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
}

configure_proxy_trust() {
  local network driver gateways candidate selected=''
  network=$(run_docker network ls --filter label=com.docker.compose.project=smallbin --filter label=com.docker.compose.network=default --format '{{.ID}}')
  [[ "$network" =~ ^[a-f0-9]{12,64}$ ]] || { fail 'Expected exactly one Compose default network for project smallbin.'; return 1; }
  driver=$(run_docker network inspect "$network" --format '{{.Driver}}')
  [[ "$driver" == bridge ]] || { fail 'The Compose network must use the native Linux bridge driver.'; return 1; }
  gateways=$(run_docker network inspect "$network" --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}')
  while IFS= read -r candidate; do
    if valid_ipv4 "$candidate"; then [[ -z "$selected" ]] || { fail 'Multiple IPv4 gateways require manual review.'; return 1; }; selected=$candidate; fi
  done <<< "$gateways"
  [[ -n "$selected" ]] || { fail 'Docker did not report an IPv4 bridge gateway.'; return 1; }
  TRUSTED_PROXIES=$selected
  write_env
  printf 'Trusted nginx transport peer: %s (Docker bridge gateway only).\n' "$TRUSTED_PROXIES"
}

install_nginx_config() {
  local source=$1 destination=${2:-$NGINX_SITE} backup='' temporary
  run_root install -d -m 755 "$(dirname "$destination")" || return 1
  if run_root test -e "$destination"; then
    backup="$destination.bak.$RUN_STAMP.$$.$RANDOM"
    run_root cp -p "$destination" "$backup" || return 1
  fi
  LAST_NGINX_BACKUP=$backup
  temporary=$(run_root mktemp "$(dirname "$destination")/.smallbin.XXXXXX") || return 1
  if ! run_root install -m 644 "$source" "$temporary" || ! run_root mv "$temporary" "$destination"; then
    run_root rm -f "$temporary" || true
    return 1
  fi
  if ! run_root nginx -t; then
    if [[ -n "$backup" ]]; then
      if ! run_root cp -p "$backup" "$destination"; then fail "nginx validation and rollback both failed; inspect $destination and $backup"; return 1; fi
    elif ! run_root rm -f "$destination"; then
      fail "nginx validation failed and the new site could not be removed: $destination"; return 1
    fi
    fail "nginx validation failed; restored the previous site configuration: $destination"
    return 1
  fi
  if ! run_root systemctl reload nginx; then
    if restore_nginx_config "$destination" "$backup"; then
      fail "nginx reload failed; restored and reloaded the previous site configuration: $destination"
    else
      fail "nginx reload and rollback both failed; inspect $destination and its timestamped backup before reloading"
    fi
    return 1
  fi
}

restore_nginx_config() {
  local destination=$1 backup=$2
  if [[ -n "$backup" ]]; then run_root cp -p "$backup" "$destination" || return 1; else run_root rm -f "$destination" || return 1; fi
  run_root nginx -t && run_root systemctl reload nginx
}

configure_https() {
  local certificate="/etc/letsencrypt/live/$DOMAIN/fullchain.pem" key="/etc/letsencrypt/live/$DOMAIN/privkey.pem" temporary bootstrap_changed=false bootstrap_backup=''
  run_root install -d -m 755 /var/www/letsencrypt
  run_root systemctl enable --now nginx
  if ! run_root test -s "$certificate" || ! run_root test -s "$key"; then
    STAGE='nginx ACME bootstrap'
    install_nginx_config "$HTTP_CONFIG"
    bootstrap_changed=true
    bootstrap_backup=$LAST_NGINX_BACKUP
    STAGE='interactive certificate issuance'
    printf '\nCertbot will ask for contact details and its terms. DNS must point here; ports 80 and 443 must already be reachable.\n'
    if ! run_root certbot certonly --webroot -w /var/www/letsencrypt --cert-name "$DOMAIN" -d "$DOMAIN"; then
      if restore_nginx_config "$NGINX_SITE" "$bootstrap_backup"; then
        fail 'Certificate issuance failed or was cancelled; restored the previous nginx site. The app and its data are retained.'
      else
        fail "Certificate issuance and nginx rollback failed; inspect $NGINX_SITE and its backups. The app and its data are retained."
      fi
      return 1
    fi
  else
    printf 'Reusing the existing certificate for %s.\n' "$DOMAIN"
  fi
  STAGE='nginx HTTPS configuration'
  if ! install_nginx_config "$HTTPS_CONFIG"; then
    if [[ "$bootstrap_changed" == true ]]; then
      if ! restore_nginx_config "$NGINX_SITE" "$bootstrap_backup"; then
        fail "HTTPS installation and restoration of the original nginx site failed; inspect $NGINX_SITE and its backups"
      fi
    fi
    return 1
  fi
  temporary=$(mktemp)
  printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' > "$temporary"
  run_root install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  if run_root test -e /etc/letsencrypt/renewal-hooks/deploy/smallbin-reload-nginx; then
    run_root cp -p /etc/letsencrypt/renewal-hooks/deploy/smallbin-reload-nginx "/etc/letsencrypt/renewal-hooks/smallbin-reload-nginx.bak.$RUN_STAMP.$$"
  fi
  run_root install -m 755 "$temporary" /etc/letsencrypt/renewal-hooks/deploy/smallbin-reload-nginx
  rm -f "$temporary"
  run_root systemctl enable --now certbot.timer
  STAGE='certificate renewal and HTTPS verification'
  run_root certbot renew --cert-name "$DOMAIN" --dry-run
  curl --fail --show-error --silent --retry 3 --connect-timeout 10 --max-time 30 "https://$DOMAIN/" -o /dev/null
}

perform_deployment() {
  local endpoint security operating_system
  STAGE='prerequisite installation'
  install_prerequisites
  run_root systemctl enable --now docker
  endpoint=$(run_docker context inspect default --format '{{.Endpoints.docker.Host}}')
  [[ "$endpoint" == unix:///var/run/docker.sock ]] || { fail 'Full deployment requires the native /var/run/docker.sock daemon, not a remote or Desktop context.'; return 1; }
  security=$(run_docker info --format '{{json .SecurityOptions}}')
  [[ "$security" != *rootless* ]] || { fail 'Rootless Docker requires manual proxy-peer configuration; use --prepare-only.'; return 1; }
  operating_system=$(run_docker info --format '{{.OSType}}|{{.OperatingSystem}}')
  [[ "$operating_system" == linux\|* && "$operating_system" != *Desktop* ]] || { fail 'Docker Desktop and non-Linux daemons need manual setup; use --prepare-only.'; return 1; }
  STAGE='Docker image build'
  run_compose build
  STAGE='Compose creation and proxy discovery'
  run_compose create
  configure_proxy_trust
  STAGE='application startup and readiness'
  APP_STARTED=true
  run_compose up -d --no-build --wait
  curl --fail --show-error --silent --retry 5 --retry-connrefused --connect-timeout 5 --max-time 10 "http://127.0.0.1:$HOST_PORT/healthz"
  printf '\n'
  configure_https
}

report_failure() {
  local status=$1 line=${2:-unknown}
  printf '\nSetup stopped during %s (line %s, exit %s).\nConfiguration: %s\nRendered nginx files: %s\nNo data volumes were removed. Existing backups remain next to their original files.\n' "${STAGE:-initialization}" "$line" "$status" "${ENV_FILE:-not written}" "${GENERATED_DIR:-not written}" >&2
  if [[ "${APP_STARTED:-false}" == true ]]; then printf 'Smallbin may still be running; setup has not stopped it. Check http://127.0.0.1:%s/healthz and fix the failed stage before rerunning.\n' "$HOST_PORT" >&2; fi
}

main() {
  set -Eeuo pipefail
  umask 077
  PREPARE_ONLY=false
  while [[ $# -gt 0 ]]; do
    case "$1" in --prepare-only) PREPARE_ONLY=true ;; --help|-h) usage; return 0 ;; *) usage >&2; fail "Unknown option: $1"; return 1 ;; esac
    shift
  done
  initialize_paths
  trap 'status=$?; report_failure "$status" "$LINENO"; exit "$status"' ERR
  trap 'report_failure 130 "$LINENO"; exit 130' INT
  trap 'report_failure 143 "$LINENO"; exit 143' TERM
  if [[ "$PREPARE_ONLY" == false ]]; then check_host; fi
  prepare_inputs
  STAGE='configuration files'
  write_configuration
  if [[ "$PREPARE_ONLY" == true ]]; then
    printf '\nConfiguration prepared. Review %s and %s. No host services were changed.\n' "$ENV_FILE" "$GENERATED_DIR"
    return 0
  fi
  perform_deployment
  STAGE=complete
  printf '\nSmallbin is available at https://%s/\nApplication binds only to 127.0.0.1:%s on the host.\n' "$DOMAIN" "$HOST_PORT"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
