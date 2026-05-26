#!/bin/bash
set -euxo pipefail

# Loader EC2 user-data — installs Corretto 21, CloudHSM Client SDK 5, ADOT, iperf3
# and writes the hsm-bmt-runner.service systemd unit.
# NOTE: ADOT collector config is fetched from S3 at boot (Unit 3 publishes it).

# Region resolved at boot from instance metadata (IMDSv2). Same template can be
# baked into AMIs deployed in any region without rebuild — the loader stack
# embeds region-equivalent IDs and the SSM lookup runs against this region.
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600" 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  REGION=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null \
    || echo "ap-northeast-2")
else
  # IMDSv1 fallback / hardcoded default for legacy instances
  REGION=$(curl -sf http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null \
    || echo "ap-northeast-2")
fi
LOG=/var/log/hsm-bmt/bootstrap.log
mkdir -p /var/log/hsm-bmt

# 1) Corretto 21
dnf install -y java-21-amazon-corretto-headless

# 2) CloudHSM Client SDK 5 (>= 5.9 for hsm2m.medium support)
SDK_BASE="https://s3.amazonaws.com/cloudhsmv2-software/CloudHsmClient/EL9"
dnf install -y \
  "${SDK_BASE}/cloudhsm-cli-latest.el9.x86_64.rpm" \
  "${SDK_BASE}/cloudhsm-pkcs11-latest.el9.x86_64.rpm" \
  "${SDK_BASE}/cloudhsm-jce-latest.el9.x86_64.rpm"

# 3) ADOT collector binary (config will be fetched by Unit 3 ops)
ADOT_RPM="https://aws-otel-collector.s3.amazonaws.com/amazon_linux/amd64/latest/aws-otel-collector.rpm"
rpm -Uvh "${ADOT_RPM}"

# 4) iperf3 (used by Pre-check Gate 1 only)
dnf install -y iperf3

# 4b) Python 3.12 + WeasyPrint deps for the Korean report renderer
dnf install -y python3.12 python3.12-pip python3.12-devel \
  cairo pango libffi-devel \
  google-noto-sans-cjk-fonts google-noto-serif-cjk-fonts || true

# 5) Configure CloudHSM client with cluster ID(s) from SSM Parameter Store
#
# 2026-05-24 multi-cluster scale-out: when /hsm-bmt/core/cluster-count > 1 the
# loader runs PKCS#11 multi-slot — first cluster initializes the SDK, then
# `configure-pkcs11 add-cluster --cluster-id ...` is called for each additional
# cluster (per AWS doc pkcs11-library-configs-multi-slot.html, Client SDK 5).
# JCE (`configure-jce`) only attaches to the first cluster — the multi-cluster
# bench path uses PKCS#11 directly via libcloudhsm_pkcs11.so.
CLUSTER_COUNT=$(aws ssm get-parameter --region "${REGION}" --name /hsm-bmt/core/cluster-count --query Parameter.Value --output text 2>/dev/null || echo 1)
if [ "${CLUSTER_COUNT}" -le 1 ]; then
  CLUSTER_ID=$(aws ssm get-parameter --region "${REGION}" --name /hsm-bmt/core/cluster-id --query Parameter.Value --output text)
  /opt/cloudhsm/bin/configure-pkcs11 --cluster-id "${CLUSTER_ID}"
  /opt/cloudhsm/bin/configure-jce    --cluster-id "${CLUSTER_ID}"
else
  echo "Multi-cluster mode: configuring ${CLUSTER_COUNT} clusters" | tee -a "${LOG}"
  CLUSTER_ID_1=$(aws ssm get-parameter --region "${REGION}" --name /hsm-bmt/core/cluster-id-1 --query Parameter.Value --output text)
  /opt/cloudhsm/bin/configure-pkcs11 --cluster-id "${CLUSTER_ID_1}"
  /opt/cloudhsm/bin/configure-jce    --cluster-id "${CLUSTER_ID_1}"
  for i in $(seq 2 "${CLUSTER_COUNT}"); do
    CID=$(aws ssm get-parameter --region "${REGION}" --name "/hsm-bmt/core/cluster-id-${i}" --query Parameter.Value --output text)
    echo "  add-cluster: ${CID}" | tee -a "${LOG}"
    /opt/cloudhsm/bin/configure-pkcs11 add-cluster --cluster-id "${CID}"
  done
fi

# 6) Write hsm-bmt-runner.service systemd unit (disabled by default; SSM Run Command triggers it)
S3_BUCKET=$(aws ssm get-parameter --region "${REGION}" --name /hsm-bmt/core/s3-bucket-name --query Parameter.Value --output text)
cat >/etc/systemd/system/hsm-bmt-runner.service <<UNIT
[Unit]
Description=CloudHSM BMT loader runner (V3 sequence + per-call matrix)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/hsm-bmt/runner.env
ExecStartPre=/usr/local/bin/hsm-bmt-verify-binary.sh
ExecStart=/usr/bin/java -Xms2g -Xmx16g \\
  --enable-preview \\
  -XX:+UseZGC -XX:+ZGenerational -XX:MaxGCPauseMillis=50 \\
  -Dotel.exporter.otlp.endpoint=http://localhost:4317 \\
  -Dotel.service.name=hsm-bmt-loader \\
  -jar /opt/hsm-bmt/loader.jar
Restart=on-failure
User=hsmbmt
Group=hsmbmt

[Install]
WantedBy=multi-user.target
UNIT

# Pre-flight verifier (NFR-3.5): verifies S3 versionId + sha256 from DynamoDB run record
cat >/usr/local/bin/hsm-bmt-verify-binary.sh <<'VERIFY'
#!/bin/bash
set -euo pipefail
RUN_ID="${RUN_ID:?RUN_ID env var required}"
EXPECTED_VERSION="${EXPECTED_VERSION_ID:?EXPECTED_VERSION_ID env var required}"
EXPECTED_SHA="${EXPECTED_SHA256:?EXPECTED_SHA256 env var required}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET env var required}"

mkdir -p /opt/hsm-bmt
aws s3api get-object \
  --bucket "${S3_BUCKET}" \
  --key "loader-artifacts/loader-current.jar" \
  --version-id "${EXPECTED_VERSION}" \
  /opt/hsm-bmt/loader.jar
ACTUAL_SHA=$(sha256sum /opt/hsm-bmt/loader.jar | awk '{print $1}')
if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
  echo "FATAL: loader.jar sha256 mismatch (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})" >&2
  exit 42
fi
echo "Binary verified: sha256=${ACTUAL_SHA} versionId=${EXPECTED_VERSION}"
VERIFY
chmod 0755 /usr/local/bin/hsm-bmt-verify-binary.sh

# Create hsmbmt user
useradd -r -s /sbin/nologin hsmbmt || true
mkdir -p /opt/hsm-bmt /etc/hsm-bmt
chown -R hsmbmt:hsmbmt /opt/hsm-bmt /etc/hsm-bmt /var/log/hsm-bmt

systemctl daemon-reload
# Service is NOT enabled by default — SSM Run Command from Unit 5 starts it.

# CloudWatch agent — install + configure to ship SDK 5 logs and loader logs
dnf install -y amazon-cloudwatch-agent
cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<JSON
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/aws/cloudhsm/*.log",  "log_group_name": "/hsm-bmt/loader", "log_stream_name": "cloudhsm-sdk5-{instance_id}" },
          { "file_path": "/var/log/hsm-bmt/loader.log",  "log_group_name": "/hsm-bmt/loader", "log_stream_name": "loader-{instance_id}" }
        ]
      }
    }
  }
}
JSON
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

echo "CloudHSM BMT loader bootstrap complete" | tee -a "${LOG}"
