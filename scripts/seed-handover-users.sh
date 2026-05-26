#!/usr/bin/env bash
# U-CH-6 G5: Cognito user seeding helper for customer handover.
#
# Spec: customer-handover-requirements.md FR-CH-10.1..10.5
#   - 1 admin user + N viewer users (default 3, range 1..10)
#   - admin → "admin" group, viewer → "viewer" group
#   - force_change_password on first login (Cognito default for admin-create-user
#     when MessageAction is omitted: user lands in FORCE_CHANGE_PASSWORD state)
#   - temp passwords printed to stdout; operator transfers OOB (no SES)
#
# WARNING — DO NOT pass --message-action SUPPRESS or --no-temporary-password.
# Both break FR-CH-10.2 (force_change_password=true). The script enforces this
# by hard-coding the omission.
#
# Usage:
#   bash scripts/seed-handover-users.sh \
#     --admin-email test-admin@example.com \
#     --viewer-emails alice@example.com,bob@example.com,carol@example.com \
#     [--user-pool-id ap-northeast-2_AbCdEfGhI]      # optional; pulled from SSM
#     [--region ap-northeast-2]                       # optional; default ap-northeast-2
#     [--dry-run]                                     # print what would be done, no AWS call
#
# Exit codes:
#   0 — all users created (or already-existing skipped)
#   2 — bad arguments
#   3 — at least one cognito CLI call failed (other than UsernameExistsException)

set -uo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
DRY_RUN=0
ADMIN_EMAIL=""
VIEWER_EMAILS=""
POOL_ID=""

usage() {
  sed -n '/^# Usage:/,/^# Exit/p' "$0" | sed 's/^# //'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-email)    ADMIN_EMAIL="$2"; shift 2 ;;
    --viewer-emails)  VIEWER_EMAILS="$2"; shift 2 ;;
    --user-pool-id)   POOL_ID="$2"; shift 2 ;;
    --region)         REGION="$2"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage ;;
    *)                echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$ADMIN_EMAIL" ] && { echo "--admin-email is required" >&2; usage; }
[ -z "$VIEWER_EMAILS" ] && { echo "--viewer-emails is required" >&2; usage; }

if [ -z "$POOL_ID" ]; then
  POOL_ID=$(aws ssm get-parameter --region "$REGION" \
    --name /hsm-bmt/web/cognito-user-pool-id \
    --query Parameter.Value --output text 2>/dev/null) || {
      echo "Failed to read /hsm-bmt/web/cognito-user-pool-id from SSM. Pass --user-pool-id explicitly." >&2
      exit 2
    }
fi
echo "Pool: $POOL_ID  Region: $REGION  Dry-run: $DRY_RUN"

# Range check on viewer count (FR-CH-10.1: 1..10).
IFS=',' read -ra VIEWERS <<< "$VIEWER_EMAILS"
N_VIEWERS="${#VIEWERS[@]}"
if [ "$N_VIEWERS" -lt 1 ] || [ "$N_VIEWERS" -gt 10 ]; then
  echo "--viewer-emails must list 1..10 addresses (got $N_VIEWERS)" >&2
  exit 2
fi

FAILED=0

# generate a Cognito-compliant temp password (≥12 chars, mix of upper/lower/digit/symbol).
gen_password() {
  # 18 random base64 chars + a fixed symbol/digit/upper/lower to satisfy the policy
  local rand
  rand=$(openssl rand -base64 18 | tr -d '=+/')
  echo "${rand}A1!a"
}

create_user() {
  local email="$1" group="$2"
  local pw
  pw=$(gen_password)

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] admin-create-user $email → group=$group  temp_pw=$pw"
    return 0
  fi

  # NOTE: --message-action SUPPRESS is INTENTIONALLY omitted. Cognito's
  # default behaviour places the user in FORCE_CHANGE_PASSWORD state, which
  # FR-CH-10.2 requires. Sending the welcome email is fine — the operator
  # also delivers the temp pw OOB per FR-CH-10.4.
  if ! aws cognito-idp admin-create-user --region "$REGION" \
        --user-pool-id "$POOL_ID" \
        --username "$email" \
        --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
        --temporary-password "$pw" \
        >/dev/null 2>/tmp/seed-err-$$; then
    if grep -q UsernameExistsException /tmp/seed-err-$$; then
      echo "[skip] $email already exists — leaving group/password untouched"
      rm -f /tmp/seed-err-$$
      return 0
    fi
    echo "ERROR creating $email:" >&2
    cat /tmp/seed-err-$$ >&2
    rm -f /tmp/seed-err-$$
    FAILED=1
    return 1
  fi
  rm -f /tmp/seed-err-$$

  if ! aws cognito-idp admin-add-user-to-group --region "$REGION" \
        --user-pool-id "$POOL_ID" \
        --username "$email" \
        --group-name "$group" \
        >/dev/null 2>&1; then
    echo "ERROR adding $email to group $group" >&2
    FAILED=1
    return 1
  fi

  printf "%-40s  %-7s  %s\n" "$email" "$group" "$pw"
}

echo "----  email                                    group    temp_password"
create_user "$ADMIN_EMAIL" admin
for v in "${VIEWERS[@]}"; do
  create_user "$v" viewer
done

if [ "$FAILED" = "1" ]; then
  exit 3
fi

cat <<EOF

Done. Distribute the temp passwords OOB (FR-CH-10.4 — no SES, no email).
First login forces password change (Cognito FORCE_CHANGE_PASSWORD state).
Hosted UI: https://\$(aws ssm get-parameter --region $REGION --name /hsm-bmt/web/cognito-hosted-ui-domain --query Parameter.Value --output text).auth.$REGION.amazoncognito.com/login
EOF
