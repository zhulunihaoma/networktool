/** Electron verification for official RPC, Desktop project metadata and WAL. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const { _electron, expect } = require('@playwright/test');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'network-codex-workspace-'));
const live = process.argv.includes('--live');
const receiver = process.argv.includes('--receiver');
if (live && receiver) throw new Error('Live verification never sends real private history to another tool.');
const fixtureHome = path.join(temporary, 'home');
const codexHome = path.join(fixtureHome, '.codex');
const shopRoot = '/private/tmp/shop_agent-fixture/shop_agent';
const shopId = '12345678-1234-4234-8234-123456789abc';
const liveRoot = '/private/tmp/shop_agent-migration-backup-20261016-221707/shop_agent';
const projectTitle = 'shop_agent';
let app;
const fixtures = [];
const title = '任务记录增加创建日期，详情里面添加视频地址。';
try {
  await fs.mkdir(codexHome, { recursive: true });
  const globalState = { 'local-projects': { 'legacy-shop': { id: 'legacy-shop', name: projectTitle, rootPaths: [shopRoot] }, 'empty': { id: 'empty', name: '已登记空项目', rootPaths: ['/empty'] } }, 'project-order': ['legacy-shop', 'empty'] };
  const globalFile = path.join(codexHome, '.codex-global-state.json');
  await fs.writeFile(globalFile, JSON.stringify(globalState));
  const date = path.join(codexHome, 'sessions/2026/10/20');
  await fs.mkdir(date, { recursive: true });
  for (const suffix of ['old', 'resume', 'latest']) {
    const file = path.join(date, `rollout-${shopId}-${suffix}.jsonl`);
    const content = JSON.stringify({ type: 'session_meta', payload: { id: shopId, cwd: shopRoot, source: 'vscode' } }) + '\n';
    await fs.writeFile(file, content); fixtures.push([file, content]);
  }
  const current = path.join(date, `rollout-${shopId}-latest.jsonl`);
  const threads = Array.from({ length: 61 }, (_, i) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, name: `新的项目会话 ${i}`, cwd: '/new-project', source: 'vscode', threadSource: 'user', updatedAt: 10000 - i, historyMode: 'paginated', path: current }));
  threads.push({ id: shopId, name: title, cwd: shopRoot, source: 'vscode', threadSource: 'user', projectId: null, updatedAt: 1, historyMode: 'paginated', path: current });
  threads.push({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Guardian review', cwd: shopRoot, source: { subagent: { other: 'guardian' } }, threadSource: 'guardian_review', updatedAt: 20000, historyMode: 'paginated', path: current });
  const dataFile = path.join(temporary, 'threads.json'), callLog = path.join(temporary, 'rpc-calls.jsonl');
  await fs.writeFile(dataFile, JSON.stringify(threads));
  const executable = path.join(fixtureHome, '.local/bin/codex');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('generate-json-schema')){const out=process.argv[process.argv.indexOf('--out')+1];fs.mkdirSync(out+'/v2',{recursive:true});fs.writeFileSync(out+'/v2/ThreadListParams.json',JSON.stringify({properties:{useStateDbOnly:{type:'boolean'},sourceKinds:{type:'array'}}}));process.exit(0);}const readline=require('node:readline');const threads=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));const log=${JSON.stringify(callLog)};const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');if(!m.id)return;let result={};const p=m.params||{};if(m.method==='thread/list'){let rows=threads.filter(t=>typeof t.source==='string');if(p.cwd){const roots=Array.isArray(p.cwd)?p.cwd:[p.cwd];rows=rows.filter(t=>roots.includes(t.cwd));}if(p.searchTerm)rows=rows.filter(t=>t.name.includes(p.searchTerm));const start=Number(p.cursor)||0;result={data:rows.slice(start,start+p.limit),nextCursor:start+p.limit<rows.length?String(start+p.limit):null};}else if(m.method==='thread/read'){result={thread:threads.find(t=>t.id===p.threadId)};}else if(m.method==='thread/turns/list'){const turns=[{id:'turn-1',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'记录待办起点 37，再加 5。OFFICIAL_HISTORY_MARKER token=fixture-private'}]},{id:'a1',type:'agentMessage',text:'已经记下，等待接力。'},{id:'private',type:'reasoning',text:'PRIVATE_REASONING'}]},{id:'turn-2',items:[{id:'u2',type:'userMessage',content:[{type:'text',text:'继续这个待办。'}]}]}];result={data:p.cursor?[turns[1]]:[turns[0]],nextCursor:p.cursor?null:'history-next'};}else if(m.method!=='initialize'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601}})+'\\n');return;}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`, { mode: 0o700 });
  const bootstrap = path.join(temporary, 'bootstrap.cjs');
  const fixtureSetup = `app.setPath('home',${JSON.stringify(fixtureHome)});const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(path.join(codexHome, 'state_42.sqlite'))});db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,preview TEXT,cwd TEXT,updated_at INTEGER,source TEXT,thread_source TEXT,rollout_path TEXT,project_id TEXT,history_mode TEXT,archived INTEGER)");db.prepare('INSERT INTO projects VALUES(?,?,?)').run('native-shop','数据库旧名称',0);db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('native-shop',${JSON.stringify(shopRoot)},0);db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('native-shop',${JSON.stringify(shopRoot + '/second-root')},1);const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');for(const t of ${JSON.stringify(threads)})insert.run(t.id,t.name,t.name,t.name,t.cwd,t.updatedAt,typeof t.source==='string'?t.source:JSON.stringify(t.source),t.threadSource,t.path,t.projectId||null,t.historyMode,0);globalThis.fixtureDb=db;`;
  await fs.writeFile(bootstrap, `const {app,net}=require('electron');app.setAppPath(${JSON.stringify(root)});${live ? '' : fixtureSetup}net.fetch=async()=>{throw new Error('test network disabled')};require(${JSON.stringify(path.join(root, 'dist-electron/main.cjs'))});`);
  const env = { ...process.env, NETWORK_LENS_DATA_DIR: path.join(temporary, 'data') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NETWORK_LENS_DEV;
  if (!live) env.HOME = fixtureHome;
  app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap], env, timeout: 30000 });
  if (!live) await app.evaluate(async ({clipboard,ClipboardItem}) => { globalThis.codexClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '任务接续', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled({ timeout: 35000 });
  await page.getByRole('tab', { name: /^Codex/ }).click();
  await expect(page.locator('.handoff-origin > span')).toHaveText('Codex 客户端会话', { timeout: 30000 });
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  if (!live) {
    await expect(page.locator('.handoff-task')).toHaveCount(50);
    await expect(page.locator('.handoff-projects')).toContainText(projectTitle);
    await expect(page.locator('.handoff-projects strong').filter({hasText:/^数据库旧名称$/})).toHaveCount(0);
    await expect(page.locator('.handoff-projects')).toContainText('已登记空项目');
    // The shop chat is older than the entire initial global page.
    await expect(page.locator('.handoff-task-title').filter({ hasText: title })).toHaveCount(0);
    await page.getByRole('button', { name: '加载更多会话', exact: true }).click();
    await expect(page.locator('.handoff-task')).toHaveCount(62);
    await expect(page.getByRole('button', { name: '加载更多会话', exact: true })).toHaveCount(0);
  }
  const projectButton = page.getByRole('navigation', { name: '项目分类' }).getByRole('button').filter({ has: page.locator('strong').filter({ hasText: /^shop_agent$/ }) }).filter({ hasText: live ? liveRoot : shopRoot });
  await projectButton.click();
  await expect(page.locator('.handoff-task')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('.handoff-task-title')).toHaveText(title);
  await expect(projectButton.locator('em')).toHaveText('1');
  assert(!(await page.locator('.handoff-task-list').innerText()).includes('Guardian review'));
  await page.screenshot({ path: path.join(temporary, 'codex-project.png') });
  await page.getByRole('button', { name: '预览记录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.handoff-transcript pre')).toBeVisible({ timeout: 30000 });
  await expect(dialog.locator('.handoff-source strong')).toHaveText(title);
  const transcript = await dialog.locator('.handoff-transcript pre').innerText();
  assert(transcript.length > 0);
  if (!live) {
    assert(transcript.includes('OFFICIAL_HISTORY_MARKER'));
    assert(!transcript.includes('fixture-private') && !transcript.includes('PRIVATE_REASONING'));
  }
  await dialog.getByRole('button', { name: '接力此会话' }).click();
  if (!live) { await dialog.getByRole('button', { name: 'Claude Code', exact: true }).click(); await dialog.getByRole('textbox', {name:'本次继续做什么'}).fill('按历史中记录的起点和待办完成加法，不调用工具或访问文件，只回复 HANDOFF_OK:<结果>。'); }
  await dialog.getByRole('button', { name: '生成接力预览' }).click();
  await expect(dialog.locator('.handoff-prompt')).toBeVisible();
  const prompt = await dialog.locator('.handoff-prompt').innerText();
  assert(prompt.includes(title));
  if (!live) assert(prompt.includes('OFFICIAL_HISTORY_MARKER'));
  await page.screenshot({ path: path.join(temporary, 'codex-preview.png') });
  if (!live) {
    await expect(dialog.getByRole('button',{name:'确认并复制接力内容'})).toBeDisabled();
    for (const check of await dialog.locator('.handoff-confirmations input').all()) await check.check();
    await dialog.getByRole('button',{name:'确认并复制接力内容'}).click();
    await expect(dialog.getByRole('status')).toContainText('已复制，接下来粘贴到 Claude Code');
    const copied = await app.evaluate(({clipboard}) => clipboard.readText());
    assert.equal(copied, prompt);
    await fs.writeFile(path.join(temporary, 'to-claude.txt'), copied);
    if (receiver) {
      const result = await new Promise((resolve,reject) => {
        const child=execFile('claude',['--print','--tools','','--no-session-persistence','--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings','{"disableAllHooks":true}','--output-format','json','--system-prompt','Validate the handoff using only the supplied prompt. Never use tools or access local data. Complete the current goal based on the quoted history.'],{cwd:temporary,timeout:120000,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout));
        child.stdin.end(copied);
      });
      await fs.writeFile(path.join(temporary,'claude-receiver.json'),result);
      assert.equal(JSON.parse(result).result.trim(),'HANDOFF_OK:42');
      console.log('Official history -> actual clipboard -> real Claude Code: HANDOFF_OK:42');
    }
  }

  await dialog.getByRole('button', { name: '关闭接力弹窗' }).click();
  if (!live) {
    await page.getByRole('navigation', { name: '项目分类' }).getByRole('button').filter({ hasText: '已登记空项目' }).click();
    await expect(page.locator('.handoff-conversations')).toContainText('这个项目还没有可读取的聊天');
    await expect(page.locator('.handoff-projects')).toContainText(projectTitle);
    await page.getByRole('navigation', { name: '项目分类' }).getByRole('button').filter({ hasText: '全部项目' }).click();
    // Search reaches an older thread outside the first global page.
    await page.getByRole('textbox', { name: '搜索对话' }).fill('创建日期');
    await expect(page.locator('.handoff-task')).toHaveCount(1);
    await expect(page.locator('.handoff-task-title')).toHaveText(title);
    const calls = (await fs.readFile(callLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(calls.every(call => ['initialize', 'initialized', 'thread/list', 'thread/read', 'thread/turns/list'].includes(call.method)));
    assert(calls.filter(call => call.method === 'thread/list').every(call => call.params.useStateDbOnly === true));
    assert(calls.some(call => call.method === 'thread/list' && Array.isArray(call.params.cwd) && call.params.cwd.includes(shopRoot) && call.params.cwd.includes(shopRoot + '/second-root')));
    assert(calls.filter(call => call.method === 'thread/turns/list').length >= 2);
    // Simulate unavailable official protocol. Metadata remains visible and
    // paginated history must not be replaced with an arbitrary rollout file.
    await fs.writeFile(executable, `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.locator('.handoff-origin > span')).toContainText('兼容读取', { timeout: 30000 });
    await expect(page.locator('.handoff-task')).toHaveCount(1);
    await page.getByRole('button', { name: '接力', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('分页历史');
    await expect(dialog.getByRole('button', { name: '生成接力预览' })).toBeDisabled();
    for (const [file, content] of fixtures) assert.equal(await fs.readFile(file, 'utf8'), content);
    assert.deepEqual(JSON.parse(await fs.readFile(globalFile, 'utf8')), globalState);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, mode: live ? 'native read-only verification' : 'isolated RPC + WAL verification', project: projectTitle, title, transcriptCharacters: transcript.length, checks: live ? ['registered project', 'one user chat', 'official title', 'official paginated transcript', 'handoff preview'] : ['native SQLite reads committed WAL', 'schema version 42 discovery', 'project alias and custom name', 'empty registered project', 'independent old project query', 'global pagination beyond 50', 'global title search', 'no duplicate chats or Guardian review', 'official history pagination', 'redaction', 'handoff preview', 'clipboard matches reviewed official history', 'visible fallback', 'no paginated-to-log fallback', 'no mutation RPC', 'source files unchanged', 'no renderer errors'], output: temporary }, null, 2));
} finally { if (app) { try { if (!live) await app.evaluate(async ({clipboard})=>{if(globalThis.codexClipboardBackup?.length) await clipboard.write(globalThis.codexClipboardBackup); else if(globalThis.codexClipboardBackup) clipboard.clear();}); } finally { await app.close(); } } }
