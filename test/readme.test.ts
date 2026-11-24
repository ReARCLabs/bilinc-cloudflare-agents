import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const visible = readme.replace(/<!--[\s\S]*?-->/g, '');
const UTM = 'utm_source=github&utm_medium=readme&utm_campaign=bilinc-cloudflare-agents';
const BUTTON_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/ReARCLabs/bilinc-cloudflare-agents/tree/main/template';
const TOOLS = [
  'bilinc_checkpoint',
  'bilinc_checkpoints',
  'bilinc_diff',
  'bilinc_history',
  'bilinc_forget',
  'bilinc_rollback_preview',
  'bilinc_rollback',
];

function section(name: string): string {
  const start = readme.indexOf(`\n## ${name}\n`);
  expect(start, `section "${name}"`).toBeGreaterThan(-1);
  const next = readme.indexOf('\n## ', start + 1);
  return next === -1 ? readme.slice(start) : readme.slice(start, next);
}

describe('README', () => {
  it('has the spec sections in order', () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      'Deploy the template',
      'Install',
      'Usage',
      'Get an API key',
      'Options',
      'What the model sees',
      'Tools and approvals',
      'Credits',
      'Errors',
      'Single-tenant only',
      'Limitations',
      'Compatibility',
      'Data and privacy',
      'Development',
      'License',
    ]);
  });

  it('states single-tenant use and the Cloudflare disclaimer above the sections', () => {
    const intro = readme.slice(0, readme.indexOf('\n## '));
    expect(intro).toContain('**Single-tenant only.** One deployment uses one dedicated Bilinc account');
    expect(intro).toContain('Not affiliated with or endorsed by Cloudflare.');
    expect(intro).toContain('Versioned memory for Cloudflare Agents: history, checkpoints, diff and rollback.');
  });

  it('tags every bilinc.space link with the README campaign', () => {
    const links = [...visible.matchAll(/\]\((https:\/\/bilinc\.space[^)]*)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) expect(link).toContain(UTM);
    expect(visible).toContain(`https://bilinc.space/signup?next=/api-keys&${UTM}`);
  });

  it('keeps the Deploy button in a comment until the repository is public', () => {
    expect(readme).toContain(`[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${BUTTON_URL})`);
    expect(visible).not.toContain('deploy.workers.cloudflare.com');
    expect(visible).toContain(
      'The one-click Deploy to Cloudflare button is in the [GitHub README](https://github.com/ReARCLabs/bilinc-cloudflare-agents#deploy-the-template).',
    );
  });

  it('names both key sources and the dedicated account', () => {
    const text = section('Get an API key');
    expect(text).toContain('**dedicated Bilinc account**');
    expect(text).toContain('`bilinc login`');
    expect(text).toContain(`https://bilinc.space/api-keys?${UTM}`);
  });

  it('documents all seven tools and the two approvals', () => {
    const text = section('Tools and approvals');
    for (const tool of TOOLS) expect(text).toContain(`| \`${tool}\` |`);
    expect(text.match(/\| every time \|/g)).toHaveLength(2);
  });

  it('lists the credit cost of every call and both free limits with sources', () => {
    const text = section('Credits');
    for (const row of [
      '| `search_context` (recall) | 1 |',
      '| `set_context` (commit) | 1 |',
      '| `bilinc_forget` | 1 |',
      '| `bilinc_checkpoint` | 2 |',
      '| `bilinc_rollback` | 2, only when it succeeds |',
      '| Automatic checkpoint, once per new chat (template) | 2 |',
      '| Memory summary, `bilinc_checkpoints`, `bilinc_diff`, `bilinc_history`, `bilinc_rollback_preview`, `checkStatus()` | 0 |',
    ]) {
      expect(text).toContain(row);
    }
    expect(text).toContain('returns to the last chat instead of starting a new one');
    expect(text).toContain('2,000 credits a month');
    expect(text).toContain(`https://bilinc.space/pricing?${UTM}`);
    expect(text).toContain('10,000 neurons a day');
    expect(text).toContain('https://developers.cloudflare.com/workers-ai/platform/pricing/');
  });

  it('lists every limitation from the spec', () => {
    const text = section('Limitations');
    for (const phrase of [
      'Saving without a title creates a new entry instead of a new version.',
      '"İş" and "İç" are the same key `i`',
      'the newest 10 keys are shown to the model',
      'Checkpoints are project-wide',
      'Changing `BILINC_NAMESPACE` starts from an empty memory',
      'There is no list of past chats',
      '`write`, `edit` and `delete` run without approval',
      '5 wrong attempts from one IP',
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it('documents checkStatus and every option', () => {
    const text = section('Options');
    for (const option of ['apiKey', 'namespace', 'agentId', 'sessionId', 'baseUrl', 'profile', 'limit', 'maxChars', 'onError']) {
      expect(text).toContain(`| \`${option}\` |`);
    }
    expect(text).toContain('checkStatus(');
  });

  it('links the privacy policy, terms and subprocessors', () => {
    const text = section('Data and privacy');
    for (const url of ['https://bilinc.space/privacy', 'https://bilinc.space/terms', 'https://bilinc.space/legal/subprocessors']) {
      expect(text).toContain(url);
    }
  });

  it('says local development needs a Cloudflare login', () => {
    expect(section('Development')).toContain('Local development needs a Cloudflare login (`npx wrangler login`)');
  });

  it('makes no claim the spec rules out', () => {
    expect(visible).not.toMatch(/\bofficial\b|\bpartner\b|reference implementation/i);
    expect([...visible.matchAll(/\bfirst\b(?! 60)/gi)]).toEqual([]);
  });
});
