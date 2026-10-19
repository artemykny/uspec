// The spec side of a change with the real Claude Code (USPEC_LIVE=1): triage and writers, recorded
// through the CLI. It stops before implementation, which would write the example's services.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentRun } from '../../agents';
import type { NextJson } from '../../core/model';
import { nodeKey } from '../../core/paths';
import type { UspecApi } from '../../extension';

const work = process.env.USPEC_TEST_WORKSPACE!;
const file = (rel: string) => path.join(work, ...rel.split('/'));

describe('uspec agents with Claude Code', () => {
  it('triages and writes the refund-window change', async () => {
    const api = await vscode.extensions.getExtension<UspecApi>('uspec.uspec')!.activate();
    await api.ready;
    const p = api.manager.projects[0];
    const c = 'refund-window';
    await api.manager.mutate(p, ['change', 'new', c]);
    fs.writeFileSync(
      file(`.uspec/changes/${c}/change.md`),
      '# Refund window: 30 days\n\n## Why\n\nValid claims are refused after 14 days.\n\n## What changes\n\nCustomers can request a refund within 30 days of delivery instead of 14.\n\n' +
        '## Worked example\n\nAn order is delivered on 1 March; a refund requested on 20 March is accepted (before: refused).\n',
    );
    const rules = file('docs/product/support/refunds/rules.md');
    fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace('14 days', '30 days'));
    await api.manager.load(p);
    await vscode.commands.executeCommand('uspec.change.recordUpdated', { kind: 'doc', p, node: 'product/support/refunds', doc: 'rules' });

    const runs: AgentRun[] = [];
    for (let round = 0; round < 6; round++) {
      const next = await api.manager.json<NextJson>(p, ['change', 'next', c]);
      if (!next.triage && !next.write.length) break;
      const jobs: Promise<AgentRun | undefined>[] = [];
      if (next.triage) jobs.push(api.agents.runTriage(p, c, next));
      // One writer per node, on its documents to write.
      for (const w of next.write) jobs.push(api.agents.runWriter(p, c, nodeKey(w.node), w.documents.map((d) => d.document)));
      for (const r of await Promise.all(jobs)) if (r) runs.push(r);
    }
    for (const r of runs) {
      console.log(`\n${r.title}: ${r.state} — ${r.outcome} (${r.costUsd?.toFixed(2)} USD)\n${r.log.join('\n')}`);
    }
    assert.ok(runs.length > 0);
    for (const r of runs) assert.strictEqual(r.state, 'recorded', `${r.title} ended ${r.state}: ${r.outcome}`);
    await api.manager.load(p);
    const data = p.change(c)!;
    assert.strictEqual(data.docs.get('system/services/payments/logic.md')?.state, 'updated');
    assert.match(fs.readFileSync(file('docs/system/services/payments/logic.md'), 'utf8'), /30 days/);
    assert.strictEqual(data.counts.pending + data.counts.affected, 0);
    assert.strictEqual(data.impl.get('system/services/payments'), 'pending');
  });
});
