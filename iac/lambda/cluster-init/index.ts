/**
 * BMT Cluster + HSM lifecycle Custom Resource Lambda — async pattern.
 *
 * AWS::CloudHSMV2::{Cluster,Hsm} are NOT valid CloudFormation resource types
 * (verified 2026-05-16 via cloudformation:DescribeType → TypeNotFoundException).
 * CloudHSMV2 resources have to be created via the SDK. We do that here from a
 * pair of handlers (onEvent + isComplete) so the entire flow can take >15 min:
 *
 *   onEvent:
 *     - On Create/Update: ensure cluster exists (CreateCluster if not), kick off
 *       HSM creation in parallel with the existing fleet, generate ephemeral CA
 *       (PutSecretValue), return PhysicalResourceId = ClusterId.
 *     - On Delete: schedule HSM deletes; isComplete waits for them all to vanish,
 *       then DeleteCluster.
 *
 *   isComplete (CFN polls every queryInterval):
 *     - For Create/Update: returns IsComplete=true once cluster.State == ACTIVE
 *       AND the requested number of HSMs are all ACTIVE. If cluster is
 *       UNINITIALIZED with a CSR, signs and InitializeCluster, then keeps polling.
 *     - For Delete: returns IsComplete=true once cluster is gone.
 *
 * Each HSM creation is launched asynchronously; the SDK serializes through CloudHSM
 * itself, so isComplete just polls until the desired fleet matches the actual fleet.
 */

import {
  CloudHSMV2Client,
  CreateClusterCommand,
  CreateHsmCommand,
  DeleteClusterCommand,
  DeleteHsmCommand,
  DescribeClustersCommand,
  InitializeClusterCommand,
} from '@aws-sdk/client-cloudhsm-v2';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
  TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import * as forge from 'node-forge';

interface SlotSpec {
  logicalId: string;
  az: string;
}

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: {
    HsmType: string;
    SubnetIds: string[];
    Slots: SlotSpec[];
    CaSecretArn: string;
  };
}

interface CaMaterial {
  certificate: string;
  privateKey: string;
}

const TAG_KEY_CLUSTER_ID = 'hsm-bmt-cluster-id';

const cloudhsm = new CloudHSMV2Client({});
const secrets = new SecretsManagerClient({});

/* ---------- onEvent ---------- */

export async function handler(event: CustomResourceEvent): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> {
  const { HsmType, SubnetIds, Slots, CaSecretArn } = event.ResourceProperties;

  if (event.RequestType === 'Delete') {
    const clusterId = event.PhysicalResourceId;
    if (!clusterId || !clusterId.startsWith('cluster-')) {
      return { PhysicalResourceId: clusterId ?? 'no-cluster' };
    }
    const cluster = await describeCluster(clusterId);
    if (cluster) {
      for (const h of cluster.Hsms ?? []) {
        if (h.HsmId) {
          try { await cloudhsm.send(new DeleteHsmCommand({ ClusterId: clusterId, HsmId: h.HsmId })); }
          catch { /* best-effort */ }
        }
      }
    }
    return { PhysicalResourceId: clusterId };
  }

  // Create / Update — find or create cluster
  let clusterId: string | undefined;
  if (event.PhysicalResourceId && event.PhysicalResourceId.startsWith('cluster-')) {
    const existing = await describeCluster(event.PhysicalResourceId);
    if (existing) clusterId = event.PhysicalResourceId;
  }

  if (!clusterId) {
    const out = await cloudhsm.send(new CreateClusterCommand({
      HsmType,
      // FIPS mode is required by NFR-1.2 (FIPS 140-3 Level 3, Cert #4703).
      // hsm2m.medium requires explicit Mode parameter; without it CreateCluster
      // returns "Mode is a required argument for this hsm type".
      Mode: 'FIPS',
      SubnetIds,
      BackupRetentionPolicy: { Type: 'DAYS', Value: '7' },
      TagList: [{ Key: 'hsm-bmt:role', Value: 'cluster' }],
    }));
    clusterId = out.Cluster?.ClusterId;
    if (!clusterId) throw new Error('CreateCluster returned no ClusterId');
  }

  // Cluster typically takes ~5 min to reach UNINITIALIZED. We DO NOT call
  // CreateHsm or InitializeCluster here — that happens in isComplete which
  // CFN polls until everything is ACTIVE.
  // Ensure CA exists so signing is ready when CSR appears.
  await ensureCa(CaSecretArn, clusterId);

  return { PhysicalResourceId: clusterId, Data: { ClusterId: clusterId } };
}

/* ---------- isComplete ---------- */

export async function isComplete(event: CustomResourceEvent): Promise<{ IsComplete: boolean; Data?: Record<string, string> }> {
  if (event.RequestType === 'Delete') {
    if (!event.PhysicalResourceId || !event.PhysicalResourceId.startsWith('cluster-')) {
      return { IsComplete: true };
    }
    const cluster = await describeCluster(event.PhysicalResourceId);
    if (!cluster) return { IsComplete: true };
    const remaining = (cluster.Hsms ?? []).filter((h) => h.State !== 'DELETED');
    if (remaining.length === 0) {
      try { await cloudhsm.send(new DeleteClusterCommand({ ClusterId: event.PhysicalResourceId })); } catch { /* possibly already gone */ }
      return { IsComplete: true };
    }
    return { IsComplete: false };
  }

  const clusterId = event.PhysicalResourceId;
  if (!clusterId) return { IsComplete: false };
  const cluster = await describeCluster(clusterId);
  if (!cluster) return { IsComplete: false };

  // Wait for cluster to leave CREATE_IN_PROGRESS before creating any HSMs.
  // CloudHSM rejects CreateHsm while the cluster itself is still being created.
  // IMPORTANT: cr.Provider framework rejects Data when IsComplete=false
  // ("Data is not allowed if IsComplete is False"), so omit Data here.
  if (cluster.State === 'CREATE_IN_PROGRESS') {
    return { IsComplete: false };
  }

  // Reconcile may need a second pass once preceding HSM activates (CloudHSM serializes)
  await reconcileHsms(clusterId, event.ResourceProperties.Slots);

  // If UNINITIALIZED with CSR, sign + InitializeCluster
  if (cluster.State === 'UNINITIALIZED' && cluster.Certificates?.ClusterCsr) {
    const ca = await ensureCa(event.ResourceProperties.CaSecretArn, clusterId);
    const signedCert = signCsr(cluster.Certificates.ClusterCsr, ca);
    try {
      await cloudhsm.send(new InitializeClusterCommand({
        ClusterId: clusterId,
        SignedCert: signedCert,
        TrustAnchor: ca.certificate,
      }));
    } catch (e: unknown) {
      // already initialized, etc.
      if ((e as Error).message?.includes('not in a state')) {
        // ignore
      } else {
        throw e;
      }
    }
  }

  // Done condition: cluster ACTIVE AND all desired HSMs ACTIVE
  const desiredCount = event.ResourceProperties.Slots.length;
  const activeHsms = (cluster.Hsms ?? []).filter((h) => h.State === 'ACTIVE').length;
  const isReady = cluster.State === 'ACTIVE' && activeHsms >= desiredCount;
  if (!isReady) return { IsComplete: false };
  return { IsComplete: true, Data: { ClusterId: clusterId, State: cluster.State ?? 'UNKNOWN' } };
}

/* ---------- helpers ---------- */

async function reconcileHsms(clusterId: string, slots: SlotSpec[]): Promise<void> {
  const cluster = await describeCluster(clusterId);
  const existing = cluster?.Hsms ?? [];

  const desiredByAz = new Map<string, number>();
  for (const s of slots) desiredByAz.set(s.az, (desiredByAz.get(s.az) ?? 0) + 1);

  const actualByAz = new Map<string, typeof existing>();
  for (const h of existing) {
    if (!h.AvailabilityZone || h.State === 'DELETED') continue;
    if (!actualByAz.has(h.AvailabilityZone)) actualByAz.set(h.AvailabilityZone, []);
    actualByAz.get(h.AvailabilityZone)!.push(h);
  }

  // Delete excess
  for (const [az, hsms] of actualByAz.entries()) {
    const need = desiredByAz.get(az) ?? 0;
    if (hsms.length > need) {
      for (const h of hsms.slice(need)) {
        if (h.HsmId) {
          try { await cloudhsm.send(new DeleteHsmCommand({ ClusterId: clusterId, HsmId: h.HsmId })); }
          catch { /* best-effort */ }
        }
      }
    }
  }

  // Create missing — only one outstanding CreateHsm per cluster at a time
  // (CloudHSM serializes; if a previous CreateHsm is in flight, we'll come back next poll)
  const hasPending = existing.some((h) => h.State === 'CREATE_IN_PROGRESS');
  if (!hasPending) {
    for (const [az, count] of desiredByAz.entries()) {
      const have = actualByAz.get(az)?.length ?? 0;
      if (have < count) {
        try { await cloudhsm.send(new CreateHsmCommand({ ClusterId: clusterId, AvailabilityZone: az })); }
        catch (e: unknown) {
          if (!(e as Error).message?.includes('already')) throw e;
        }
        // create one HSM per reconciliation pass; isComplete polls again
        return;
      }
    }
  }
}

async function ensureCa(secretArn: string, clusterId: string): Promise<CaMaterial> {
  const describe = await secrets.send(new DescribeSecretCommand({ SecretId: secretArn }));
  const taggedClusterId = (describe.Tags ?? []).find((t) => t.Key === TAG_KEY_CLUSTER_ID)?.Value;
  if (taggedClusterId === clusterId) {
    const got = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (got.SecretString) return JSON.parse(got.SecretString) as CaMaterial;
  }
  const ca = generateCa();
  await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(ca) }));
  await secrets.send(new TagResourceCommand({ SecretId: secretArn, Tags: [{ Key: TAG_KEY_CLUSTER_ID, Value: clusterId }] }));
  return ca;
}

function generateCa(): CaMaterial {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'hsm-bmt-ephemeral-ca' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);
  cert.sign(keypair.privateKey, forge.md.sha256.create());
  return {
    certificate: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keypair.privateKey),
  };
}

async function describeCluster(clusterId: string): Promise<{ State?: string; Hsms?: Array<{ HsmId?: string; AvailabilityZone?: string; State?: string }>; Certificates?: { ClusterCsr?: string } } | undefined> {
  try {
    const out = await cloudhsm.send(new DescribeClustersCommand({ Filters: { clusterIds: [clusterId] } }));
    return out.Clusters?.[0];
  } catch {
    return undefined;
  }
}

function signCsr(csrPem: string, ca: CaMaterial): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) throw new Error('CSR signature is invalid');
  const caCert = forge.pki.certificateFromPem(ca.certificate);
  const caKey = forge.pki.privateKeyFromPem(ca.privateKey);
  const cert = forge.pki.createCertificate();
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer(caCert.subject.attributes);
  cert.publicKey = csr.publicKey as forge.pki.PublicKey;
  cert.sign(caKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}
