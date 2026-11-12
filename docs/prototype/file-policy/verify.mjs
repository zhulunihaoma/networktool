// Dependency-free behavior checks for the offline prototype.
// A minimal DOM stub supports logic execution; this does not verify browser layout or accessibility.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, "inline script exists");
new vm.Script(source);
assert.equal(/<script[^>]+src=/.test(html), false, "no external JavaScript");
assert.equal(/<link[^>]+href=/.test(html), false, "no external stylesheet");

const elements = new Map();
const listeners = {};
const storage = new Map();
const el = (id) => {
  if (!elements.has(id))
    elements.set(id, {
      innerHTML: "",
      textContent: "",
      value: "",
      checked: false,
      disabled: false,
      hidden: false,
      open: false,
      isConnected: true,
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
      focus() {},
      addEventListener() {},
      click() {},
    });
  return elements.get(id);
};
const context = vm.createContext({
  console,
  crypto: webcrypto,
  Blob,
  URL,
  Intl,
  Date,
  document: {
    activeElement: el("initial-focus"),
    querySelector: el,
    createElement: () => el("download"),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
  },
  window: { addEventListener() {} },
  localStorage: {
    getItem: (k) => storage.get(k),
    setItem: (k, v) => storage.set(k, v),
  },
  setTimeout: (fn) => {
    fn();
    return 0;
  },
  clearTimeout() {},
  setInterval() {},
});
vm.runInContext(source, context);
const evaluate = (code) => vm.runInContext(code, context);
const json = (code) => JSON.parse(evaluate(`JSON.stringify(${code})`));
const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}
const click = async (action, value = "") => {
  for (const fn of listeners.click)
    await fn({
      target: {
        closest: () => ({ disabled: false, dataset: { action, value } }),
      },
    });
};

await check("开发：源码允许读取，凭据拒绝读取，未知终端未覆盖", () => {
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='source')).kind"),
    "allow",
  );
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='secret')).kind"),
    "deny",
  );
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='terminal')).kind"),
    "uncovered",
  );
});
await check("系统增强就绪后可拒绝终端读密钥；通道撤销后恢复未覆盖", () => {
  evaluate("ctx().native=true");
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='terminal')).kind"),
    "deny",
  );
  evaluate("ctx().native=false");
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='terminal')).kind"),
    "uncovered",
  );
});
await check("单次授权需原因；一次重试消费，第二次重试重新询问", async () => {
  evaluate("selectedScenario='edit'");
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "ask");
  evaluate("grantForm(lastResult.id)");
  evaluate("saveGrant(lastResult.id)");
  assert.equal(evaluate("ctx().grants.length"), 0);
  el("#grant-reason").value = "确认仅修改这份发布配置";
  evaluate("saveGrant(lastResult.id)");
  assert.equal(evaluate("ctx().grants[0].status"), "active");
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "allow");
  assert.equal(evaluate("ctx().grants[0].status"), "used");
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "ask");
});
await check("授权到期及撤销后均回归需确认；版本变化不能重用授权", async () => {
  evaluate("globalThis.askEventId=lastResult.id");
  evaluate("grantForm(askEventId); saveGrant(askEventId)");
  evaluate("ctx().grants[0].expiresAt=Date.now()-1; expire()");
  assert.equal(evaluate("ctx().grants[0].status"), "expired");
  assert.equal(evaluate("evaluate(scene()).kind"), "ask");
  evaluate("grantForm(askEventId); saveGrant(askEventId)");
  await click("confirm-revoke", evaluate("ctx().grants[0].id"));
  assert.equal(evaluate("ctx().grants[0].status"), "revoked");
  evaluate("grantForm(askEventId); saveGrant(askEventId); ctx().rev++");
  assert.equal(evaluate("evaluate(scene()).kind"), "ask");
});
await check("办公：允许读取不隐含允许发送，办公写入依赖系统通道", () => {
  evaluate("state.persona='office';selectedScenario='payroll'");
  assert.equal(evaluate("ctx().rules.find(r=>r.id==='payroll').read"), "allow");
  assert.equal(evaluate("evaluate(scene()).kind"), "ask");
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='office')).kind"),
    "uncovered",
  );
  evaluate("ctx().native=true");
  assert.equal(
    evaluate("evaluate(scenarios().find(s=>s.id==='office')).kind"),
    "allow",
  );
});
await check("脱敏副本需明确确认；提交副本不改变原件规则", async () => {
  await evaluate("runScenario()");
  const id = evaluate("lastResult.id");
  evaluate("redact(lastResult.id)");
  await click("send-redacted", id);
  assert.equal(evaluate("lastResult.kind"), "ask");
  el("#redact-check").checked = true;
  await click("send-redacted", id);
  assert.equal(evaluate("lastResult.kind"), "allow");
  assert.equal(evaluate("evaluate(scene()).kind"), "ask");
  assert.equal(
    evaluate("ctx().rules.find(r=>r.id==='payroll').disclose"),
    "ask",
  );
});
await check("新建校验：拒绝上跳、绝对路径及重复路径；输出转义", () => {
  evaluate("newPolicy();draft.name='测试';draft.file='../secret'");
  assert.equal(evaluate("validateDraft()"), false);
  evaluate("draft.file='/etc/hosts'");
  assert.equal(evaluate("validateDraft()"), false);
  evaluate("draft.file='财务/薪资汇总.xlsx'");
  assert.equal(evaluate("validateDraft()"), false);
  evaluate(
    "draft.name='<img src=x onerror=alert(1)>';draft.file='合同/报价.xlsx'",
  );
  assert.equal(evaluate("validateDraft()"), true);
  assert.match(evaluate("escapeHTML(draft.name)"), /&lt;img/);
});
await check(
  "发布失败保留草稿与旧版本；重试成功后新增规则并更新版本",
  async () => {
    evaluate("step=3;draft.checked=true;draft.fail=true;wizard()");
    await evaluate("publish()");
    assert.equal(evaluate("ctx().rev"), 1);
    assert.equal(evaluate("ctx().rules.length"), 3);
    assert.equal(evaluate("draft.file"), "合同/报价.xlsx");
    assert.match(el("#publish-status").innerHTML, /下发失败/);
    evaluate("draft.fail=false");
    await evaluate("publish()");
    assert.equal(evaluate("ctx().rev"), 2);
    assert.equal(evaluate("ctx().rules.length"), 4);
  },
);
await check("新发布策略进入场景验证，读取、修改、删除、外发独立决策", () => {
  const samples = json("scenarios().filter(s=>s.rule.startsWith('custom-'))");
  assert.equal(samples.length, 4);
  assert.deepEqual(
    samples.map((s) =>
      evaluate(
        `evaluate(scenarios().find(x=>x.id===${JSON.stringify(s.id)})).kind`,
      ),
    ),
    ["allow", "ask", "deny", "ask"],
  );
});
await check("回滚生成新修订版本；历史事件保留", async () => {
  const count = evaluate("ctx().events.length");
  await click("confirm-rollback");
  assert.equal(evaluate("ctx().rev"), 3);
  assert.equal(evaluate("ctx().rules.length"), 3);
  assert.equal(evaluate("ctx().events.length"), count + 1);
});
await check("四种环境状态相互隔离，Windows 使用反斜杠路径", () => {
  evaluate("state.os='win';state.persona='dev'");
  assert.equal(evaluate("ctx().rev"), 1);
  assert.equal(evaluate("ctx().events.length"), 0);
  assert.equal(
    evaluate("pathFor('src/main.ts')"),
    "C:\\Projects\\atlas\\src\\main.ts",
  );
  evaluate("state.os='mac';state.persona='office'");
  assert.equal(evaluate("ctx().rev"), 3);
});
await check("导出生成 JSON 并标注演示来源，授权原因已隐藏", () => {
  evaluate("exportReport()");
  assert.equal(el("download").download, "file-policy-demo-report.json");
  assert.match(el("download").href, /^blob:/);
});
await check("保存状态可序列化；证据记录不混为真实拦截", () => {
  const saved = JSON.parse(
    storage.get("network-lens-file-policy-prototype-v2"),
  );
  assert.ok(saved.contexts["mac-office"]);
  const events = json("ctx().events");
  assert.ok(events.some((e) => e.kind === "action"));
  assert.ok(events.some((e) => e.kind === "ask"));
  assert.ok(events.every((e) => e.id.startsWith("DEMO-")));
});

await check(
  "文件发现：候选暂缓可恢复，发布前不显示已配置，回滚后重新待确认",
  async () => {
    await evaluate("scanDemo()");
    assert.equal(evaluate("discoveries().scanned"), true);
    await evaluate("v2Click('defer-candidate','clients')");
    assert.equal(
      evaluate("discoveryStatus(discoveries().items[0])"),
      "暂缓确认",
    );
    await evaluate("v2Click('defer-candidate','clients')");
    evaluate("protectCandidate('clients')");
    assert.equal(evaluate("discoveryStatus(discoveries().items[0])"), "待确认");
    evaluate("draft.checked=true;step=3;wizard()");
    await evaluate("publish()");
    assert.equal(
      evaluate("discoveryStatus(discoveries().items[0])"),
      "已配置策略",
    );
    await click("confirm-rollback");
    assert.equal(evaluate("discoveryStatus(discoveries().items[0])"), "待确认");
  },
);
await check("文件变化使授权失效，旧询问记录不能再次生成许可", async () => {
  evaluate("selectedScenario='contract'");
  await evaluate("runScenario()");
  const id = evaluate("lastResult.id");
  evaluate(`grantForm(${JSON.stringify(id)});saveGrant(${JSON.stringify(id)})`);
  evaluate("staleFile('合同/服务合同.docx')");
  assert.equal(evaluate("ctx().grants[0].status"), "invalid");
  assert.equal(evaluate("evaluate(scene()).kind"), "ask");
  const count = evaluate("ctx().grants.length");
  evaluate(`saveGrant(${JSON.stringify(id)})`);
  assert.equal(evaluate("ctx().grants.length"), count);
});
await check("目标改变使脱敏预览失效，不得提交旧预览", async () => {
  evaluate("selectedScenario='payroll'");
  await evaluate("runScenario()");
  const id = evaluate("lastResult.id");
  evaluate("redact(lastResult.id)");
  await evaluate("v2Click('change-dest','payroll')");
  const before = evaluate(
    "ctx().events.filter(e=>e.title==='提交脱敏副本').length",
  );
  await click("send-redacted", id);
  assert.equal(
    evaluate("ctx().events.filter(e=>e.title==='提交脱敏副本').length"),
    before,
  );
  assert.match(evaluate("scene().dest"), /alternate/);
  evaluate("closeModal()");
});
await check("规则允许与任务完成分开，失败重试成功后才完成", async () => {
  evaluate(
    "state.os='win';state.persona='dev';selectedScenario='source';ctx().failNext=true",
  );
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "error");
  assert.equal(evaluate("lastResult.decision"), "allow");
  assert.equal(evaluate("lastResult.receipt"), "failed");
  assert.equal(evaluate("taskState(scene())"), "执行失败 · 待重试");
  await evaluate("runScenario()");
  assert.equal(evaluate("taskState(scene())"), "已完成");
});
await check("授权后的执行失败仍消费许可，再次执行需重新确认", async () => {
  evaluate("selectedScenario='edit'");
  await evaluate("runScenario()");
  evaluate(
    "grantForm(lastResult.id);saveGrant(lastResult.id);ctx().failNext=true",
  );
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "error");
  assert.equal(evaluate("ctx().grants[0].status"), "used");
  await evaluate("runScenario()");
  assert.equal(evaluate("lastResult.kind"), "ask");
});
await check("改用安全样例可完成任务，生产凭据规则保持禁止", async () => {
  evaluate("selectedScenario='secret'");
  await evaluate("runScenario()");
  await evaluate("v2Click('safe-example',lastResult.id)");
  assert.equal(evaluate("taskState(scene())"), "已完成");
  assert.equal(evaluate("lastResult.file"), ".env.example");
  assert.equal(evaluate("evaluate(scene()).kind"), "deny");
});
await check("未经试运行不能发布；版本冲突时保留草稿", async () => {
  evaluate(
    "newPolicy();draft.name='测试';draft.file='test.config';step=3;wizard()",
  );
  const revision = evaluate("ctx().rev");
  await evaluate("publish()");
  assert.equal(evaluate("ctx().rev"), revision);
  evaluate("draft.checked=true;draft.baseRevision=0");
  await evaluate("publish()");
  assert.equal(evaluate("ctx().rev"), revision);
  assert.equal(evaluate("draft.file"), "test.config");
});

console.log(`PASS: ${results.length} behavior checks`);
for (const name of results) console.log(`  ✓ ${name}`);
console.log(
  "Scope: JavaScript behavior with DOM stubs. Browser interaction, rendering, focus, downloads and native protection remain unverified.",
);
