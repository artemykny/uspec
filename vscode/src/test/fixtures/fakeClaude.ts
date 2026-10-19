// A stand-in for interactive `claude` and `codex` in the integration tests: takes the prompt after `--`,
// answers in the role's output format, reports it through the hooks a real agent calls, and edits what
// a real agent would.
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';

const args = process.argv.slice(2);
const codex = !args.includes('--settings');
const log = process.env.FAKE_CLAUDE_LOG;
const input = args.at(-1) ?? '';
const sessionId = args.includes('resume') ? args[args.indexOf('resume') + 1] : args.includes('--resume') ? args[args.indexOf('--resume') + 1] : `fake-${process.pid}`;

/** Calls the hooks: Claude Code's from `--settings`, Codex's `notify` program. */
function hook(event: string, fields: object): void {
  if (codex) {
    if (event !== 'Stop') return;
    const notify = JSON.parse(args.find((a) => a.startsWith('notify='))!.slice('notify='.length)) as string[];
    spawnSync(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': sessionId, ...fields })]);
    return;
  }
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  for (const h of settings.hooks[event] ?? []) for (const c of h.hooks) execSync(c.command, { input: JSON.stringify({ hook_event_name: event, session_id: sessionId, ...fields }) });
}

function finish(result: string, _sessionId: string): void {
  process.stdout.write(result + '\n');
  hook('Stop', codex ? { 'last-assistant-message': result } : { last_assistant_message: result });
}

function main(): void {
  hook('SessionStart', {});
  const role = /splitter agent/.test(input) ? 'splitter' : /impact agent/.test(input)
    ? 'impact'
    : /triage agent/.test(input)
      ? 'triage'
      : /writer agent/.test(input)
        ? 'writer'
        : /planner agent/.test(input)
          ? 'planner'
          : /implementer agent/.test(input)
            ? 'implementer'
            : 'reviewer';
  if (log) fs.appendFileSync(log, JSON.stringify({ role, args, input }) + '\n');

  if (role === 'impact') {
    // The change starts at the refund rules, as change.md says; the tree is in the input.
    const ok = /^Change: \.uspec\/changes\/[\w-]+\/change\.md$/m.test(input) && input.includes('refunds/  feature');
    finish(ok ? 'docs/product/support/refunds/rules.md | The Refund window section says 14 days.\n\nNotes:\n- none' : 'No change.md or tree in the input.', sessionId);
    return;
  }
  if (role === 'splitter') {
    const nodes = (input.split('\nNodes to plan:\n')[1] ?? '').split('\n\n')[0].split('\n').filter(Boolean);
    finish('# Split plans\n\n## Plans\n\n' + nodes.map(node => `### plans/${node.split('/').pop()}.md\n- Nodes: ${node}\n- After:\n- Reason: Independent component.\n`).join('\n'), sessionId);
    return;
  }
  if (role === 'planner') {
    // One plan per node to plan, named after the node; links between them order them.
    const dir = input.match(/^Plans: (.+)$/m)?.[1] ?? '';
    const nodes = (input.split('\nNodes to plan:\n')[1] ?? '').split('\n\n')[0].split('\n').filter(Boolean);
    fs.mkdirSync(dir, { recursive: true });
    const lines = nodes.map((node) => {
      const id = node.split('/').pop()!;
      fs.writeFileSync(path.join(dir, `${id}.md`), `---\nnodes: [${node}]\n---\n\n# ${id}\n\n## Steps\n\n1. Use the 30-day window.\n`);
      return `${id} | ${node} | after: none`;
    });
    finish(`planned\n${lines.join('\n')}`, sessionId);
    return;
  }
  if (role === 'triage') {
    // Candidates are the lines under `batch:`: `    <path>   <rules>`.
    const batch = input.split('\n  batch:\n')[1] ?? '';
    const lines = batch
      .split('\n')
      .map((l) => l.trim().split(/\s{2,}/)[0])
      .filter((p) => p.endsWith('.md'))
      .map((p) =>
        (p.endsWith('system/services/payments/logic.md') && !fs.readFileSync(p, 'utf8').includes('30 days')) ||
        // Two documents of one node, ready together: they get one writer.
        p.endsWith('system/services/payments/api.md') ||
        p.endsWith('system/services/payments/compliance.md') ||
        (p.endsWith('experience/ops-console/refunds/states.md') && !fs.readFileSync(p, 'utf8').includes('30 days'))
          ? `${p} | affected | The eligibility rule says 14 days.`
          : `${p} | no-change | The document doesn't depend on the refund window.`,
      );
    finish(`${lines.join('\n')}\n\nNotes:\n- none`, sessionId);
    return;
  }
  if (role === 'writer') {
    // The documents are the files under `document:`, in order; `-extra/` folders are listed with them.
    const group = input.split('\ndocument:\n')[1]?.split(/\n(?! {2})/)[0] ?? '';
    const docs = group
      .split('\n')
      .map((l) => l.trim().split(/\s{2,}/)[0])
      .filter((p) => p.endsWith('.md'));
    if (!docs.length) {
      finish('blocked\nNo document in the context.', sessionId);
      return;
    }
    // The refund rules change their window section; logic.md, compliance.md and states.md get the new
    // window; anything else doesn't mention it.
    const results = docs.map((doc) => {
      const rules = doc.endsWith('refunds/rules.md') && fs.readFileSync(doc, 'utf8').includes('14 days');
      if (!rules && !/(logic|compliance|states)\.md$/.test(doc)) return `${doc}\nno change\nThe document doesn't mention the refund window.`;
      if (rules) fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('14 days', '30 days'));
      else fs.appendFileSync(doc, '\nRefunds can be requested within 30 days.\n');
      return `${doc}\nupdated\nThe refund window is 30 days.\nuser-visible: yes`;
    });
    finish(results.join('\n\n'), sessionId);
    return;
  }
  if (role === 'implementer') {
    const mode = input.match(/^Mode: (\w+)$/m)?.[1];
    const plan = input.match(/^Plan: (.+)$/m)?.[1];
    if (!plan || !fs.existsSync(plan)) {
      finish('failed\nNo plan in the input.', sessionId);
      return;
    }
    finish(`done\nChanged: nothing (fake, mode ${mode}, ${plan})\nVerified: fake`, sessionId);
    return;
  }
  finish('No findings.', sessionId);
}

main();
