import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { checkCredentials, checkSignature, finalizeRelease, notarizeDmg, verifyApp } from '../desktop/scripts/macos-release.mjs';

const env = {
  CSC_LINK: 'test-certificate', CSC_KEY_PASSWORD: 'test-key-password', APPLE_ID: 'test@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'test-apple-password', APPLE_TEAM_ID: 'A1B2C3D4E5',
};
const signature = `Authority=Developer ID Application: Example\nTeamIdentifier=${env.APPLE_TEAM_ID}\nCodeDirectory flags=0x10000(runtime)\nTimestamp=Oct 24, 2026\n`;
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pith-release-test-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3', build: { productName: 'pith' } }));
  for (const arch of ['arm64', 'x64']) {
    for (const ext of ['zip', 'dmg']) writeFileSync(join(dir, 'dist', `pith-1.2.3-${arch}.${ext}`), 'package');
  }
  return dir;
}

function fakeRun(file: string, args: string[]) {
  if (file === 'codesign' && args[0] === '--display') return signature;
  if (file === '/usr/libexec/PlistBuddy') return '1.2.3\n';
  if (file === 'lipo') return 'arm64 x86_64\n';
  if (file === 'spctl') return 'accepted\nsource=Notarized Developer ID\n';
  if (args[0] === 'notarytool') return JSON.stringify({ status: 'Accepted', id: 'test-submission' });
  return '';
}

describe('macOS release gates', () => {
  it('allows branch validation but only permits publishing a matching version tag', () => {
    const require = createRequire(new URL('../desktop/package.json', import.meta.url));
    const { load } = require('js-yaml');
    const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8'));
    const guard = workflow.jobs.prepare.steps.find(step => step.run).run;
    const { version } = JSON.parse(readFileSync('desktop/package.json', 'utf8'));
    for (const [publish, type, ref, accepted] of [
      ['false', 'branch', 'feat/test-signing', true],
      ['true', 'branch', 'main', false],
      ['true', 'tag', 'v0.0.0-wrong', false],
      ['true', 'tag', `v${version}`, true],
    ] as const) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', guard], {
        env: { ...process.env, SHOULD_PUBLISH: publish, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: ref },
        encoding: 'utf8',
      });
      expect(result.status === 0).toBe(accepted);
    }
  });

  it('rejects missing credentials and disabled signing without exposing values', () => {
    expect(() => checkCredentials({ ...env, CSC_KEY_PASSWORD: '' })).toThrow('Missing release secrets: CSC_KEY_PASSWORD');
    expect(() => checkCredentials({ ...env, APPLE_TEAM_ID: 'wrong-id' })).toThrow('10-character Team ID');
    expect(() => checkCredentials({ ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toThrow('disabled');
    expect(() => checkCredentials(env)).not.toThrow();
  });

  it('blocks publication without release notes while allowing validation builds', () => {
    const require = createRequire(new URL('../desktop/package.json', import.meta.url));
    const workflow = require('js-yaml').load(readFileSync('.github/workflows/release.yml', 'utf8'));
    const guard = workflow.jobs.prepare.steps.find(step => step.run).run;
    const dir = makeFixture();
    mkdirSync(join(dir, 'desktop'));
    writeFileSync(join(dir, 'desktop/package.json'), JSON.stringify({ version: '1.2.3' }));
    const runGuard = (publish: boolean) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', guard], {
      cwd: dir,
      env: { ...process.env, SHOULD_PUBLISH: String(publish), GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' },
      encoding: 'utf8',
    }).status;
    expect(runGuard(false)).toBe(0);
    expect(runGuard(true)).not.toBe(0);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/release-v1.2.3.md'), '  \n');
    expect(runGuard(true)).not.toBe(0);
    writeFileSync(join(dir, 'docs/release-v1.2.3.md'), 'Release notes');
    expect(runGuard(true)).toBe(0);
  });

  it('requires the correct Developer ID, Hardened Runtime and timestamp', () => {
    expect(() => checkSignature('Signature=adhoc', env.APPLE_TEAM_ID)).toThrow('Developer ID');
    expect(() => checkSignature(signature, 'Z9Z9Z9Z9Z9')).toThrow('Team ID');
    expect(() => checkSignature(signature.replace('(runtime)', '(none)'), env.APPLE_TEAM_ID)).toThrow('Hardened Runtime');
    expect(() => checkSignature(signature.replace(/^Timestamp=.*\n/m, ''), env.APPLE_TEAM_ID)).toThrow('timestamp');
    expect(() => checkSignature(signature, env.APPLE_TEAM_ID)).not.toThrow();
  });

  it('rejects wrong version, wrong CPU, missing tickets and non-notarized Gatekeeper results', () => {
    expect(() => verifyApp('/test.app', 'arm64', env.APPLE_TEAM_ID, '9.9.9', fakeRun)).toThrow('version');
    expect(() => verifyApp('/test.app', 'arm64', env.APPLE_TEAM_ID, '1.2.3', (file, args) => file === 'lipo' ? 'x86_64' : fakeRun(file, args))).toThrow('arm64');
    expect(() => verifyApp('/test.app', 'arm64', env.APPLE_TEAM_ID, '1.2.3', (file, args) => {
      if (args[0] === 'stapler') throw new Error('No ticket');
      return fakeRun(file, args);
    })).toThrow('No ticket');
    expect(() => verifyApp('/test.app', 'arm64', env.APPLE_TEAM_ID, '1.2.3', (file, args) => file === 'spctl' ? 'accepted\nsource=Developer ID' : fakeRun(file, args))).toThrow('Gatekeeper');
  });

  it('does not staple rejected or pending notarizations', () => {
    for (const status of ['Invalid', 'In Progress']) {
      const calls: string[][] = [];
      expect(() => notarizeDmg('/test.dmg', env, (_file, args) => {
        calls.push(args);
        return JSON.stringify({ status, id: 'submission' });
      })).toThrow('DMG notarization failed');
      expect(calls).toHaveLength(1);
    }
  });

  it('checks both formats/CPUs and writes checksums only after every check passes', async () => {
    const dir = makeFixture();
    const calls: [string, string[]][] = [];
    await finalizeRelease(dir, env, (file, args) => {
      calls.push([file, args]);
      return fakeRun(file, args);
    });
    expect(calls.filter(([file, args]) => file === 'codesign' && args.includes('--deep'))).toHaveLength(4);
    expect(calls.filter(([, args]) => args[0] === 'notarytool')).toHaveLength(2);
    expect(calls.filter(([file, args]) => file === 'hdiutil' && args[0] === 'detach')).toHaveLength(2);
    const sums = readFileSync(join(dir, 'dist/macos-SHA256SUMS.txt'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(4);
    expect(sums.every(line => /^[a-f0-9]{64}  pith-1\.2\.3-(arm64|x64)\.(zip|dmg)$/.test(line))).toBe(true);
  });

  it('unmounts on verification failure and never writes success checksums', async () => {
    const dir = makeFixture();
    let mounted = false;
    let detached = false;
    await expect(finalizeRelease(dir, env, (file, args) => {
      if (file === 'hdiutil' && args[0] === 'attach') mounted = true;
      if (file === 'hdiutil' && args[0] === 'detach') detached = true;
      if (mounted && file === 'codesign' && args.includes('--deep')) throw new Error('Tampered app');
      return fakeRun(file, args);
    })).rejects.toThrow('Tampered app');
    expect(detached).toBe(true);
    expect(() => readFileSync(join(dir, 'dist/macos-SHA256SUMS.txt'))).toThrow();
  });

  it('fails before contacting Apple if any required artifact is missing', async () => {
    const dir = makeFixture();
    rmSync(join(dir, 'dist/pith-1.2.3-x64.zip'));
    let called = false;
    await expect(finalizeRelease(dir, env, () => { called = true; return ''; })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('loads and validates the release configuration with the installed electron-builder', async () => {
    const require = createRequire(new URL('../desktop/package.json', import.meta.url));
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
    const { DebugLogger } = require('builder-util');
    const config = await getConfig(join(process.cwd(), 'desktop'), 'electron-builder.mac-release.cjs');
    await validateConfiguration(config, new DebugLogger(false));
    expect(config.mac.identity).toBeUndefined();
    expect(config.mac.forceCodeSigning).toBe(true);
    expect(config.mac.notarize).toBe(true);
    expect(config.dmg.writeUpdateInfo).toBe(false);
  });
});
