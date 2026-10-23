import test from 'node:test';
import assert from 'node:assert/strict';
import { createComponentController } from '../src/component-controller.js';

function harness() {
  const active = new Map();
  const starts = [];
  const stops = [];
  const components = Object.fromEntries(['history', 'retry'].map((key) => [key, { inject: [key], apply() {} }]));
  let response = { ok: true, value: { entries: [
    { entryId: 'dsh-replay.history', moduleName: '@bxzy/dsh-replay/history', enabled: true },
    { entryId: 'dsh-replay.retry', moduleName: '@bxzy/dsh-replay/retry', enabled: false },
  ] } };
  const ctx = {
    remote: { pluginInventory: { list: async () => response } },
    plugin(component) {
      const key = Object.keys(components).find((name) => components[name] === component);
      assert.ok(key, 'uses an isolated child plugin');
      starts.push(key); active.set(key, component);
      return { dispose() { stops.push(key); active.delete(key); } };
    },
  };
  return { ctx, components, active, starts, stops, setResponse(value) { response = value; } };
}

test('native history enabled / retry disabled starts only the history fiber', async () => {
  const h = harness();
  const controller = createComponentController(h.ctx, h.components);
  await controller.refresh();
  assert.deepEqual(h.starts, ['history']);
  assert.deepEqual([...h.active.keys()], ['history']);
  await controller.dispose();
  assert.deepEqual(h.stops, ['history']);
});

function inventory(history, retry) {
  return { ok: true, value: { entries: [
    { entryId: 'include:dsh-replay.history', moduleName: '@bxzy/dsh-replay/history', enabled: history },
    { entryId: 'include:dsh-replay.retry', moduleName: '@bxzy/dsh-replay/retry', enabled: retry },
  ] } };
}

test('scoped native inventory ignores unscoped modules with the same stable Entry IDs', async () => {
  const h = harness();
  const scoped = inventory(true, false);
  h.setResponse({ ok: true, value: { entries: [
    ...scoped.value.entries,
    ...inventory(false, true).value.entries.map((entry) => ({ ...entry, moduleName: entry.moduleName.replace('@bxzy/', '') })),
  ] } });
  const controller = createComponentController(h.ctx, h.components);
  await controller.refresh();
  assert.deepEqual(h.starts, ['history']);
  await controller.dispose();
});

test('late native response after root disposal cannot revive either fiber', async () => {
  const h = harness();
  let resolve;
  h.ctx.remote.pluginInventory.list = () => new Promise((done) => { resolve = done; });
  const controller = createComponentController(h.ctx, h.components);
  const request = controller.refresh();
  await controller.dispose();
  resolve({ ok: true, value: { entries: [
    { entryId: 'dsh-replay.history', moduleName: '@bxzy/dsh-replay/history', enabled: true },
    { entryId: 'dsh-replay.retry', moduleName: '@bxzy/dsh-replay/retry', enabled: true },
  ] } });
  await request;
  assert.deepEqual(h.starts, []);
});

for (const [history, retry] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`native combination ${history}/${retry} accepts include-prefixed entry IDs`, async () => {
    const h = harness(); h.setResponse(inventory(history, retry));
    const c = createComponentController(h.ctx, h.components);
    await c.refresh(); await c.refresh();
    assert.deepEqual(h.starts, ['history', 'retry'].filter((k) => k === 'history' ? history : retry));
    await c.dispose(); assert.equal(h.active.size, 0);
  });
}

test('toggle one native component does not dispose the other; reopen registers once', async () => {
  const h = harness(); const c = createComponentController(h.ctx, h.components);
  h.setResponse(inventory(true, true)); await c.refresh();
  const retry = h.active.get('retry');
  h.setResponse(inventory(false, true)); await c.refresh();
  assert.equal(h.active.get('retry'), retry); assert.deepEqual(h.stops, ['history']);
  h.setResponse(inventory(true, true)); await c.refresh(); await c.refresh();
  assert.deepEqual(h.starts, ['history', 'retry', 'history']);
  await c.dispose(); await c.dispose(); assert.equal(h.stops.length, 3);
});

test('invalid, missing, duplicate and RPC failure retain last verified state and warn once', async () => {
  const h = harness(); const c = createComponentController(h.ctx, h.components);
  const warnings = []; const warn = console.warn; console.warn = (...args) => warnings.push(args);
  try {
    h.setResponse({ ok: false }); await c.refresh(); assert.equal(h.starts.length, 0);
    h.setResponse(inventory(true, false)); await c.refresh();
    for (const value of [{ ok: false }, { ok: true, value: { entries: [] } }, { ok: true, value: { entries: [...inventory(true, false).value.entries, inventory(true, false).value.entries[0]] } }, inventory('true', false)]) {
      h.setResponse(value); await c.refresh(); assert.deepEqual([...h.active.keys()], ['history']);
    }
    h.ctx.remote.pluginInventory.list = async () => { throw new Error('network unavailable'); };
    await c.refresh(); assert.equal(warnings.length, 2); assert.equal(h.stops.length, 0);
    assert.match(String(warnings[1][1]), /unavailable|ambiguous/);
  } finally { console.warn = warn; await c.dispose(); }
});

test('concurrent polls share one RPC', async () => {
  const h = harness(); let done; let calls = 0;
  h.ctx.remote.pluginInventory.list = () => { calls++; return new Promise((resolve) => { done = resolve; }); };
  const c = createComponentController(h.ctx, h.components);
  const first = c.refresh(); assert.equal(c.refresh(), first); assert.equal(calls, 1);
  done(inventory(true, true)); await first; await c.dispose();
});

test('reopen waits for asynchronous disposal and retains the unrelated fiber', async () => {
  const h = harness(); const plugin = h.ctx.plugin; let finish;
  h.ctx.plugin = (component) => { const fiber = plugin(component); if (component === h.components.history) fiber.dispose = () => new Promise((resolve) => { finish = () => { h.active.delete('history'); h.stops.push('history'); resolve(); }; }); return fiber; };
  const c = createComponentController(h.ctx, h.components);
  h.setResponse(inventory(true, true)); await c.refresh();
  h.setResponse(inventory(false, true)); const stopping = c.refresh();
  for (let i = 0; i < 6 && !finish; i++) await Promise.resolve();
  assert.ok(finish); h.setResponse(inventory(true, true)); assert.equal(c.refresh(), stopping);
  assert.equal(h.starts.length, 2); finish(); await stopping;
  await c.refresh(); assert.deepEqual(h.starts, ['history', 'retry', 'history']);
  h.setResponse(inventory(false, true)); const last = c.refresh();
  for (let i = 0; i < 6; i++) await Promise.resolve(); finish(); await last; await c.dispose();
});

test('disposal exception is reported and does not poison subsequent refreshes', async () => {
  const h = harness(); const plugin = h.ctx.plugin; let fail = true; const warnings = [];
  h.ctx.plugin = (component) => { const fiber = plugin(component); const dispose = fiber.dispose; fiber.dispose = () => { if (component === h.components.history && fail) { fail = false; throw new Error('dispose failed'); } return dispose(); }; return fiber; };
  const warn = console.warn; console.warn = (...args) => warnings.push(args);
  const c = createComponentController(h.ctx, h.components);
  try {
    h.setResponse(inventory(true, true)); await c.refresh();
    h.setResponse(inventory(false, true)); await c.refresh(); assert.equal(warnings.length, 1);
    await c.refresh(); assert.deepEqual([...h.active.keys()], ['retry']);
    h.setResponse(inventory(true, true)); await c.refresh(); assert.equal(h.active.size, 2);
  } finally { console.warn = warn; await c.dispose(); }
});

test('reset invalidates late RPC and serializes fresh state', async () => {
  const h = harness(); let old; let calls = 0;
  h.ctx.remote.pluginInventory.list = () => ++calls === 1 ? new Promise((done) => { old = done; }) : Promise.resolve(inventory(false, true));
  const c = createComponentController(h.ctx, h.components);
  const first = c.refresh(); await c.reset(); old(inventory(true, true)); await first;
  assert.deepEqual(h.starts, ['retry']); await c.dispose();
});

test('plugin startup exception is reported, then a later verified poll retries normally', async () => {
  const h = harness(); const plugin = h.ctx.plugin; let fail = true; const warnings = [];
  h.ctx.plugin = component => { if (fail) { fail = false; throw new Error('startup failed'); } return plugin(component); };
  const warn = console.warn; console.warn = (...args) => warnings.push(args);
  const c = createComponentController(h.ctx, h.components);
  try { await c.refresh(); assert.equal(warnings.length, 1); await c.refresh(); assert.deepEqual(h.starts, ['history']); }
  finally { console.warn = warn; await c.dispose(); }
});

test('root disposal attempts every child even when one cleanup throws, and reports failure', async () => {
  const h = harness(); const plugin = h.ctx.plugin;
  h.ctx.plugin = component => { const fiber = plugin(component); if (component === h.components.history) fiber.dispose = () => { h.stops.push('history'); throw new Error('cleanup failed'); }; return fiber; };
  h.setResponse(inventory(true, true)); const c = createComponentController(h.ctx, h.components); await c.refresh();
  await assert.rejects(c.dispose(), /Component disposal failed/); assert.deepEqual(h.stops, ['history', 'retry']);
  await c.dispose(); assert.equal(h.stops.length, 2);
});
