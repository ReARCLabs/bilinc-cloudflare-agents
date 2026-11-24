import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const templatePackage = JSON.parse(readFileSync(new URL('../template/package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};
const lockText = readFileSync(new URL('../template/package-lock.json', import.meta.url), 'utf8');
const lock = JSON.parse(lockText) as { packages: Record<string, { version?: string; resolved?: string }> };

describe('release 0.1.0 wiring of the template', () => {
  it('depends on the published range', () => {
    expect(templatePackage.dependencies['bilinc-cloudflare-agents']).toBe('^0.1.0');
  });

  it('resolves the package from the npm registry, with no local tarball left', () => {
    const entry = lock.packages['node_modules/bilinc-cloudflare-agents'];
    expect(entry?.version).toBe('0.1.0');
    expect(entry?.resolved).toBe('https://registry.npmjs.org/bilinc-cloudflare-agents/-/bilinc-cloudflare-agents-0.1.0.tgz');
    expect(lockText).not.toContain('file:../bilinc-cloudflare-agents');
  });

  it('keeps the SDK pins of release 0.1.0', () => {
    expect(lock.packages['node_modules/agents']?.version).toBe('0.34.0');
    expect(lock.packages['node_modules/@cloudflare/think']?.version).toBe('0.24.0');
  });
});

describe('release 0.1.1 (template only)', () => {
  const wrangler = JSON.parse(readFileSync(new URL('../template/wrangler.jsonc', import.meta.url), 'utf8')) as {
    vars: { MODEL: string; MODELS: { id: string; tag: string }[] };
  };
  const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

  it('keeps the npm package at 0.1.0 (the next publish is 0.1.2)', () => {
    expect(rootPackage.version).toBe('0.1.0');
  });

  it('ships only models that passed G4, with gpt-oss-120b as the default and first', () => {
    expect(wrangler.vars.MODEL).toBe('@cf/openai/gpt-oss-120b');
    expect(wrangler.vars.MODELS[0]?.id).toBe(wrangler.vars.MODEL);
    expect(wrangler.vars.MODELS.map((m) => m.id)).toEqual(['@cf/openai/gpt-oss-120b']);
  });
});
