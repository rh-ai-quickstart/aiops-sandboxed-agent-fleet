#!/usr/bin/env bash
# lab-smoke.sh — per-attendee health check of a lab deployed with scripts/lab.sh. Read-only.
#
#   lab-smoke.sh [users...]        default: every attendee namespace on the cluster
#
# For each attendee: workshop /healthz through its Route (ungated), /api/lab with the
# attendee's access token (Authorization: Bearer), OpenShell gateway Ready, demo app Ready.
# Exits non-zero when any attendee fails a check. Env: CLUSTER_APPS_DOMAIN, LAB_SMOKE_TIMEOUT.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
require_cmd oc; require_cmd curl; require_cmd jq

DOMAIN="$(cluster_apps_domain)"
TIMEOUT="${LAB_SMOKE_TIMEOUT:-10}"
users=("$@")
if ((${#users[@]} == 0)); then
  mapfile -t users < <(oc get ns -l lab.nemoclaw.io/managed=true,lab.nemoclaw.io/role=openshell \
    -o jsonpath='{range .items[*]}{.metadata.labels.lab\.nemoclaw\.io/user}{"\n"}{end}' | sort)
fi
((${#users[@]})) || die "no attendee namespaces found (label lab.nemoclaw.io/managed=true)"

ready() {   # ready <ns> <kind/name> -> 0 when readyReplicas == replicas > 0
  local r
  r="$(oc -n "$1" get "$2" -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null || true)"
  [[ -n "$r" && "${r%/*}" == "${r#*/}" && "${r#*/}" != 0 ]]
}

fail=0
printf '%-10s %-8s %-8s %-8s %-6s %s\n' USER HEALTHZ API_LAB GATEWAY DEMO DETAIL
for u in "${users[@]}"; do
  ns="${u}-openshell"; dns="${u}-demo"; detail=""
  base="https://workshop-${ns}.${DOMAIN}"
  hz="$(curl -sk -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$base/healthz" || echo 000)"
  token="$(oc -n "$ns" get secret workshop-access -o jsonpath='{.data.LAB_ACCESS_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  api="000"
  if [[ -n "$token" ]]; then
    body="$(curl -sk --max-time "$TIMEOUT" -w '\n%{http_code}' \
      -H "Authorization: Bearer ${token}" "$base/api/lab" || printf '\n000')"
    api="${body##*$'\n'}"
    if [[ "$api" == 200 ]]; then
      got="$(jq -r '.user // .labUser // empty' <<<"${body%$'\n'*}" 2>/dev/null || true)"
      [[ -z "$got" || "$got" == "$u" ]] || { api="user?"; detail+="api/lab user=${got} "; }
    fi
  else
    detail+="no workshop-access secret "
  fi
  ready "$ns" statefulset/openshell && gw=ok || gw=down
  if ready "$dns" deploy/shop-app && ready "$dns" deploy/payments; then demo=ok; else demo=down; fi
  [[ "$hz" == 200 ]] || detail+="healthz=${hz} "
  [[ "$api" == 200 ]] || detail+="api/lab=${api} "
  if [[ "$hz" != 200 || "$api" != 200 || "$gw" != ok || "$demo" != ok ]]; then fail=$((fail + 1)); fi
  printf '%-10s %-8s %-8s %-8s %-6s %s\n' "$u" "$hz" "$api" "$gw" "$demo" "${detail:-}"
done
if ((fail)); then warn "${fail}/${#users[@]} attendee(s) unhealthy"; exit 1; fi
log "all ${#users[@]} attendee(s) healthy"
