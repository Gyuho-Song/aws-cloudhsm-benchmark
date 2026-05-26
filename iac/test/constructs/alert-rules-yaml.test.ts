import * as fs from 'node:fs';
import * as path from 'node:path';

const RULES_PATH = path.join(__dirname, '..', '..', 'alerts', 'hsm-bmt-rules.yaml');

describe('Prometheus rule YAML', () => {
  const yaml = fs.readFileSync(RULES_PATH, 'utf-8');

  test.each([
    'HSM-Latency-P99-High',
    'HSM-Error-Rate-High',
    'HSM-Pool-Saturation',
    'HSM-Queue-Wait-Spike',
    'HSM-Failover-Storm',
    'HSM-Cluster-Degraded',
  ])('contains alert %s', (name) => {
    expect(yaml).toContain(`alert: ${name}`);
  });

  test('contains the EXPECTED_HSMS placeholder for cluster-degraded threshold', () => {
    expect(yaml).toContain('${EXPECTED_HSMS}');
  });

  test('every rule has severity label', () => {
    const severityCount = (yaml.match(/severity:/g) ?? []).length;
    expect(severityCount).toBeGreaterThanOrEqual(6);
  });
});
