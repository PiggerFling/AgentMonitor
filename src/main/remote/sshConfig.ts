import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshDestinationProblem } from './config';

/** A concrete `Host` alias from ~/.ssh/config with the HostName/User/Port ssh would use for it (when set). */
export interface SshHost { alias: string; hostName?: string; user?: string; port?: number }

/** Returns the contents of the files an `Include` argument names, in order; unreadable files are left out. */
export type SshIncludeReader = (pattern: string) => string[];

interface Block { patterns: string[]; options: Map<string, string> }

/** ssh's own nesting limit for Include. */
const MAX_DEPTH = 16;

/** Splits a config line into words like ssh's argv_split: whitespace separated, '…' and "…" quoting, `#` word starts a comment. */
function words(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length || line[i] === '#') break;
    let word = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const quote = line[i];
      if (quote === '"' || quote === "'") {
        const end = line.indexOf(quote, i + 1);
        if (end < 0) return [];
        word += line.slice(i + 1, end);
        i = end + 1;
      } else word += line[i++];
    }
    out.push(word);
  }
  return out;
}

/** Splits `Keyword args`, `Keyword=args` or `Keyword = args`; the keyword is lowercased. */
function keywordLine(raw: string): { keyword: string; args: string[] } | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return undefined;
  const match = /^([^\s=]+)\s*(?:=\s*|\s)(.*)$/.exec(line) ?? /^([^\s=]+)()$/.exec(line);
  if (!match) return undefined;
  return { keyword: match[1].toLowerCase(), args: words(match[2]) };
}

const glob = (pattern: string, flags = '') => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, flags);

/** ssh pattern-list semantics: some positive pattern matches and no negated (`!`) one does. */
function matches(patterns: string[], alias: string): boolean {
  let hit = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (!glob(negated ? pattern.slice(1) : pattern, 'i').test(alias)) continue;
    if (negated) return false;
    hit = true;
  }
  return hit;
}

/**
 * Lists the concrete hosts of an ssh config: every `Host` alias without `*`, `?` or `!`, deduplicated in file order.
 * HostName, User and Port are resolved like ssh does (first value from the blocks that match the alias, `%h` and `%%`
 * expanded in HostName). `Match` blocks cannot be evaluated here, so their contents are ignored. `Include` arguments
 * are passed to `include`, which returns the included files' contents; Includes inside a Host block are read in place.
 */
export function parseSshConfig(text: string, include: SshIncludeReader = () => []): SshHost[] {
  const global: Block = { patterns: ['*'], options: new Map() };
  const blocks: Block[] = [global];
  const aliases: string[] = [];
  const parse = (source: string, start: Block | undefined, depth: number) => {
    // undefined = inside a Match block: options are skipped until the next Host/Match.
    let block = start;
    for (const raw of source.split(/\r?\n/)) {
      const parsed = keywordLine(raw);
      if (!parsed) continue;
      const { keyword, args } = parsed;
      if (keyword === 'host') {
        block = { patterns: args, options: new Map() };
        blocks.push(block);
        aliases.push(...args.filter(alias => !/[*?!]/.test(alias)));
      } else if (keyword === 'match') block = undefined;
      else if (keyword === 'include') {
        if (depth >= MAX_DEPTH) continue;
        for (const pattern of args) for (const content of include(pattern)) parse(content, block, depth + 1);
      } else if (block && args.length && !block.options.has(keyword)) block.options.set(keyword, args[0]);
    }
  };
  parse(text, global, 0);
  const seen = new Set<string>();
  const hosts: SshHost[] = [];
  for (const alias of aliases) {
    if (seen.has(alias) || sshDestinationProblem(alias)) continue;
    seen.add(alias);
    const option = (name: string) => blocks.find(block => block.options.has(name) && matches(block.patterns, alias))?.options.get(name);
    const hostName = option('hostname')?.replace(/%(%|h)/g, (_, token: string) => token === 'h' ? alias : '%');
    const user = option('user');
    const port = Number(option('port'));
    hosts.push({ alias, ...(hostName ? { hostName } : {}), ...(user ? { user } : {}), ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}) });
  }
  return hosts;
}

/** Expands `*` and `?` in each path segment of an absolute path, sorted like glob(3). */
function expand(pattern: string): string[] {
  const { root } = path.parse(pattern);
  let paths = [root];
  for (const segment of pattern.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!/[*?]/.test(segment)) { paths = paths.map(base => path.join(base, segment)); continue; }
    const regex = glob(segment);
    paths = paths.flatMap(base => {
      try { return readdirSync(base).filter(name => regex.test(name) && (!name.startsWith('.') || segment.startsWith('.'))).sort().map(name => path.join(base, name)); } catch { return []; }
    });
  }
  return paths;
}

/**
 * Reads `<home>/.ssh/config` and its Includes (relative paths resolve against `<home>/.ssh`, `~/` against home,
 * globs expanded). A missing config means no hosts.
 */
export function loadSshHosts(home = os.homedir()): SshHost[] {
  const sshDir = path.join(home, '.ssh');
  const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
  const text = read(path.join(sshDir, 'config'));
  if (text === undefined) return [];
  return parseSshConfig(text, pattern => {
    const absolute = pattern.startsWith('~/') ? path.join(home, pattern.slice(2)) : path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
    return expand(absolute).map(read).filter((content): content is string => content !== undefined);
  });
}
