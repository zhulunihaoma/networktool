// Controlled UI/IPC fixture; real Codex RPC is tested separately.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const { _electron, expect } = require('@playwright/test');
if (!process.argv[2]) throw new Error('Pass a fresh evidence directory.');
const directory = path.resolve(process.argv[2]);
await fs.mkdir(directory, { recursive: true });
const home = path.join(directory, 'home'); await fs.mkdir(home, { recursive: true });
const env = { ...process.env, NETWORK_LENS_DATA_DIR: path.join(directory, 'data'), NETWORK_LENS_TEST_HOME: home, NETWORK_LENS_AUTO_PROTECT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const checks = [], errors = [];
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(String(error)));
  const original = await page.evaluate(() => window.networkLens.security.securityOverview());
  await fs.writeFile(path.join(directory, 'initial-tool-status.json'), JSON.stringify(original.tools, null, 2));
  const codex = original.tools.find(t => t.tool === 'codex');
  assert.ok(codex);
  // A usable Codex fixture needs both installed and canToggle. The old script
  // changed only installed, leaving canToggle=false when the fake home is empty.
  const overview = { ...original, tools: [{ ...codex, installed: true, canToggle: true, state: 'needs_trust', note: 'Synthetic trust fixture' }] };
  await app.evaluate(({ ipcMain }, initial) => {
    globalThis.__trustFixture = { calls: 0, fail: true, initial };
    ipcMain.removeHandler('security-overview'); ipcMain.handle('security-overview', () => initial);
    ipcMain.removeHandler('security-trust-codex');
    ipcMain.handle('security-trust-codex', async () => {
      const f = globalThis.__trustFixture; f.calls++;
      if (f.fail) throw new Error('Synthetic trust failure: state must remain untrusted');
      initial.tools[0].state = 'enabled';
      return { message: '信任已保存，测试回执。', overview: initial };
    });
  }, overview);
  await page.getByRole('button', { name: '安全中心', exact: true }).click();
  await page.getByRole('tab', { name: '防护开关', exact: true }).click();
  const trust = page.getByRole('button', { name: '信任此防护', exact: true });
  await expect(trust).toBeVisible(); checks.push({ name: 'usable fixture displays trust button', pass: true });
  await trust.click();
  await expect(trust).toBeEnabled();
  await expect(page.getByText(/Synthetic trust failure/).first()).toBeVisible();
  checks.push({ name: 'failed IPC keeps trust button and reports failure', pass: true });
  await page.screenshot({ path: path.join(directory, 'trust-failure.png'), fullPage: true });
  await app.evaluate(() => { globalThis.__trustFixture.fail = false; });
  await trust.click();
  await expect(page.getByRole('status').filter({ hasText: '信任已保存' })).toBeVisible();
  await expect(trust).toHaveCount(0);
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '规则自检', exact: true })).toBeVisible();
  assert.equal(await app.evaluate(() => globalThis.__trustFixture.calls), 2);
  checks.push({ name: 'retry makes one IPC call, refreshes state and preserves controls', pass: true });
  assert.deepEqual(errors, []); checks.push({ name: 'no renderer pageerror', pass: true });
  await page.screenshot({ path: path.join(directory, 'trust-success.png'), fullPage: true });
} catch (error) {
  checks.push({ name: 'trust UI flow', pass: false, error: String(error) });
  if (page) await page.screenshot({ path: path.join(directory, 'unexpected-failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (app) await app.close();
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ fixture: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ directory, checks }));
  process.exitCode = checks.some(c => !c.pass) ? 1 : 0;
}
