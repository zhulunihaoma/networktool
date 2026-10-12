import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { SkillCheck } from "../../src/shared/skills";
import { cliDirectories } from "./tool-discovery";

const run = promisify(execFile);
export type SkillDiscovery = { check: SkillCheck; entries?: { name: string; location: string }[] };
export type SkillProbe = (home: string) => Promise<SkillDiscovery>;

// Some OpenCode builds exit before flushing a large JSON payload to a pipe.
// Direct stdout to a private file, then read a bounded result and always remove it.
async function readDiscovery(executable: string, home: string) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "skill-discovery-"));
  const output = path.join(temporary, "skills.json");
  const handle = await fs.open(output, "wx", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["debug", "skill"], { cwd: home, env: commandEnvironment(executable), stdio: ["ignore", handle.fd, "ignore"], windowsHide: true });
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(signal ? "timeout" : "command_failed"));
      });
    });
    if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error("output_limit");
    return await fs.readFile(output, "utf8");
  } finally {
    await handle.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function commandEnvironment(executable: string) {
  // Finder may omit nvm/fnm from PATH; include the selected launcher's runtime.
  return { ...process.env, PATH: [path.dirname(executable), process.env.PATH ?? ""].join(path.delimiter) };
}

// Inspect explicit Markdown resource links; prose is not an executable dependency manifest.
export async function checkSkillResources(directory: string, text: string): Promise<SkillCheck[]> {
  const checks: SkillCheck[] = [];
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm, "");
  const links = [...prose.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(match => match[1]);
  const relative = [...new Set(links.filter(link => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)))];
  for (const link of relative.slice(0, 100)) {
    let file: string;
    try { file = decodeURIComponent(link.split(/[?#]/)[0]); }
    catch { checks.push({ label: "资源引用", state: "warning", detail: "存在无法解析的资源链接" }); continue; }
    const absolute = path.resolve(directory, file);
    const local = path.relative(directory, absolute);
    if (local.startsWith("..") || path.isAbsolute(local) || path.isAbsolute(file)) {
      checks.push({ label: "外部资源", state: "unverified", detail: `${link} 不在 Skill 内，复制不包含它` }); continue;
    }
    try {
      await fs.access(absolute, constants.R_OK);
      checks.push({ label: "资源引用", state: "passed", detail: `${link} 可读取` });
    } catch { checks.push({ label: "资源引用", state: "failed", detail: `${link} 缺失或不可读取` }); }
  }
  if (relative.length > 100) checks.push({ label: "资源引用", state: "unverified", detail: "超过 100 条资源链接，仅检查前 100 条" });
  if (!relative.length) checks.push({ label: "资源引用", state: "unverified", detail: "未发现可自动校验的本地 Markdown 链接；正文中的其他资源要求需运行验证" });
  return checks;
}

// A bounded discovery call, never an arbitrary skill task or its scripts.
// `debug skill` enumerates skills before per-agent permission filtering.
export const discoverOpenCode: SkillProbe = async (home) => {
  const unavailable = (detail: string): SkillDiscovery => ({ check: { label: "OpenCode 实际发现", state: "unverified", detail } });
  if (await fs.realpath(home).catch(() => home) !== await fs.realpath(os.homedir()).catch(() => os.homedir())) return unavailable("隔离目录未连接真实 OpenCode，仅做规则检查");
  const directories = await cliDirectories(home);
  let executable: string | undefined;
  for (const directory of directories) {
    const candidate = path.join(directory, process.platform === "win32" ? "opencode.exe" : "opencode");
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* next candidate */ }
  }
  if (!executable) return unavailable("未找到 OpenCode CLI；目录存在不代表工具已安装");
  try {
    const { stdout: versionText } = await run(executable, ["--version"], { cwd: home, env: commandEnvironment(executable), timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
    const version = versionText.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0];
    const stdout = await readDiscovery(executable, home);
    let entries: unknown;
    try { entries = JSON.parse(stdout); }
    catch { return unavailable(`OpenCode ${version ?? "版本未知"} 返回的发现结果不是完整 JSON，不能判定已识别`); }
    if (!Array.isArray(entries) || entries.some(value => !value || typeof value.name !== "string" || typeof value.location !== "string")) return unavailable("当前 CLI 的技能列表格式不受支持，不能判定已识别");
    return { check: { label: "OpenCode 实际发现", state: "passed", detail: `OpenCode ${version ?? "版本未知"} 已返回技能目录；不代表 Agent 权限允许调用` }, entries: entries.map(({ name, location }) => ({ name, location })) };
  } catch (error) {
    const reason = (error as Error).message;
    return unavailable(reason === "output_limit" ? "发现结果超过 8 MB，未作识别结论" : reason === "timeout" ? "OpenCode 发现检查超过 10 秒，已停止；文件保留" : "OpenCode 发现检查失败或命令不受支持；文件保留，运行状态未验证");
  }
};

export async function matchDiscoveredSkill(discovery: SkillDiscovery, name: string, document: string): Promise<SkillCheck> {
  if (!discovery.entries) return discovery.check;
  const canonical = await fs.realpath(document).catch(() => path.resolve(document));
  const named = discovery.entries.filter(entry => entry.name === name);
  for (const entry of named) {
    if (!path.isAbsolute(entry.location)) continue;
    if (await fs.realpath(entry.location).catch(() => path.resolve(entry.location)) === canonical) return { ...discovery.check, detail: `${discovery.check.detail}；发现路径与本次目标文件一致` };
  }
  return { label: "OpenCode 实际发现", state: "failed", detail: named.length ? "发现同名 Skill，但加载位置不是本次目标文件，可能被其他目录覆盖" : "当前 OpenCode 技能列表中没有本次 Skill" };
}
