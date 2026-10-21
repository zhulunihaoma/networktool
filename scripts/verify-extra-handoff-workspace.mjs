/** Isolated native SQLite/Zstandard + real IPC/renderer/clipboard acceptance. --live never copies or sends. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { _electron, expect } = require('@playwright/test');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'network-extra-handoff-'));
const live = process.argv.includes('--live');
const home = live ? os.homedir() : path.join(temporary, 'home');
const id = '12345678-1234-4234-8234-123456789abc';
const extra = ['WorkBuddy', 'ZCode', 'WisCode', 'DeepSeekHarness', 'CopilotCode'];
const label = { WorkBuddy: 'WorkBuddy', ZCode: 'ZCode', WisCode: 'WisCode', DeepSeekHarness: 'DeepSeek Harness', CopilotCode: '极库 Copilot Code' };
const sources = new Map();
const put = async (relative, data) => {
  const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data); await fs.writeFile(file, content); sources.set(file, content);
};
const lines = (...rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
let app;
try {
  if (!live) {
    await put(`.workbuddy/projects/demo/${id}.jsonl`, lines(
      { type: 'message', role: 'user', id: 'u', sessionId: id, content: [{ type: 'text', text: '起点 37，待办加 5。RELAY_MARKER token=fixture-private' }] },
      { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'function_call_result', output: 'PRIVATE_TOOL' },
      { type: 'message', role: 'assistant', id: 'a', sessionId: id, content: [{ type: 'text', text: '准备接力。' }] },
    ));
    await put(`.wiscode/claude-agents/projects/demo/${id}.jsonl`, lines(
      { type: 'user', sessionId: id, cwd: '/fixture/wiscode', message: { content: '起点 37，待办加 5。RELAY_MARKER token=fixture-private' } },
      { type: 'assistant', sessionId: id, message: { content: [{ type: 'text', text: '准备接力。' }, { type: 'thinking', thinking: 'PRIVATE_REASONING' }] } },
    ));
    await put(`.roo-cline/globalStorage/ultra-ai.copilotcodepro/tasks/${id}/ui_messages.json`, [
      { type: 'say', say: 'text', text: '起点 37，待办加 5。RELAY_MARKER token=fixture-private' },
      { type: 'say', say: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'ask', ask: 'tool', text: 'PRIVATE_TOOL' },
      { type: 'say', say: 'completion_result', text: '准备接力。' },
    ]);
    await put(`.dsh/storages/session_projcache/sessions/session-${id}.json`, { version: 1, record: { identity: { cwd: '/fixture/dsh', createdAt: 1 }, rows: { title: { val: 'DSH 原生标题' }, subagent: { val: {} }, sessionListMetadata: { val: { blank: false, lastPromptAt: 1000 } }, turnOutline: { val: { turns: [{ prompt: 'TRUNCATED_SUMMARY' }] } } } } });
    for (const relative of ['.workbuddy', '.zcode/cli/db', '.zcode/v2', `.dsh/sessions/demo/session-${id}`]) await fs.mkdir(path.join(home, relative), { recursive: true });
  }
  const dshRaw = lines(
    { type: 'session', id: `session-${id}`, cwd: '/fixture/dsh', version: 4 },
    { type: 'user/message', data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: '起点 37，待办加 5。RELAY_MARKER token=fixture-private' }] } },
    { type: 'user/message', data: { id: 'system', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'PRIVATE_REASONING' }] } },
    { type: 'text-chunks', data: { texts: ['STREAM_DUPLICATE'] } },
    { type: 'assistant/message', data: { message: { id: 'a', content: [{ type: 'text', text: '准备接力。' }] } } },
  );
  const setup = `
    const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');globalThis.fixtureDbs=[];
    const home=${JSON.stringify(home)},id=${JSON.stringify(id)};
    function dbAt(relative,sql){const d=new DatabaseSync(path.join(home,relative));d.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;'+sql);globalThis.fixtureDbs.push(d);return d;}
    const w=dbAt('.workbuddy/workbuddy.db','CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,custom_title TEXT,updated_at INTEGER,deleted_at INTEGER,is_background_automation INTEGER,visibility TEXT)');
    const ins=w.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)');ins.run(id,'/fixture/workbuddy','WorkBuddy 原生标题','自定义接力标题',1000,null,0,null);ins.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','/fixture/hidden','PRIVATE_TITLE',null,2000,null,1,null);
    const z=dbAt('.zcode/cli/db/db.sqlite','CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER,parent_id TEXT,time_archived INTEGER,time_deleted INTEGER,task_type TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,sequence INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,sequence INTEGER,data TEXT)');
    z.prepare('INSERT INTO session VALUES(?,?,?,?,?,?,?,?)').run('sess_'+id,'ZCode 原生标题','/fixture/zcode',1000,null,null,null,'interactive');
    const m=z.prepare('INSERT INTO message VALUES(?,?,?,?,?)'),p=z.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
    for(const [n,role,text,hidden] of [[1,'user','起点 37，待办加 5。RELAY_MARKER token=fixture-private',false],[2,'user','PRIVATE_REASONING',true],[3,'assistant','准备接力。',false]]){m.run('m'+n,'sess_'+id,n,n,JSON.stringify({role,semantics:{uiVisibility:hidden?'hidden':'visible'}}));p.run('p'+n,'m'+n,'sess_'+id,n,n,JSON.stringify({type:'text',text}));}
    const zi=dbAt('.zcode/v2/tasks-index.sqlite','CREATE TABLE tasks(task_id TEXT,title TEXT,workspace_path TEXT,deleted INTEGER,archived INTEGER,host_id TEXT)');zi.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run('sess_'+id,'ZCode 客户端改名','/fixture/zcode',0,0,'local');
    fs.writeFileSync(path.join(home,'.dsh/sessions/demo/session-'+id+'/session.v4.jsonl.zstd'),Buffer.concat(${JSON.stringify(dshRaw)}.split('\\n').filter(Boolean).map(line=>require('node:zlib').zstdCompressSync(Buffer.from(line+'\\n')))));
  `;
  const bootstrap = path.join(temporary, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `const {app,net}=require('electron');app.setAppPath(${JSON.stringify(root)});${!live ? `app.setPath('home',${JSON.stringify(home)});${setup}` : ''}net.fetch=async()=>{throw new Error('test network disabled')};require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
  const env = { ...process.env, HOME: home, NETWORK_LENS_DATA_DIR: path.join(temporary, 'data') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NETWORK_LENS_DEV;
  app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '任务接续', exact: true }).click();
  await expect(page.getByRole('button', { name: '识别本机工具', exact: true })).toBeEnabled({ timeout: 30000 });
  if (!live) await app.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.extraClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); });
  const discovered = await page.evaluate(() => window.networkLens.discoverHandoffTools());
  const report = [];
  for (const source of extra) {
    assert(discovered.find(t => t.id === source)?.readable, `${source} not discovered`);
    await page.getByRole('tab', { name: new RegExp('^' + label[source]) }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled({ timeout: 45000 });
    await expect(page.locator('.handoff-origin > span')).toContainText(label[source], { timeout: 45000 });
    await expect(page.locator('.handoff-browser').getByRole('alert')).toHaveCount(0);
    const cards = page.locator('.handoff-task');
    const count = await cards.count(); assert(count > 0, `${source} empty`);
    const result = await page.evaluate(async source => {
      const page = await window.networkLens.browseSourceTasks(source);
      const failures = [];
      const engineChecks = [];
      if (source === 'WisCode') {
        for (const prefix of ['claude:', 'codex:']) {
          const candidate = page.tasks.find(task => task.id.startsWith(prefix));
          if (!candidate) continue;
          const value = await window.networkLens.importSourceTask(candidate.id, source);
          if (value.source !== source || !value.messageCount) throw new Error('WisCode engine import failed');
          engineChecks.push({ engine: prefix.slice(0, -1), messages: value.messageCount });
        }
      }
      for (const task of page.tasks.slice(0, 15)) {
        try {
          const imported = await window.networkLens.importSourceTask(task.id, source);
          if (!imported.messageCount) throw new Error('empty transcript');
          return { count: page.total, importedSource: imported.source, messages: imported.messageCount, chars: imported.transcript.length, redactions: imported.redactions, failures, engineChecks };
        } catch (error) { failures.push(String(error.message).slice(0, 150)); }
      }
      throw new Error(source + ': no importable record: ' + failures.join(';'));
    }, source);
    assert.equal(result.importedSource, source); report.push({ source, ...result });
    if (live) console.log(JSON.stringify({ source, ...result }));
    if (live) continue;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(cards).toHaveCount(1);
    await cards.getByRole('button', { name: '接力', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
    await dialog.getByRole('textbox', { name: '本次继续做什么' }).fill('读取历史中的起点并加 5，只回复计算结果。');
    await dialog.getByRole('button', { name: '生成接力预览' }).click();
    const prompt = await dialog.locator('.handoff-prompt').innerText();
    assert(prompt.includes('RELAY_MARKER') && prompt.includes('37'));
    for (const excluded of ['fixture-private', 'PRIVATE_REASONING', 'PRIVATE_TOOL', 'STREAM_DUPLICATE', 'TRUNCATED_SUMMARY']) assert(!prompt.includes(excluded), `${source} leaked ${excluded}`);
    await dialog.getByRole('checkbox', { name: /原任务已停止/ }).check();
    await dialog.getByRole('checkbox', { name: /已确认目标工具/ }).check();
    await dialog.getByRole('checkbox', { name: /已检查全文/ }).check();
    await dialog.getByRole('button', { name: '确认并复制接力内容', exact: true }).click();
    await expect(dialog).toContainText('已复制，接下来粘贴到 Codex');
    assert.equal(await app.evaluate(async ({ clipboard }) => clipboard.readText()), prompt);
    await dialog.getByRole('button', { name: '关闭接力弹窗' }).click();
  }
  if (!live) {
    for (const [file, original] of sources) assert.equal(await fs.readFile(file, 'utf8'), original, 'source changed');
    await page.getByRole('tab', { name: /^WorkBuddy/ }).click();
    await expect(page.locator('.handoff-task')).toHaveCount(1);
    await page.screenshot({ path: path.join(temporary, 'workbuddy-list.png') });
    await page.setViewportSize({ width: 1024, height: 720 });
    const bounds = await page.locator('.handoff-page').evaluate(el => ({ right: el.getBoundingClientRect().right, width: innerWidth })); assert(bounds.right <= bounds.width + 1);
    await page.screenshot({ path: path.join(temporary, 'tools-1024.png') });
    const methods = await app.evaluate(() => globalThis.fixtureDbs.map(db => db.prepare("SELECT COUNT(*) AS count FROM sqlite_master").get().count)); assert(methods.every(n => n > 0));
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(temporary, 'report.json'), JSON.stringify({ live, tools: discovered.map(t => ({ id: t.id, installed: t.installed, historyFound: t.historyFound, readable: t.readable })), imports: report }, null, 2));
  console.log(JSON.stringify({ live, imports: report, evidence: temporary }, null, 2));
} finally {
  if (app) {
    if (!live) await app.evaluate(async ({ clipboard }) => { if (globalThis.extraClipboardBackup) await clipboard.write(globalThis.extraClipboardBackup); }).catch(() => {});
    await app.close().catch(() => {});
  }
}
