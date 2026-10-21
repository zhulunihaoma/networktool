import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServer, CodexRpcError, type CodexReadMethod } from "../electron/core/codex-app-server";

async function fixture(code: string, run: (file: string, home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rpc-test-"));
  const file = path.join(home, "server.cjs");
  try { await fs.writeFile(file, code); await run(file, home); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}
const listen = `const readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;`;

test("RPC handshake and split UTF-8 responses work; mutating methods cannot cross the bridge", async () => fixture(listen + `const data=Buffer.from(JSON.stringify({id:m.id,result:{name:'真实标题',home:process.env.CODEX_HOME}})+'\\n');const split=data.indexOf(Buffer.from('真'))+1;process.stdout.write(data.subarray(0,split));setTimeout(()=>process.stdout.write(data.subarray(split)),5);});`, async (file, home) => {
  const client = new CodexAppServer(process.execPath, home, [file], 2000);
  try {
    await client.initialize();
    const value = await client.call("thread/list", {});
    assert.equal(value.name, "真实标题"); assert.equal(value.home, home);
    await assert.rejects(client.call("turn/start" as CodexReadMethod, {}), /只读/);
  } finally { client.close(); }
}));

test("RPC method errors are structured and server diagnostic messages are not exposed", async () => fixture(listen + `process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'credential=private-value'}})+'\\n');});`, async (file, home) => {
  const client = new CodexAppServer(process.execPath, home, [file], 2000);
  try { await assert.rejects(client.call("thread/turns/list", {}), error => error instanceof CodexRpcError && error.code === -32601 && !error.message.includes("private-value")); }
  finally { client.close(); }
}));

test("RPC timeout and truncated responses terminate instead of hanging", async () => fixture('setInterval(()=>{},1000)', async (file, home) => {
  const client = new CodexAppServer(process.execPath, home, [file], 100);
  try { await assert.rejects(client.initialize(), /超时/); }
  finally { client.close(); }
}));
