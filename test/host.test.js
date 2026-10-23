import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import * as rootHost from '../src/host.js';
import * as historyHost from '../src/components/history.js';
import * as retryHost from '../src/components/retry.js';

const root = new URL('../', import.meta.url);

test('one package exposes two native Host identities with one grouped browser carrier', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.equal(pkg.name, 'dsh-replay');
  assert.deepEqual([rootHost.name, historyHost.name, retryHost.name], ['dsh-replay', 'dsh-replay/history', 'dsh-replay/retry']);
  for (const host of [rootHost, historyHost, retryHost]) assert.equal(typeof host.apply, 'function');
  assert.equal((patch.match(/group: true/g) ?? []).length, 1);
  assert.equal((patch.match(/    - id:/g) ?? []).length, 3);
  assert.ok(!patch.includes('disabled:'), 'two child entries initially enabled');
  assert.equal(pkg.exports['./history'], './lib/history-host.js');
  assert.equal(pkg.exports['./retry'], './lib/retry-host.js');
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
  assert.deepEqual(pkg.author, { name: 'AutumnNazi', email: '104422820+AutumnNazi@users.noreply.github.com' });
  assert.equal(pkg.repository.url, 'git+https://github.com/AutumnNazi/dsh-replay.git');
  assert.equal(pkg.license, undefined);
  assert.equal(pkg.dependencies, undefined);
});

test('all exported locale metadata share complete keys and native component names', async () => {
  const expected = [['', 'Re:Play', '回言'], ['history/', 'Input History', '输入历史'], ['retry/', 'Prompt Replay', '消息重试']];
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const [prefix, enTitle, zhTitle] of expected) {
    const path = pkg.exports['./' + prefix + 'locale/*.json'];
    const en = JSON.parse(await readFile(new URL(path.replace('*', 'en'), root), 'utf8'));
    const zh = JSON.parse(await readFile(new URL(path.replace('*', 'zh-cn'), root), 'utf8'));
    assert.equal(en.meta.title, enTitle); assert.equal(zh.meta.title, zhTitle);
    assert.deepEqual(Object.keys(en.meta), ['title', 'description']); assert.deepEqual(Object.keys(en.meta), Object.keys(zh.meta));
    assert.ok(en.meta.description.length > 0 && zh.meta.description.length > 0);
  }
});

test('retired settings files and storage APIs are absent without touching old browser storage', async () => {
  for (const path of ['src/settings.js', 'src/settings-react.js', 'src/settings-page.js', 'test/settings.test.js']) await assert.rejects(stat(new URL(path, root)), { code: 'ENOENT' });
  for (const path of ['src/client.js', 'src/component-controller.js', 'src/history-client.js', 'src/retry-client.js']) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.ok(!/localStorage|sessionStorage|settings.section|runtimeMemory/.test(source));
  }
});
