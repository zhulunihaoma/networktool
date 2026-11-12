import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDoctor } from "../electron/security/doctor";
test("体检报告权限修复、显式危险设置和JSONC权限，始终隐藏凭据",async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"nl-doctor-"));
 const put=async(name:string,text:string,mode=0o600)=>{const file=path.join(home,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text,{mode});return file;};
 try {
  const credential=await put(".codex/auth.json",'{"token":"never-show-98765"}',0o644);
  await put(".codex/config.toml",'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
  await put(".config/opencode/opencode.jsonc",'{// comment\n"permission":{"bash":"allow"},}');
  await put(".zcode/v2/config.json",'{"provider":{"x":{"options":{"apiKey":"never-show-98765"}}}}');
  const report=await runDoctor(home);
  assert.ok(report.findings.some(f=>f.id==="codex:approval"));assert.ok(report.findings.some(f=>f.id==="codex:sandbox"));assert.ok(report.findings.some(f=>f.id==="opencode:bash-allow"));
  const fix=report.findings.find(f=>f.autoFix?.path===credential)?.autoFix;assert.equal(fix?.mode,0o600);assert.equal(fix?.fromMode,0o644);
  assert.ok(!JSON.stringify(report).includes("never-show-98765"));
  await fs.chmod(credential,0o600);assert.ok(!(await runDoctor(home)).findings.some(f=>f.autoFix?.path===credential));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
