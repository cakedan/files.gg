# shellcheck shell=bash
# Sourced by ops/check-env.sh and ops/deploy.sh: reads the stack's configuration the way docker compose does, the
# shell's environment first, then the env file (ENV_FILE, default .env at the repository's root). Never `source`s the
# env file, so a value is never run as shell.

ENV_FILE=${ENV_FILE:-.env}

# the value of `NAME=...` in the env file (the last one wins, as in compose): quotes removed, and an unquoted value's
# trailing ` # comment` dropped. Empty when it isn't there.
env_file_value() {
  local line value
  [ -f "$ENV_FILE" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE" | tail -n 1) || true
  [ -n "$line" ] || return 0
  value=${line#*=}
  value=${value#"${value%%[![:space:]]*}"}
  case $value in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
    *) value=${value%%[[:space:]]#*}; value=${value%"${value##*[![:space:]]}"} ;;
  esac
  printf '%s' "$value"
}

# whether NAME is set at all, in the environment or the env file
env_is_set() {
  [ -n "${!1+x}" ] && return 0
  [ -f "$ENV_FILE" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE"
}

# NAME's value as compose sees it: the environment's when it's exported, else the env file's
env_value() {
  if [ -n "${!1+x}" ]; then
    printf '%s' "${!1}"
  else
    env_file_value "$1"
  fi
}
