import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import Settings from '@deepseek-ai/dsh-settings';
import * as Plato from '../lib/index.js';
import { snapshotConfig } from '../lib/config.js';

// An owned test profile exercises the native editor; the user's profile is untouched.
async function fixture() {
  await mkdir(resolve('test-results'), { recursive: true });
  const home = await mkdtemp(resolve('test-results/settings-'));
  const dir = join(home, 'profile');
  initProfile(dir, ['plato-settings-test-bundle']);
  const bundle = join(dir, 'node_modules/plato-settings-test-bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(home, 'package.json'), '{"name":"plato-settings-test"}');
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'plato-settings-test-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'sf-plato', name: 'cordis:plato' },
  ] }]));
  const base = join(dir, 'cordis.yml');
  await writeFile(base, '[]\n');
  const profile = { name: 'test', startedBundles: ['plato-settings-test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined };
  const start = () => boot('dsh', base, readProfilePatches('dsh', profile), ctx => {
    ctx.provide('profileContext', profile);
    ctx.provide('appReady', { onReady: listener => { listener(); return () => {}; } });
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, plato: Plato });
  });
  return { ctx: await start(), start, profile };
}

function settingsScope(ctx) {
  const listeners = new Set();
  let state, pending;
  function refresh() {
    const value = ctx.settings.describe().find(row => row.ns === 'sf-plato');
    state = { status: value ? 'ready' : 'unavailable', value: value?.value,
      revision: value?.revision, writable: ctx.settings.writable, mode: 'host' };
    for (const listener of listeners) listener();
  }
  refresh();
  const off = ctx.on('settings/document-updated', ns => { if (ns === 'sf-plato') refresh(); });
  return {
    getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    get pending() { return pending; },
    mutate(ops, revision) {
      pending = (async () => {
        try { await ctx.settings.mutate('sf-plato', ops, revision); refresh(); return true; }
        catch (error) { refresh(); if (error.code === 'SETTINGS_CONFLICT') return false; throw error; }
      })();
      return pending;
    },
    refresh, dispose: off,
  };
}

const platoEntry = ctx => [...ctx.loader.entries()].find(entry => entry.options.id === 'sf-plato');

test('native settings persist, retain the plugin fiber, fence stale edits and restore after restart', async t => {
  const f = await fixture();
  t.after(() => f.ctx.fiber.dispose());
  const entry = platoEntry(f.ctx);
  assert.ok(entry?.fiber, 'Unconfigured PLATO must load without Runtime/subprocess');
  const fiber = entry.fiber;
  const before = snapshotConfig(fiber.config);
  assert.equal(before.plantumlJarPath, '');
  const first = f.ctx.settings.describe().find(row => row.ns === 'sf-plato');
  assert.ok(first, 'PLATO exposes a native settings namespace before paths are filled');
  assert.equal(first.autoGenerate, false);
  await f.ctx.settings.mutate('sf-plato', [
    { op: 'set', path: ['pythonPath'], value: 'D:\\venvs\\plato\\Scripts\\python.exe' },
    { op: 'set', path: ['plantumlJarPath'], value: 'D:\\tools\\plantuml.jar' },
    { op: 'set', path: ['startupTimeoutMs'], value: 45000 },
  ], first.revision);
  assert.equal(platoEntry(f.ctx).fiber, fiber, 'Saving must not unload running work');
  assert.equal(before.plantumlJarPath, '', 'A running task keeps its original snapshot');
  assert.equal(snapshotConfig(fiber.config).startupTimeoutMs, 45000);
  assert.equal(snapshotConfig(fiber.config).plantumlJarPath, 'D:\\tools\\plantuml.jar');
  await assert.rejects(f.ctx.settings.mutate('sf-plato', [
    { op: 'set', path: ['javaPath'], value: 'stale-java' },
  ], first.revision), { code: 'SETTINGS_CONFLICT' });
  const current = f.ctx.settings.describe().find(row => row.ns === 'sf-plato');
  await assert.rejects(f.ctx.settings.mutate('sf-plato', [
    { op: 'set', path: ['startupTimeoutMs'], value: 0 },
  ], current.revision));
  assert.equal(snapshotConfig(fiber.config).startupTimeoutMs, 45000);
  assert.match(await readFile(f.profile.patchPath, 'utf8'), /plantumlJarPath/);
  await f.ctx.fiber.dispose();
  const restarted = await f.start();
  t.after(() => restarted.fiber.dispose());
  assert.equal(snapshotConfig(platoEntry(restarted).fiber.config).plantumlJarPath, 'D:\\tools\\plantuml.jar');
  assert.equal(snapshotConfig(platoEntry(restarted).fiber.config).startupTimeoutMs, 45000);
});

test('the shipped Client form saves through native settings, validates, discards and reports failures', async t => {
  const f = await fixture();
  t.after(() => f.ctx.fiber.dispose());
  const scope = settingsScope(f.ctx);
  t.after(scope.dispose);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  let artifact;
  vm.runInNewContext(await readFile(resolve('client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { artifact = value; } } },
  });
  assert.equal(artifact.id, '@software-factory/plato');
  const client = artifact.factory(name => { assert.equal(name, 'react'); return React; });
  let registration, Component, dictionaries;
  const disposers = [];
  client.apply({
    effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); },
    locale: { register(_ns, values) { dictionaries = values; return () => {}; } },
    configForms: { get(id) { assert.equal(id, 'sf-plato'); return scope; } },
    slots: { inject(name, callback) { assert.equal(name, 'plugins.bundle.config'); callback(); },
      register(options, view) { registration = options; Component = view; return () => {}; } },
  });
  assert.equal(registration.key, '@software-factory/plato');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    for (const off of disposers) off();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const translate = key => dictionaries.zh[key] ?? key;
  await act(async () => root.render(React.createElement(Component, { ...registration.inject(), t: translate })));
  const document = dom.window.document;
  assert.match(document.body.textContent, /运行环境配置/);
  async function edit(name, value) {
    const input = document.querySelector(`input[name="${name}"]`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await scope.pending;
    });
  }
  await edit('plantumlJarPath', 'relative.jar');
  await submit();
  assert.match(document.body.textContent, /请填写绝对路径/);
  assert.equal(scope.getSnapshot().value.plantumlJarPath, '');
  await edit('plantumlJarPath', 'D:\\tools\\图形.jar');
  await edit('timeoutSeconds', '45');
  await submit();
  assert.match(document.body.textContent, /已保存/);
  assert.equal(scope.getSnapshot().value.startupTimeoutMs, 45000);
  assert.equal(scope.getSnapshot().value.plantumlJarPath, 'D:\\tools\\图形.jar');
  await edit('timeoutSeconds', '0');
  await submit();
  assert.match(document.body.textContent, /请输入 1～120/);
  assert.equal(scope.getSnapshot().value.startupTimeoutMs, 45000);
  await act(async () => document.querySelector('button[type="button"]').click());
  assert.equal(document.querySelector('input[name="timeoutSeconds"]').value, '45');
  await edit('javaPath', 'my-java');
  await act(async () => {
    await f.ctx.settings.update('sf-plato', { javaPath: 'other-page-java' }, scope.getSnapshot().revision);
    scope.refresh();
  });
  assert.match(document.body.textContent, /配置已在其他页面修改/);
  assert.equal(document.querySelector('button[type="submit"]').disabled, true);
  await act(async () => document.querySelector('button[type="button"]').click());
  assert.equal(document.querySelector('input[name="javaPath"]').value, 'other-page-java');
  await edit('javaPath', 'new-java');
  const mutate = scope.mutate;
  scope.mutate = async () => { throw new Error('Synthetic transport failure'); };
  await submit();
  assert.match(document.body.textContent, /保存失败.*Synthetic transport failure/);
  assert.equal(document.querySelector('input[name="javaPath"]').value, 'new-java');
  scope.mutate = mutate;
});
