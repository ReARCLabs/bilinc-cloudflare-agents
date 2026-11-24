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
