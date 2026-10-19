// Copies ../skills into skills/: the agent prompts and skills bundled with the extension.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(here, '..', 'skills');
const to = join(here, 'skills');
if (!existsSync(from)) {
  console.error(`no skills at ${from}`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} → ${to}`);
