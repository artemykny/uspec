// Document templates (docs/method/node-types/rules.md#rules): frontmatter, body, and what is left of
// the body in a document.

/** Splits a Markdown file into its YAML frontmatter and body, as the CLI does. */
export function splitFrontmatter(text: string): { front: string | undefined; body: string } {
  const m = text.match(/^---\r?\n/);
  if (!m) return { front: undefined, body: text };
  const rest = text.slice(m[0].length);
  let offset = 0;
  for (const line of rest.split(/(?<=\n)/)) {
    if (line.trimEnd() === '---') {
      return { front: rest.slice(0, offset), body: rest.slice(offset + line.length).replace(/^[\r\n]+/, '') };
    }
    offset += line.length;
  }
  return { front: undefined, body: text };
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();

/** A document nobody has written yet: empty, or still the template's body. */
export function isUnwritten(doc: string, templateBody: string | undefined): boolean {
  const d = norm(doc);
  return d === '' || (templateBody !== undefined && d === norm(templateBody));
}

/** Guidance in a template: text in angle brackets, such as `<Service>`, that is replaced when the document is written. */
const GUIDANCE = /<[^<>\n]*[A-Za-z][^<>\n]*>/;

/** Lines of `doc` that are still guidance lines of the template's body, as 0-based line numbers. */
export function leftoverGuidance(doc: string, templateBody: string): number[] {
  const guidance = new Set(
    templateBody
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && GUIDANCE.test(l)),
  );
  if (!guidance.size) return [];
  const out: number[] = [];
  doc.split(/\r?\n/).forEach((l, i) => {
    if (guidance.has(l.trim())) out.push(i);
  });
  return out;
}

/** The guidance lines of the change template that `uspec change new` writes into `change.md`. */
const CHANGE_GUIDANCE = [
  '# <Title: the change in a few words>',
  '<The problem, and who has it.>',
  '<The new behaviour, rule by rule: every case it touches, and what stays as it is. The constraints that apply.>',
  '<What this change doesn’t do.>',
  "<What this change doesn't do.>",
];

/** Whether `change.md` is empty or still has a guidance line of the change template. */
export function isTemplateLeft(changeMd: string): boolean {
  const lines = changeMd.split(/\r?\n/).map((l) => l.trim());
  return !changeMd.trim() || lines.some((l) => CHANGE_GUIDANCE.includes(l) || l.startsWith('<One or more concrete scenarios'));
}
