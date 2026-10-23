import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function checksumLine(filename, bytes) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
    throw new Error('Invalid checksum filename: use a plain basename without paths or control characters.');
  }
  return `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`;
}

export function archiveNameFor(pkg) {
  if (pkg?.name !== '@bxzy/dsh-replay') throw new Error('Expected package.name to be @bxzy/dsh-replay.');
  if (typeof pkg.version !== 'string' || pkg.version !== pkg.version.trim() || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*)?$/.test(pkg.version)) {
    throw new Error('Invalid package.version for a release archive.');
  }
  return `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`;
}

export function releaseChecksum(pkg, filename, bytes) {
  const expected = archiveNameFor(pkg);
  if (filename !== expected) throw new Error(`Expected archive filename ${expected}.`);
  return checksumLine(filename, bytes);
}

async function main() {
  const { values } = parseArgs({ options: { archive: { type: 'string' }, out: { type: 'string' } } });
  if (!values.archive) throw new Error('Usage: node scripts/release.mjs --archive <verified-package.tgz> [--out <directory>]');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const archive = resolve(values.archive);
  const line = releaseChecksum(pkg, basename(archive), await readFile(archive));
  const out = values.out ? resolve(values.out) : fileURLToPath(new URL('../work/release/', import.meta.url));
  await mkdir(out, { recursive: true });
  const sums = join(out, 'SHA256SUMS.txt');
  await writeFile(sums, line, 'utf8');
  console.log(`Checksum written: ${sums}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
