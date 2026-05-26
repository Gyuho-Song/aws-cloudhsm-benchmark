# `iac/` — CloudHSM CloudHSM BMT Phase 1 Infrastructure

AWS CDK (TypeScript) implementation of **Unit 1: Infrastructure** per
`aidlc-docs/construction/u1-infrastructure/infrastructure-design/infrastructure-design.md`.

## What's in here

```
bin/hsm-bmt.ts                    CDK app entry
lib/core-stack.ts                 CoreStack — composes 8 constructs
lib/constructs/
  network-construct.ts            VPC, subnets (4 AZ), SGs, VPC endpoints
  iam-construct.ts                LoaderInstanceRole + OperatorRole (cross-account)
  crypto-construct.ts             SecretsManager: ca-private-key (placeholder), CO/CU passwords
  hsm-cluster-construct.ts        CfnCluster + 6 fixed-id CfnHsm + Cluster-Init Custom Resource
  loader-instance-construct.ts    c8i.8xlarge with bootstrap user-data
  storage-construct.ts            S3 results bucket with KMS + lifecycle
  repository-construct.ts         CodeCommit OR GitHub fallback (C-9)
  iperf-peer-construct.ts         Ephemeral iperf3 peer (Pre-check Gate 1 only)
lambda/cluster-init/index.ts      Lambda: ephemeral CA + cluster InitializeCluster
assets/loader-bootstrap.sh        EC2 user-data (Corretto 21, SDK 5, ADOT, iperf3)
test/                             Jest behavioral + snapshot tests
```

## Setup

```bash
cd iac
npm install
npm run build
npm test
```

Tests run offline (CDK assertions + mocked SDK clients). No AWS credentials needed.

## Configuration (cdk.json context)

| Key                  | Default            | Description |
|----------------------|--------------------|-------------|
| `desiredHsmCount`    | `6`                | 2..6 HSMs; scale-down trajectory per Q5 (`6→5→4→3→2`) |
| `sdsAccountId`       | `000000000000`     | <PARTNER> AWS account ID for OperatorRole trust |
| `sdsExternalId`      | `hsm-bmt-handoff`  | ExternalId condition for cross-account assume-role |
| `repositoryProvider` | `codecommit`       | `codecommit` or `github` (per C-9 fallback) |
| `iperfPeer`          | `false`            | When `true`, deploys ephemeral iperf3 peer for Gate 1 |

Set via CLI: `npm run cdk -- synth --context desiredHsmCount=4 --context iperfPeer=true`.

Or edit `cdk.json` directly.

## Deploy procedure (Day 1-2)

```bash
# Day 1 — initial 6-HSM cluster + supporting infra
npm run cdk -- bootstrap aws://${ACCOUNT}/ap-northeast-2
npm run cdk -- synth CoreStack
npm run cdk -- deploy CoreStack --require-approval never

# Day 2 — Pre-check Gate 1 (iperf3)
npm run cdk -- deploy CoreStack --require-approval never --context iperfPeer=true
# (run iperf3 client on loader EC2 against IperfPeer instance)
# After Gate 1 passes:
npm run cdk -- deploy CoreStack --require-approval never --context iperfPeer=false
```

## Scale-down procedure (during Day 4 measurement)

```bash
npm run cdk -- deploy CoreStack --context desiredHsmCount=5
# wait for HSM in Az2Slot2 to be removed (~5-10 min)
npm run cdk -- deploy CoreStack --context desiredHsmCount=4
# ... continues 4 → 3 → 2
```

Logical IDs are pinned, so the scale-down order is deterministic per Q5 trajectory.

## Verification (Step 10 of code generation plan)

```bash
npm run build
npm test
npm run cdk -- synth CoreStack --context desiredHsmCount=2
npm run cdk -- synth CoreStack --context desiredHsmCount=6
npx cdk-nag CoreStack --rules AwsSolutionsChecks   # post-build static check
```

## <PARTNER> handoff (Phase 2)

Bucket `hsm-bmt-results-<account>-ap-northeast-2`:
- `runs/{runId}/` — Parquet measurement results (no auto-expiry — protected for Phase 2)
- `reports/{runId}/` — PDF + HTML

Cross-account read for <PARTNER> via `OperatorRole`:
```
aws sts assume-role \
  --role-arn ${OPERATOR_ROLE_ARN} \
  --external-id ${SDS_EXTERNAL_ID} \
  --role-session-name sds-phase2
```

## Migration to customer-managed KMS key (post-handoff, optional)

The S3 bucket uses AWS-managed KMS by default. To migrate to a customer-managed
key for long-term Phase 2 use, replace `s3.BucketEncryption.KMS_MANAGED` with
`s3.BucketEncryption.KMS` and pass an explicit `kms.Key`. Existing objects can
be rewritten via S3 Replication Inventory + bucket-level re-encryption.
