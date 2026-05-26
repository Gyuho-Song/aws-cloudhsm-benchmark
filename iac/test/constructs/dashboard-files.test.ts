import * as fs from 'node:fs';
import * as path from 'node:path';

const DASHBOARDS_DIR = path.join(__dirname, '..', '..', 'dashboards');
const REQUIRED = ['live-run.json', 'saturation.json', 'per-call.json', 'native-aws.json'];

describe('Dashboard JSON files', () => {
  test.each(REQUIRED)('%s parses as JSON and has runId templating + refresh', (file) => {
    const raw = fs.readFileSync(path.join(DASHBOARDS_DIR, file), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.uid).toBeDefined();
    expect(parsed.title).toBeDefined();
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(36);
    expect(parsed.refresh).toBeDefined();
    if (file !== 'native-aws.json') {
      // Native AWS dashboard uses CloudWatch only — no runId template
      const list = parsed.templating?.list ?? [];
      const hasRunId = list.some((v: { name: string }) => v.name === 'runId');
      expect(hasRunId).toBe(true);
    }
  });

  test('all 4 required dashboards exist', () => {
    const found = fs.readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith('.json'));
    for (const r of REQUIRED) {
      expect(found).toContain(r);
    }
  });

  // U-CH-4: dashboards that surface per-run metrics must expose a
  // $showSubProc variable so the /runs/{id}/live page toggle can drive
  // sub-process drilldown without touching the dashboard JSON.
  const SUBPROC_DASHBOARDS = ['live-run.json', 'saturation.json', 'per-call.json'];
  test.each(SUBPROC_DASHBOARDS)('%s defines $showSubProc variable + dual-series queries', (file) => {
    const raw = fs.readFileSync(path.join(DASHBOARDS_DIR, file), 'utf-8');
    const parsed = JSON.parse(raw);
    const list = parsed.templating?.list ?? [];
    const showSubProc = list.find((v: { name: string }) => v.name === 'showSubProc');
    expect(showSubProc).toBeDefined();
    expect(showSubProc.options.map((o: { value: string }) => o.value)).toEqual(
      expect.arrayContaining(['0', '1']),
    );

    // At least one panel target must reference process_idx + the showSubProc gate.
    const targets = (parsed.panels ?? []).flatMap(
      (p: { targets?: Array<{ expr?: string }> }) => p.targets ?? [],
    );
    const gated = targets.filter(
      (t: { expr?: string }) =>
        typeof t.expr === 'string'
        && t.expr.includes('process_idx')
        && t.expr.includes('${showSubProc:raw}'),
    );
    expect(gated.length).toBeGreaterThan(0);
  });
});
