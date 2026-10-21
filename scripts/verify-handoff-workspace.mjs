import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { _electron, expect } = require('@playwright/test');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'network-handoff-ui-'));
const home = path.join(temporary, 'home');
const workspace = path.join(temporary, 'relay-project');
const id = '12345678-1234-4234-8234-123456789abc';
const secondId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sources = new Map();
const put = async (relative, text) => {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  sources.set(file, text);
  return file;
};
const lines = (...rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const user = message => ({ type: 'event_msg', payload: { type: 'user_message', message } });
const meta = (sessionId, cwd) => ({ type: 'session_meta', payload: { id: sessionId, cwd, timestamp: '2026-10-20T12:00:00Z' } });
let app;
try {
  await fs.mkdir(workspace, { recursive: true });
  const codexFile = await put(`.codex/sessions/2026/10/20/rollout-${id}.jsonl`, lines(
    meta(id, workspace),
    user('# AGENTS.md instructions\n<INSTRUCTIONS>\nOnly project rules\n</INSTRUCTIONS>'),
    user('继续分段计数任务'),
    { type: 'event_msg', payload: { type: 'agent_message', message: '已完成前段，记录起点 37。待办：把这个起点加 5，得到接力结果。CONTEXT_MARKER\ntoken=fixture-secret-value' } },
  ));
  await put(`.codex/sessions/2026/10/20/rollout-${secondId}.jsonl`, lines(meta(secondId, '/another/project'), user('用于检查项目筛选的另一条会话')));
  await put(`.claude/projects/relay/${id}.jsonl`, lines(
    { type: 'user', uuid: 'u1', sessionId: id, cwd: workspace, timestamp: '2026-10-20T12:00:00Z', message: { role: 'user', content: '继续另一段计算' } },
    { type: 'assistant', uuid: 'a1', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: '记录起点 18，下一步加 6。CLAUDE_CONTEXT_MARKER' }] } },
  ));
  const exported = JSON.stringify({ info: { id: 'ses_fixture', title: 'OpenCode 导出任务', directory: workspace }, messages: [{ info: { id: 'msg_1', sessionID: 'ses_fixture', role: 'user' }, parts: [{ type: 'text', text: '从 JSON 接力。OPENCODE_CONTEXT_MARKER' }] }] });
  const jsonFile = await put('export.json', exported);
  const bootstrap = path.join(temporary, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `const {app,dialog,net}=require('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});net.fetch=async()=>{throw new Error('fixture: network disabled')};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(jsonFile)}]});require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', NETWORK_LENS_DATA_DIR: path.join(temporary, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NETWORK_LENS_DEV;
  app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 });
  // Snapshot every clipboard format in main-process memory and restore in finally.
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.handoffClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '任务接续', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled({ timeout: 35000 });
  await page.getByRole('tab', { name: /^Codex/ }).click();
  await expect(page.locator('.handoff-task')).toHaveCount(2);
  await expect(page.locator('.handoff-task-title').filter({ hasText: '继续分段计数任务' })).toBeVisible();
  assert(!await page.locator('.handoff-task-list').innerText().then(s => s.includes('AGENTS.md')));
  const widths = await page.locator('.handoff-conversations').evaluate(el => ({ list: el.clientWidth, browser: el.closest('.handoff-browser-grid').clientWidth }));
  assert(widths.list / widths.browser > .65, JSON.stringify(widths));
  const headingTop = await page.locator('.handoff-page h1').evaluate(el => el.getBoundingClientRect().top);
  assert(headingTop < 140, `page should start below the app toolbar, got y=${headingTop}`);
  await page.getByRole('navigation', { name: '项目分类' }).getByRole('button', { name: /relay-project/ }).click();
  await expect(page.locator('.handoff-task')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索对话' }).fill('不存在');
  await expect(page.locator('.handoff-conversations')).toContainText('没有匹配的会话');
  await page.locator('.handoff-search').getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.screenshot({ path: path.join(temporary, 'handoff-list.png') });
  const relay = page.getByRole('button', { name: '接力', exact: true });
  await relay.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Claude Code', exact: true }).click();
  const goal = dialog.getByRole('textbox', { name: '本次继续做什么' });
  await goal.fill('');
  await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeDisabled();
  const receiverGoal = '根据历史记录的起点和待办完成加法。不要调用任何工具或读取任何文件，只回复 HANDOFF_OK:<计算结果>。';
  await goal.fill(receiverGoal);
  await dialog.getByRole('checkbox', { name: /会话历史/ }).uncheck();
  await dialog.getByRole('checkbox', { name: /来源工作区/ }).uncheck();
  await dialog.getByRole('button', { name: '生成接力预览' }).click();
  await expect(dialog.locator('.handoff-prompt')).toContainText('本次未携带会话历史');
  const minimal = await dialog.locator('.handoff-prompt').innerText();
  assert(!minimal.includes('CONTEXT_MARKER'));
  assert(!minimal.includes(workspace));
  await dialog.getByRole('button', { name: '调整内容' }).click();
  await dialog.getByRole('checkbox', { name: /会话历史/ }).check();
  await dialog.getByRole('checkbox', { name: /来源工作区/ }).check();
  await page.screenshot({ path: path.join(temporary, 'handoff-configure.png') });
  await dialog.getByRole('button', { name: '生成接力预览' }).click();
  const prompt = await dialog.locator('.handoff-prompt').innerText();
  assert(prompt.includes('CONTEXT_MARKER') && prompt.includes(workspace));
  assert(!prompt.includes('fixture-secret-value'));
  assert(prompt.includes('[已脱敏]'));
  await expect(dialog.getByRole('button', { name: '确认并复制接力内容' })).toBeDisabled();
  for (const check of await dialog.locator('.handoff-confirmations input').all()) await check.check();
  await dialog.getByRole('button', { name: '确认并复制接力内容' }).click();
  await expect(dialog.getByRole('status')).toContainText('已复制，接下来粘贴到 Claude Code');
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(clipboardText, prompt, 'clipboard must exactly equal the reviewed preview');
  await fs.writeFile(path.join(temporary, 'to-claude.txt'), clipboardText);
  if (process.argv.includes('--receiver')) {
    const response = await new Promise((resolve, reject) => {
      const child = execFile('claude', ['--print', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--output-format', 'json', '--system-prompt', 'You validate context handoffs using only the supplied prompt. Never use tools or access local data. Complete the current task based on the quoted history.'], { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin.end(clipboardText);
    });
    await fs.writeFile(path.join(temporary, 'claude-receiver.json'), response);
    const received = JSON.parse(response);
    assert.equal(received.result.trim(), 'HANDOFF_OK:42');
    console.log('Real Claude Code receiver: HANDOFF_OK:42');
  }
  await page.screenshot({ path: path.join(temporary, 'handoff-copied.png') });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(relay).toBeFocused();
  await page.getByRole('button', { name: '预览记录', exact: true }).click();
  await expect(dialog.locator('.handoff-transcript pre')).toContainText('CONTEXT_MARKER');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  // Malformed import cannot retain a previous source or expose a stale copy button.
  await fs.writeFile(codexFile, '{invalid}\n');
  await relay.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeDisabled();
  await expect(dialog.locator('.handoff-source')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭接力弹窗' }).click();
  await fs.writeFile(codexFile, sources.get(codexFile));
  // Verify a second native adapter uses the same modal and IPC route.
  await page.getByRole('tab', { name: /^Claude Code/ }).click();
  await expect(page.locator('.handoff-task')).toHaveCount(1);
  await page.getByRole('button', { name: '接力', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await dialog.getByRole('button', { name: '生成接力预览' }).click();
  await expect(dialog.locator('.handoff-prompt')).toContainText('ClaudeCode → Codex');
  await expect(dialog.locator('.handoff-prompt')).toContainText('CLAUDE_CONTEXT_MARKER');
  await dialog.getByRole('button', { name: '关闭接力弹窗' }).click();
  await page.getByRole('tab', { name: /^OpenCode/ }).click();
  await expect(page.getByRole('button', { name: '导入 JSON', exact: true })).toBeEnabled({ timeout: 35000 });
  await page.getByRole('button', { name: '导入 JSON', exact: true }).click();
  await expect(dialog.locator('.handoff-source')).toContainText('OpenCode 导出任务');
  await dialog.getByRole('button', { name: '生成接力预览' }).click();
  await expect(dialog.locator('.handoff-prompt')).toContainText('OPENCODE_CONTEXT_MARKER');
  await dialog.getByRole('button', { name: '关闭接力弹窗' }).click();
  // A mismatched options object is rejected by the real main-process schema.
  const badOptions = await page.evaluate(async () => {
    try { await window.networkLens.previewHandoff('目标', 'Codex', { includeTranscript: 'yes', includeWorkspace: true }); return false; }
    catch { return true; }
  });
  assert(badOptions);
  await page.getByRole('tab', { name: /^Codex/ }).click();
  await expect(page.locator('.handoff-task')).toHaveCount(2);
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole('button', { name: '接力', exact: true }).first().click();
  await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeEnabled();
  const bounds = await dialog.evaluate(el => { const box = el.getBoundingClientRect(); const footer = el.querySelector('.handoff-dialog-footer').getBoundingClientRect(); return { top: box.top, right: box.right, bottom: box.bottom, footer: footer.bottom, width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }; });
  assert(bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height && bounds.footer <= bounds.height, JSON.stringify(bounds));
  assert(bounds.scroll <= bounds.width, JSON.stringify(bounds));
  await page.screenshot({ path: path.join(temporary, 'handoff-1024.png') });
  assert.deepEqual(errors, []);
  for (const [file, content] of sources) assert.equal(await fs.readFile(file, 'utf8'), content, `source unchanged: ${file}`);
  console.log(JSON.stringify({ passed: true, checks: ['native Codex import', 'native Claude import', 'OpenCode JSON import', 'project filtering', 'search', 'title cleanup', 'content selection', 'copy requires review', 'clipboard equals preview', 'corrupt source recovery', 'IPC validation', 'focus restore and Escape', '1024x720 layout', 'source files unchanged', 'no renderer errors'], output: temporary, receiverPrompt: path.join(temporary, 'to-claude.txt') }, null, 2));
} finally {
  if (app) {
    try { await app.evaluate(async ({ clipboard }) => { if (globalThis.handoffClipboardBackup) { if (globalThis.handoffClipboardBackup.length) await clipboard.write(globalThis.handoffClipboardBackup); else clipboard.clear(); } }); }
    finally { await app.close(); }
  }
}
