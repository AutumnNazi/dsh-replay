import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveNameFor, checksumLine, releaseChecksum } from '../scripts/release.mjs';

test('release checksum uses the standard SHA-256 format', () => {
  assert.equal(checksumLine('bxzy-dsh-replay-0.2.0.tgz', Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  bxzy-dsh-replay-0.2.0.tgz\n');
});

test('checksum filenames reject paths and checksum-line injection', () => {
  for (const filename of ['../release.tgz', 'dir/release.tgz', 'dir\\release.tgz', '..', '', 'release.tgz\nother', 'release.tgz\rother', 'release.tgz\n', 'release.tgz\r', 'C:release.tgz']) {
    assert.throws(() => checksumLine(filename, Buffer.from('abc')), /filename/);
  }
});

test('release checksum derives the scoped npm archive name from package version', () => {
  const bytes = Buffer.from('abc');
  for (const version of ['0.1.0', '0.2.0', '1.2.3-rc.1']) {
    const filename = `bxzy-dsh-replay-${version}.tgz`;
    assert.equal(archiveNameFor({ name: '@bxzy/dsh-replay', version }), filename);
    let line;
    assert.doesNotThrow(() => { line = releaseChecksum({ name: '@bxzy/dsh-replay', version }, filename, bytes); });
    assert.equal(line, checksumLine(filename, bytes));
  }
});

test('release checksum rejects a package-name or archive-version mismatch', () => {
  const pkg = { name: '@bxzy/dsh-replay', version: '0.2.0' };
  const bytes = Buffer.from('abc');
  for (const name of ['dsh-replay', '@other/dsh-replay', '@bxzy/other-plugin', 'other-plugin']) {
    assert.throws(() => releaseChecksum({ ...pkg, name }, 'bxzy-dsh-replay-0.2.0.tgz', bytes), /package.name/);
  }
  for (const filename of ['bxzy-dsh-replay-0.1.0.tgz', 'dsh-replay-0.2.0.tgz', 'other-plugin-0.2.0.tgz', '../bxzy-dsh-replay-0.2.0.tgz', 'bxzy-dsh-replay-0.2.0.tgz\n']) {
    assert.throws(() => releaseChecksum(pkg, filename, bytes), /archive.*bxzy-dsh-replay-0\.2\.0\.tgz/);
  }
});

test('release checksum rejects invalid or unsafe package versions', () => {
  for (const version of ['', 'v0.2.0', '0.2', '0.2.0\n', '../0.2.0', '01.2.0', '0.02.0', '0.2.00', '0.2.0-01', '0.2.0-rc..1', '0.2.0-rc.', undefined]) {
    assert.throws(() => releaseChecksum({ name: '@bxzy/dsh-replay', version }, 'bxzy-dsh-replay-0.2.0.tgz', Buffer.from('abc')), /package.version/);
  }
});
