import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const secretNames = [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
];

export function checkCredentials(env = process.env) {
  const missing = secretNames.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing release secrets: ${missing.join(', ')}`);
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('APPLE_TEAM_ID must be a 10-character Team ID');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('Code signing discovery is disabled');
}

function redact(text) {
  for (const name of secretNames) {
    if (process.env[name]) text = text.split(process.env[name]).join('[redacted]');
  }
  return text;
}

// Never include command arguments in errors: notarytool receives credentials.
function run(file, args, timeout = 120_000) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(file)} failed (${result.error?.code ?? result.status}): ${redact(output)}`);
  }
  return output;
}

export function checkSignature(details, teamId, runtime = true) {
  if (!/^Authority=Developer ID Application:/m.test(details)) throw new Error('Missing Developer ID Application signature');
  if (!details.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`)) throw new Error('Signing Team ID does not match APPLE_TEAM_ID');
  if (runtime && !/^.*flags=.*\bruntime\b/m.test(details)) throw new Error('Hardened Runtime is not enabled');
  if (runtime && !/^Timestamp=.+/m.test(details)) throw new Error('Missing secure signing timestamp');
}

export function verifyApp(app, arch, teamId, version, execute = run) {
  execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  checkSignature(execute('codesign', ['--display', '--verbose=4', app]), teamId);
  const actualVersion = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]).trim();
  if (actualVersion !== version) throw new Error(`Unexpected app version: ${actualVersion}`);
  const cpu = arch === 'x64' ? 'x86_64' : arch;
  const architectures = execute('lipo', ['-archs', join(app, 'Contents/MacOS/pith')]).trim().split(/\s+/);
  if (!architectures.includes(cpu)) throw new Error(`Missing ${cpu} executable in ${app}`);
  execute('xcrun', ['stapler', 'validate', app]);
  const assessment = execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  if (!assessment.includes('source=Notarized Developer ID')) throw new Error('Gatekeeper did not recognize a notarized Developer ID app');
}

export function notarizeDmg(dmg, env = process.env, execute = run) {
  const result = JSON.parse(execute('xcrun', [
    'notarytool', 'submit', dmg,
    '--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', env.APPLE_TEAM_ID, '--wait', '--timeout', '30m', '--output-format', 'json',
  ], 31 * 60_000));
  if (result.status !== 'Accepted') throw new Error(`DMG notarization failed: ${result.status} (submission ${result.id})`);
  console.log(`Notarized ${basename(dmg)} (submission ${result.id})`);
  execute('xcrun', ['stapler', 'staple', dmg]);
  execute('xcrun', ['stapler', 'validate', dmg]);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function finalizeRelease(desktopDir, env = process.env, execute = run) {
  checkCredentials(env);
  const { version, build } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
  const outDir = join(desktopDir, 'dist');
  const artifacts = ['arm64', 'x64'].flatMap(arch => ['zip', 'dmg'].map(ext => ({
    arch, ext, file: join(outDir, `${build.productName}-${version}-${arch}.${ext}`),
  })));
  // Require both architectures and formats before making any notarization requests.
  for (const { file } of artifacts) {
    if (!statSync(file).isFile()) throw new Error(`Missing release artifact: ${file}`);
  }
  for (const { arch, ext, file } of artifacts) {
    const scratch = mkdtempSync(join(tmpdir(), 'pith-release-'));
    const unpacked = join(scratch, 'unpacked');
    mkdirSync(unpacked);
    let mounted = false;
    try {
      if (ext === 'dmg') {
        execute('codesign', ['--verify', '--strict', '--verbose=2', file]);
        checkSignature(execute('codesign', ['--display', '--verbose=4', file]), env.APPLE_TEAM_ID, false);
        notarizeDmg(file, env, execute);
        execute('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', file]);
        execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', unpacked, file]);
        mounted = true;
      } else {
        execute('ditto', ['-x', '-k', file, unpacked]);
      }
      verifyApp(join(unpacked, `${build.productName}.app`), arch, env.APPLE_TEAM_ID, version, execute);
      console.log(`Verified ${basename(file)}: signature, ticket, Gatekeeper, architecture and version`);
    } finally {
      // Do not remove a mountpoint if detaching fails.
      if (mounted) execute('hdiutil', ['detach', unpacked]);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const checksums = await Promise.all(artifacts.map(async ({ file }) => `${await sha256(file)}  ${basename(file)}`));
  writeFileSync(join(outDir, 'macos-SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') throw new Error('macOS release checks must run on macOS');
    if (process.argv[2] === 'check') {
      checkCredentials();
      console.log('All macOS release credentials are present (values are not logged).');
    } else if (process.argv[2] === 'finalize') {
      await finalizeRelease(fileURLToPath(new URL('..', import.meta.url)));
    } else {
      throw new Error('Usage: node scripts/macos-release.mjs check|finalize');
    }
  } catch (error) {
    console.error(redact(error.message));
    process.exitCode = 1;
  }
}
