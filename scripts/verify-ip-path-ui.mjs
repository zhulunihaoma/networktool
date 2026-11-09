// Isolated Electron renderer fixture; no real network or system-setting changes.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ip-path-ui-"));
let app;
try {
  const bundled = await build({
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import TriagePanel from './src/TriagePanel';
      import { newTriage } from './src/shared/triage';
      import { ipv6RepairPlan } from './src/shared/ip-path';
      import './src/styles.css';
      let run = {...newTriage('codex', 'fixture-run'), status: 'completed'};
      const report = {
        host: 'codex-cloud-backend.chatgpt.com', checkedAt: Date.now(), networkKey: 'fixture', hasPublicIPv6: true, networkChanged: false,
        service: {id: 'wifi', name: 'Wi-Fi', device: 'en0', method: 'Automatic'},
        attempts: [
          {family: 4, interface: 'utun6', tcp: true, tls: true, httpStatus: 403, duration: 450},
          {family: 6, interface: 'en0', tcp: true, tls: false, code: 'ECONNRESET', duration: 120}
        ]
      };
      report.repair = ipv6RepairPlan(report);
      run.ipPath = report;
      run.steps.forEach(s => {s.status = 'unverified'; s.summary = '界面验收数据';});
      run.steps[3].status = 'attention'; run.steps[3].actions = ['copy_ipv6_plan']; run.priorityIds = ['entry'];
      let listener = () => {};
      window.testCalls = [];
      const api = {
        triage: async () => structuredClone(run), onTriage: fn => {listener = fn; return () => {};},
        triageAction: async (id, action) => {window.testCalls.push({id, action}); return {message: '已复制方案，未修改系统设置。'};},
        verifyTriage: async (id, result) => {run.verification = result; return structuredClone(run);},
        startTriage: async () => structuredClone(run)
      };
      window.setFixture = mode => {
        run = {...newTriage('codex', 'fixture-' + mode), status: 'completed', ipPath: structuredClone(report)};
        run.steps.forEach(s => {s.status = 'unverified'; s.summary = '界面验收数据';});
        if (mode === 'failed') {run.ipPath.attempts[0].tls = false; run.ipPath.repair = undefined;}
        if (mode === 'changed') {run.ipPath.networkChanged = true; run.ipPath.repair = undefined; run.comparison = '网络已变化，不能把恢复归因于修复操作';}
        if (mode === 'fixed') {run.ipPath.hasPublicIPv6 = false; run.ipPath.attempts = [report.attempts[0]]; run.ipPath.service.method = 'LinkLocal'; run.ipPath.repair = undefined; run.ipv6Recovery = report.repair; run.steps[3].actions = ['copy_ipv6_restore'];}
        listener(structuredClone(run));
      };
      createRoot(document.getElementById('root')).render(<TriagePanel api={api} platformChecking={false} onError={text => {throw new Error(text)}} />);
    `,
    },
    bundle: true,
    write: false,
    outdir: temporary,
    platform: "browser",
    jsx: "automatic",
  });
  for (const output of bundled.outputFiles)
    await fs.writeFile(output.path, output.contents);
  const js = path.basename(
    bundled.outputFiles.find((f) => f.path.endsWith(".js")).path,
  );
  const css = path.basename(
    bundled.outputFiles.find((f) => f.path.endsWith(".css")).path,
  );
  const fixture = path.join(temporary, "fixture.html");
  await fs.writeFile(
    fixture,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="${css}"><body><div id="root" style="padding:24px"></div><script src="${js}"></script></body></html>`,
  );
  const bootstrap = path.join(temporary, "bootstrap.cjs");
  await fs.writeFile(
    bootstrap,
    `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(temporary, "data"))});app.whenReady().then(()=>{const win=new BrowserWindow({width:1360,height:1100,webPreferences:{contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(fixture)});});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [bootstrap],
    env,
  });
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: /连接异常，或经常重连/ }).click();
  await expect(
    page.getByRole("region", { name: "IPv4 与 IPv6 路径对照" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toContainText("ECONNRESET");
  await expect(
    page.getByRole("region", { name: "可恢复的 IPv6 修复方案" }),
  ).toContainText("所有 Wi-Fi");
  await expect(page.locator(".ip-path-repair code").first()).toContainText(
    "setv6linklocal",
  );
  await expect(page.locator(".ip-path-repair code").last()).toContainText(
    "setv6automatic",
  );
  await page.getByRole("button", { name: "复制 IPv6 修复与恢复方案" }).click();
  assert.deepEqual(await page.evaluate(() => window.testCalls), [
    { id: "fixture-run", action: "copy_ipv6_plan" },
  ]);
  await page.getByRole("button", { name: "我在原工具确认已恢复" }).click();
  await expect(
    page.getByText(/用户复测记录：已在原工具确认恢复/),
  ).toBeVisible();
  if (process.env.NETWORK_LENS_IP_PATH_SCREENSHOT)
    await page.screenshot({
      path: process.env.NETWORK_LENS_IP_PATH_SCREENSHOT,
      fullPage: true,
    });
  await page.evaluate(() => window.setFixture("failed"));
  await expect(
    page.getByText(/仅限制 IPv6 不能视为完整修复/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "复制 IPv6 修复与恢复方案" }),
  ).toHaveCount(0);
  await page.evaluate(() => window.setFixture("changed"));
  await expect(
    page.getByText(/网络已变化，不能把恢复归因于修复操作/),
  ).toBeVisible();
  await page.evaluate(() => window.setFixture("fixed"));
  await expect(
    page.getByRole("region", { name: "先前记录的 IPv6 恢复方案" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "复制原 IPv6 恢复命令" }),
  ).toBeVisible();
  await expect(page.getByText(/用户复测记录：/)).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 900 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Verified Electron renderer: dual-stack evidence, copy action, separate recovery, both-family failure, network change, manual verification, 1024px layout; no network or system settings modified.",
  );
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
