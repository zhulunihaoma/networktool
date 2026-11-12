/** Explicit --live acceptance: real renderer/IPC + real local AI CLI receivers.
 * Only synthetic skills/conversations/attachments in a dedicated evidence dir.
 * Existing user skills/configuration are never replaced. Model calls may bill.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize real local CLI model calls.');
const root = path.resolve(import.meta.dirname, '..');
const directory = path.resolve(process.env.TRANSFER_EVIDENCE_DIR || path.join(root, 'artifacts', `live-transfer-${Date.now()}`));
await fs.mkdir(directory, { recursive: true });
if (await fs.stat(path.join(directory, 'results.json')).catch(() => undefined)) throw new Error('Choose a fresh evidence directory.');
const require = createRequire(path.join(root, 'package.json'));
const { _electron, expect } = require('@playwright/test');
const home = path.join(directory, 'fixture-home'), workspace = path.join(directory, 'relay-project');
const output = path.join(directory, 'exports with spaces');
const name = 'networktool-transfer-proof';
const codexMode = process.env.TRANSFER_RECEIVER === 'codex';
const codexArgs = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json'];
if (process.env.TRANSFER_CODEX_MODEL) codexArgs.push('--model', process.env.TRANSFER_CODEX_MODEL);
const codexText = text => eventsOf(text).filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text).join('\n');
const proof = randomUUID(), attachmentProof = randomUUID(), id = randomUUID();
const results = [], failures = [], rendererErrors = [];
let app, clipboardSaved = false;
await Promise.all([home, workspace, output].map(folder => fs.mkdir(folder, { recursive: true })));
const put = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { mode: 0o600 }); };
const source = path.join(home, '.claude/skills', name);
await put(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Local cross-tool acceptance skill. Use only when explicitly requested by name for a transfer test.\n---\nRead [the local proof](assets/proof.txt) relative to this SKILL.md. Return exactly SKILL_OK: followed by the file's trimmed text. Do not run commands, modify files, access the network or use other skills.\n`);
await put(path.join(source, 'assets/proof.txt'), proof + '\n');
await put(path.join(home, '.claude/projects/relay', `${id}.jsonl`), [
  { type: 'user', uuid: 'u1', sessionId: id, cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: '接力验收任务：已完成部分的累计值是 37。下一步请加 5；只做计算，不读取文件或调用工具。' } },
  { type: 'assistant', uuid: 'a1', sessionId: id, cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '已记录累计值与下一步，等待交接后继续。' }] } },
].map(row => JSON.stringify(row)).join('\n') + '\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const exported = path.join(directory, 'opencode-export.json');
await put(exported, JSON.stringify({
  info: { id: 'ses_transferfixture', title: 'OpenCode 附件接力验收', directory: workspace },
  messages: [{ info: { id: 'msg_fixture', role: 'user' }, parts: [
    { type: 'text', text: '继续附件验收任务。验收码只在 requirements.txt 中；图片为原始输入，不能猜测缺失内容。' },
    { type: 'file', filename: 'requirements.txt', mime: 'text/plain', url: `data:text/plain;base64,${Buffer.from('验收码：' + attachmentProof).toString('base64')}` },
    { type: 'file', filename: 'tiny.png', mime: 'image/png', url: `data:image/png;base64,${png.toString('base64')}` },
  ] }],
}));

const cli = async (label, executable, args, input, env = process.env) => {
  const start = Date.now();
  const stdoutFile = path.join(directory, `${label}.stdout`), stderrFile = path.join(directory, `${label}.stderr`);
  const [stdout, stderr] = await Promise.all([fs.open(stdoutFile, 'wx', 0o600), fs.open(stderrFile, 'wx', 0o600)]);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const actualArgs = executable === 'opencode' && args[0] === 'run' && process.env.TRANSFER_OPENCODE_MODEL
        ? [...args, '--model', process.env.TRANSFER_OPENCODE_MODEL] : args;
      const child = spawn(executable, actualArgs, { cwd: executable === 'codex' ? home : workspace, env, stdio: ['pipe', stdout.fd, stderr.fd] });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 150000);
      const force = setTimeout(() => child.kill('SIGKILL'), 155000);
      child.once('error', error => { clearTimeout(timer); clearTimeout(force); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); resolve({ code, signal, timedOut, seconds: Math.round((Date.now() - start) / 100) / 10 }); });
      child.stdin.end(input);
    });
  } finally { await stdout.close(); await stderr.close(); }
  assert.equal(result.code, 0, `${label}: CLI exit ${JSON.stringify(result)}; see ${stderrFile}`);
  return { ...result, stdout: await fs.readFile(stdoutFile, 'utf8'), stderr: await fs.readFile(stderrFile, 'utf8') };
};
const eventsOf = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const textOf = events => events.filter(e => e.type === 'text').map(e => e.part?.text ?? e.text ?? '').join('\n');
const opencodeEnv = {
  ...process.env,
  OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'),
  OPENCODE_CONFIG: path.join(os.homedir(), '.config/opencode/opencode.json'),
  OPENCODE_PERMISSION: JSON.stringify({
    skill: { '*': 'deny', [name]: 'allow' }, bash: 'deny', edit: 'deny', webfetch: 'deny',
    read: { '*': 'deny', [home + '/**']: 'allow' },
    external_directory: { '*': 'deny', [home + '/**']: 'allow' },
  }),
};
const check = async (label, run) => {
  console.log(`START ${label}`);
  try { const detail = await run(); results.push({ label, status: 'passed', ...detail }); console.log(`PASS ${label}`); }
  catch (error) { failures.push({ label, status: 'failed', message: String(error).slice(0, 1800) }); console.log(`FAIL ${label}: ${String(error).slice(0, 280)}`); }
};

try {
  const bootstrap = path.join(directory, 'bootstrap.cjs');
  await put(bootstrap, `const {app,dialog,net}=require('electron');app.setAppPath(${JSON.stringify(root)});net.fetch=async()=>{throw new Error('isolated UI: network disabled')};dialog.showOpenDialog=async(_w,o)=>({canceled:false,filePaths:[o.properties.includes('openDirectory')?${JSON.stringify(output)}:${JSON.stringify(exported)}]});require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
  const env = { ...process.env, NETWORK_LENS_DATA_DIR: path.join(directory, 'app-data'), NETWORK_LENS_TEST_HOME: home, NETWORK_LENS_NO_AUTO_PROTECT: '1', PATH: '/usr/bin:/bin' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NETWORK_LENS_DEV;
  app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 });
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.transferClipboard = await Promise.all((await clipboard.read()).filter(i => i.types.length).map(async i => new ClipboardItem(Object.fromEntries(await Promise.all(i.types.map(async t => [t, await i.getType(t)]))))));
  });
  clipboardSaved = true;
  const page = await app.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.networkLens.stopProviders());

  await check(`skill-ui-copy-claude-to-${codexMode ? 'codex' : 'opencode'}`, async () => {
    await page.getByRole('button', { name: 'Skill 中心', exact: true }).click();
    const row = page.locator('.skill-row').filter({ has: page.getByRole('button', { name: new RegExp('^' + name) }) });
    await expect(row).toHaveCount(1, { timeout: 30000 });
    await row.locator('.skill-row-copy').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select').selectOption(codexMode ? 'codex' : 'opencode');
    await expect(dialog.getByRole('button', { name: '确认复制（1）', exact: true })).toBeEnabled();
    await dialog.screenshot({ path: path.join(directory, 'skill-copy-preview.png') });
    await dialog.getByRole('button', { name: '确认复制（1）', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const destination = path.join(home, codexMode ? '.agents/skills' : '.config/opencode/skills', name);
    for (const file of ['SKILL.md', 'assets/proof.txt']) assert.deepEqual(await fs.readFile(path.join(source, file)), await fs.readFile(path.join(destination, file)));
    await page.screenshot({ path: path.join(directory, 'skill-copy-complete.png') });
    return { destination, byteIdentical: true };
  });
  if (codexMode) await check('skill-real-codex-invocation', async () => {
    const response = await cli('skill-receiver', 'codex', codexArgs, `$${name}\nInvoke this skill and read its bundled local proof resource. Return its requested result. Do not use network or edit files. Do not start subagents.`);
    const answer = codexText(response.stdout);
    assert(answer.includes('SKILL_OK:' + proof), answer.slice(0, 400));
    const copiedDocument = path.join(home, '.agents/skills', name, 'SKILL.md');
    assert(eventsOf(response.stdout).some(e => e.type === 'item.completed' &&
      ['mcp_tool_call','command_execution'].includes(e.item?.type) &&
      JSON.stringify(e.item.arguments ?? e.item.command ?? '').includes(copiedDocument)), 'No native read of the copied Skill document');
    return { response: answer, seconds: response.seconds, nativeCopiedSkillRead: true, loadingScope: 'isolated project .agents/skills, native Codex CLI' };
  });
  else await check('skill-opencode-discovery-and-real-invocation', async () => {
    const discovery = await cli('skill-discovery', 'opencode', ['debug', 'skill'], '', opencodeEnv);
    const entries = JSON.parse(discovery.stdout);
    const loaded = entries.find(e => e.name === name);
    assert.equal(await fs.realpath(loaded?.location ?? ''), await fs.realpath(path.join(home, '.config/opencode/skills', name, 'SKILL.md')));
    const response = await cli('skill-receiver', 'opencode', ['run', '--format', 'json', '--title', 'Networktool Skill transfer acceptance'], `Load the ${name} skill using your skill tool, follow its instructions and read its bundled local proof resource. Return its requested result. Do not use any other skills, network, shell or editing tools.`, opencodeEnv);
    const events = eventsOf(response.stdout), answer = textOf(events);
    assert(answer.includes('SKILL_OK:' + proof), 'Receiver did not return the proof stored only in the copied resource');
    assert(events.some(e => e.type === 'tool_use' && e.part?.tool === 'skill' && e.part?.state?.status === 'completed'), 'No successful native skill-tool event');
    return { discoveredPath: loaded.location, response: answer, seconds: response.seconds };
  });

  const copyPreview = async (dialog, attachment = false) => {
    await dialog.getByRole('button', { name: '生成接续预览', exact: true }).click();
    for (const checkbox of await dialog.locator('.handoff-confirmations input').all()) await checkbox.check();
    await dialog.getByRole('button', { name: attachment ? '导出附件并复制' : '确认并复制接续内容', exact: true }).click();
    await expect(dialog.locator('.handoff-success')).toBeVisible();
    const prompt = await dialog.locator('.handoff-prompt').innerText();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), prompt);
    return prompt;
  };
  let textPrompt;
  await check(`handoff-claude-to-${codexMode ? 'codex' : 'opencode'}-without-attachments-ui`, async () => {
    await page.getByRole('button', { name: '任务接续', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled({ timeout: 30000 });
    await page.getByRole('tab', { name: /^Claude Code/ }).click();
    await expect(page.locator('.handoff-task')).toHaveCount(1);
    await page.getByRole('button', { name: '接续', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: codexMode ? 'Codex' : 'OpenCode', exact: true }).click();
    await dialog.getByRole('radio', { name: '仅继续对话', exact: true }).check();
    await dialog.getByRole('textbox', { name: '本次继续做什么' }).fill('根据历史记录的累计值和下一步继续计算。只回复 HANDOFF_OK:<计算结果>。不要调用工具、读取文件或执行命令。');
    textPrompt = await copyPreview(dialog);
    assert(textPrompt.includes('37') && textPrompt.includes('5'));
    await put(path.join(directory, 'text-handoff-prompt.txt'), textPrompt);
    await dialog.screenshot({ path: path.join(directory, 'text-handoff-copied.png') });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    return { clipboardMatchesPreview: true, scope: 'conversation' };
  });
  await check(`handoff-real-${codexMode ? 'codex' : 'opencode'}-text-receiver`, async () => {
    assert(textPrompt, 'UI did not produce a handoff prompt');
    const response = await cli('text-receiver', codexMode ? 'codex' : 'opencode', codexMode ? codexArgs : ['run', '--format', 'json', '--title', 'Networktool text handoff acceptance'], textPrompt, codexMode ? process.env : opencodeEnv);
    const answer = codexMode ? codexText(response.stdout) : textOf(eventsOf(response.stdout));
    assert(answer.includes('HANDOFF_OK:42'), answer.slice(0, 400));
    return { response: answer, seconds: response.seconds };
  });
  let attachmentPrompt;
  await check(`handoff-opencode-to-${codexMode ? 'codex' : 'claude'}-with-attachments-ui`, async () => {
    await page.getByRole('tab', { name: /^OpenCode/ }).click();
    await page.getByRole('button', { name: '导入 JSON', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: codexMode ? 'Codex' : 'Claude Code', exact: true }).click();
    await dialog.getByRole('textbox', { name: '本次继续做什么' }).fill('仅在本次导出的附件包内验证：读取 requirements.txt 的验收码，并核对 tiny.png 的像素宽高。请用只读方式解析 ZIP（可用 Python zipfile），不要访问其他文件或网络。只回复 BUNDLE_OK:<验收码>:<宽>x<高>。');
    await dialog.getByRole('button', { name: '需要带附件？点此选择', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /同时打包附件/ }).check();
    await expect(dialog).toContainText('可打包 2 条');
    attachmentPrompt = await copyPreview(dialog, true);
    assert(!attachmentPrompt.includes(attachmentProof), 'Proof must not be present in the copied prompt');
    await put(path.join(directory, 'attachment-handoff-prompt.txt'), attachmentPrompt);
    const zips = (await fs.readdir(output)).filter(file => file.endsWith('.zip'));
    assert.equal(zips.length, 1);
    await dialog.screenshot({ path: path.join(directory, 'attachment-handoff-copied.png') });
    return { zip: path.join(output, zips[0]), clipboardMatchesPreview: true, proofOnlyInAttachment: true, imageSha256: createHash('sha256').update(png).digest('hex') };
  });
  await check(`handoff-real-${codexMode ? 'codex' : 'claude'}-attachment-receiver`, async () => {
    assert(attachmentPrompt, 'UI did not export a handoff package');
    const response = await cli('attachment-receiver', codexMode ? 'codex' : 'claude', codexMode ? codexArgs : ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Bash', '--allowedTools', 'Read', 'Bash(python3 *)', '--max-turns', '6'], attachmentPrompt);
    const events = eventsOf(response.stdout), final = events.findLast(e => e.type === 'result');
    const answer = codexMode ? codexText(response.stdout) : final?.result ?? '';
    assert(answer.includes('BUNDLE_OK:' + attachmentProof + ':1x1'), answer.slice(0, 600));
    assert(events.some(e => codexMode ? e.type === 'item.completed' && ['command_execution','mcp_tool_call'].includes(e.item?.type) : e.type === 'assistant' && e.message?.content?.some(p => p.type === 'tool_use')), 'No native tool invocation to read ZIP');
    return { response: answer, seconds: response.seconds };
  });
  assert.deepEqual(rendererErrors, []);
} finally {
  if (app && clipboardSaved) await app.evaluate(async ({ clipboard }) => {
    if (globalThis.transferClipboard.length) await clipboard.write(globalThis.transferClipboard);
    else clipboard.clear();
  }).catch(() => {});
  if (app) await app.close();
  await put(path.join(directory, 'results.json'), JSON.stringify({ date: '2026-11-12', mode: 'synthetic-source-sessions + real renderer/IPC + real CLI receivers', receivers: codexMode ? ['Codex'] : ['OpenCode','Claude Code'], directory, results, failures, rendererErrors, limitations: ['Source conversations are synthetic native-format fixtures, not real user conversations.', 'Existing user skills/configuration are unchanged. Receiver CLIs may create their own normal runtime/session state.'] }, null, 2));
}
console.log(JSON.stringify({ directory, passed: results.length, failed: failures.length }));
if (failures.length) process.exitCode = 1;
