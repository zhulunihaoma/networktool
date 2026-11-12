import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SkillComparison, SkillItem } from "../../src/shared/skills";
import { analyzeSkillTree, type SkillTreeAnalysis } from "./skill-copy-tree";
import { scanSkillFiles } from "../security/skill-scan";
import { checkMcpConfig } from "../security/mcp-check";
import { sanitizer } from "../../src/shared/handoff";
import { skillReferences } from "../../src/shared/skill-insights";

const DAY = 86400000;
const RULE_VERSION = "skill-catalog-v1";
interface CatalogEntry {
  firstSeen: number;
  changedAt: number;
  hash?: string;
  preserved?: boolean;
  ignoredHash?: string;
}
interface CatalogData {
  version: 1;
  entries: Record<string, CatalogEntry>;
}
export class SkillCatalog {
  private data: CatalogData = { version: 1, entries: {} };
  private cache = new Map<string, NonNullable<SkillItem["insight"]>["risk"]>();
  constructor(private home: string) {}
  private get folder() {
    return path.join(this.home, ".network-lens");
  }
  private get file() {
    return path.join(this.folder, "skill-catalog.json");
  }
  async load() {
    try {
      const parent = await fs.lstat(this.folder);
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Skill 观察目录不是普通目录");
      const h = await fs.open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if ((await h.stat()).size > 4 * 1024 * 1024)
          throw new Error("Skill 观察记录过大");
        const value = JSON.parse(await h.readFile("utf8")) as CatalogData;
        if (
          value.version !== 1 ||
          !value.entries ||
          typeof value.entries !== "object" ||
          Array.isArray(value.entries)
        )
          throw new Error("Skill 观察记录格式无效");
        for (const [id, entry] of Object.entries(value.entries)) {
          if (
            !/^[a-f0-9]{64}$/.test(id) ||
            !entry ||
            !Number.isFinite(entry.firstSeen) ||
            !Number.isFinite(entry.changedAt)
          )
            throw new Error("Skill 观察记录无效");
        }
        this.data = value;
      } finally {
        await h.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = { version: 1, entries: {} };
    }
  }
  async save() {
    try {
      await fs.mkdir(this.folder, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const parent = await fs.lstat(this.folder);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("Skill 观察目录不是普通目录");
    const temp = path.join(this.folder, `.skill-catalog-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(this.data), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  async enrich(items: SkillItem[], now = Date.now()) {
    await this.load();
    if (this.cache.size > 1500) this.cache.clear();
    let index = 0;
    const worker = async () => {
      while (index < items.length) {
        const item = items[index++];
        const old = this.data.entries[item.id];
        const entry = old ?? { firstSeen: now, changedAt: now };
        const insight: NonNullable<SkillItem["insight"]> = {
          checkedAt: new Date(now).toISOString(),
          firstSeenAt: new Date(entry.firstSeen).toISOString(),
          changedAt: new Date(entry.changedAt).toISOString(),
          change: old ? "unchanged" : "new",
          preserved: entry.preserved === true,
          riskIgnored: false,
          mcp: [],
        };
        item.insight = insight;
        if (item.kind && !["skill", "linked-skill"].includes(item.kind)) {
          insight.checkError = item.description;
          continue;
        }
        try {
          const stat = await fs.stat(item.path);
          insight.realPath = await fs.realpath(item.path);
          insight.identity = `${stat.dev}:${stat.ino}:${insight.realPath}`;
          const analysis = await analyzeSkillTree(item.path);
          insight.hash = analysis.hash;
          insight.dependencies = analysis.entries
            .filter((e) => e.kind === "external-link")
            .map((e) => e.target!)
            .filter(Boolean);
          if (
            analysis.entries.some(
              (e) => e.kind === "external-link" && e.targetKind === "directory",
            )
          )
            insight.checkError = "存在目录外部依赖，未对外部目录内容作完整比对";
          if (entry.hash && entry.hash !== analysis.hash) {
            entry.changedAt = now;
            insight.changedAt = new Date(now).toISOString();
            insight.change = "changed";
          }
          entry.hash = analysis.hash;
          insight.riskIgnored =
            entry.ignoredHash === `${RULE_VERSION}:${analysis.hash}`;
          const cacheKey = `${RULE_VERSION}:${analysis.hash}`;
          insight.risk = this.cache.get(cacheKey);
          if (!insight.risk) {
            insight.risk = await scanSkillFiles(
              analysis.entries
                .filter((e) => e.kind === "file")
                .map((e) => ({ relative: e.relative, location: e.source })),
              undefined,
              analysis.entries.some((e) => e.kind === "external-link"),
            );
            this.cache.set(cacheKey, insight.risk);
          }
          for (const file of analysis.entries.filter(
            (e) =>
              e.kind === "file" && /(^|[\\/])\.?mcp\.json$/i.test(e.relative),
          )) {
            const text = await fs.readFile(file.source, "utf8");
            if (Buffer.byteLength(text) > 200000) {
              insight.riskError = "MCP 配置超过检查限额";
              continue;
            }
            const report = checkMcpConfig(text);
            insight.mcp.push({ file: file.relative, report });
          }
        } catch (error) {
          insight.checkError = (error as Error).message;
          insight.riskError = "目录未能完整检查，请查看完整性依据后重新扫描";
        }
        this.data.entries[item.id] = entry;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await this.save();
  }
  async preference(
    item: SkillItem,
    kind: "preserve" | "ignore-risk",
    value: boolean,
  ) {
    await this.load();
    const entry = this.data.entries[item.id];
    if (!entry) throw new Error("观察记录不存在，请重新扫描");
    if (kind === "preserve") entry.preserved = value;
    else {
      if (
        !item.insight?.hash ||
        (await analyzeSkillTree(item.path)).hash !== item.insight.hash
      )
        throw new Error("Skill 内容已变化，请重新扫描后处理风险");
      entry.ignoredHash = value
        ? `${RULE_VERSION}:${item.insight.hash}`
        : undefined;
    }
    await this.save();
  }
}

export function applyUsageAdvice(items: SkillItem[], now = Date.now()) {
  for (const item of items) {
    const usage = item.usage;
    if (!usage) continue;
    const firstSeen = Date.parse(item.insight?.firstSeenAt ?? "");
    const changedAt = Date.parse(item.insight?.changedAt ?? "");
    const recent =
      !Number.isFinite(firstSeen) ||
      now - firstSeen < 30 * DAY ||
      now - changedAt < 14 * DAY;
    const protectedItem =
      item.insight?.preserved ||
      (item.kind && item.kind !== 'skill') ||
      !item.cleanup?.deletable ||
      /[\\/]\.agents[\\/]|[\\/]\.wiscode[\\/]codex-agents[\\/]/.test(
        item.path,
      ) ||
      items.some((other) => skillReferences(other, item));
    usage.recommendation = item.insight?.preserved ? "protected" : "observe";
    usage.reasons = [];
    if (protectedItem) {
      usage.reasons.push(
        item.insight?.preserved
          ? "你已标记保留，不进入批量低频清理"
          : "共享、链接、嵌套或由其他安装源管理的项目不进入批量低频清理",
      );
      continue;
    }
    if (recent) {
      usage.reasons.push(
        "首次发现未满 30 天，或最近 14 天内容发生变化，继续观察",
      );
      continue;
    }
    if (
      usage.coverage !== "recorded" ||
      (usage.observationDays ?? 0) < 30 ||
      (usage.eligibleSessions30 ?? 0) < 20
    ) {
      usage.reasons.push(
        "观察时间、日志覆盖或有效会话不足，不能把没有记录当作低频",
      );
      continue;
    }
    const count = usage.sessions30 ?? 0;
    if (count <= 1) {
      const last = usage.lastObservedAt
        ? Date.parse(usage.lastObservedAt)
        : firstSeen;
      usage.recommendation =
        count === 1
          ? "low"
          : now - last >= 60 * DAY && (usage.observationDays ?? 0) >= 60
            ? "cleanup"
            : "consider";
      usage.reasons.push(
        `近 30 天 ${usage.eligibleSessions30} 个有效日志会话中有 ${count} 个加载会话；观察 ${usage.observationDays} 天`,
      );
      if (
        usage.recommendation === "cleanup" ||
        usage.recommendation === "consider"
      ) {
        item.cleanup = {
          ...item.cleanup!,
          level: usage.recommendation === "cleanup" ? "cleanup" : "consider",
          title:
            usage.recommendation === "cleanup"
              ? "建议清理低频副本"
              : "可考虑清理低频副本",
          reasons: [...usage.reasons],
          impact: [
            ...item.cleanup!.impact,
            "依据本地日志中的加载记录，不能证明业务任务是否执行",
          ],
        };
      }
    } else
      usage.reasons.push(`近 30 天有 ${count} 个加载会话，暂无低频清理建议`);
  }
}

export async function compareSkillItems(
  left: SkillItem,
  right: SkillItem,
): Promise<SkillComparison> {
  const analyses = await Promise.all([
    analyzeSkillTree(left.path),
    analyzeSkillTree(right.path),
  ]);
  if (
    analyses[0].hash !== left.insight?.hash ||
    analyses[1].hash !== right.insight?.hash
  )
    throw new Error("内容已变化，请重新扫描后比较");
  const map = (analysis: SkillTreeAnalysis) =>
    new Map(
      analysis.entries
        .filter((e) => e.kind !== "directory")
        .map((e) => [e.relative, e]),
    );
  const a = map(analyses[0]),
    b = map(analyses[1]);
  const result: SkillComparison = {
    left: left.id,
    right: right.id,
    files: [],
    truncated: false,
  };
  const { clean } = sanitizer();
  const read = async (
    entry: ReturnType<typeof map> extends Map<string, infer E>
      ? E | undefined
      : never,
  ) => {
    if (!entry) return undefined;
    if (entry.kind === "external-link")
      return {
        hash: `link:${entry.target}`,
        text: `外部链接 → ${entry.target}`,
      };
    const h = await fs.open(
      entry.source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await h.stat();
      if (stat.size > 256 * 1024) {
        result.truncated = true;
        const hash = createHash("sha256");
        for await (const chunk of h.createReadStream({ autoClose: false }))
          hash.update(chunk);
        return { hash: hash.digest("hex"), text: "[文件超过 256 KB，未展开]" };
      }
      const buffer = await h.readFile();
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (buffer.includes(0))
        return { hash, text: `[二进制文件 SHA-256 ${hash}]` };
      const text = buffer.toString("utf8");
      if (text.length > 12000) result.truncated = true;
      return { hash, text: clean(text.slice(0, 12000)) };
    } finally {
      await h.close();
    }
  };
  for (const file of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(file),
      y = b.get(file);
    const [before, after] = await Promise.all([read(x), read(y)]);
    if (
      x &&
      y &&
      before?.hash === after?.hash &&
      x.kind === y.kind &&
      x.mode === y.mode
    )
      continue;
    if (result.files.length >= 30) {
      result.truncated = true;
      break;
    }
    result.files.push({
      path: file,
      status: !x ? "added" : !y ? "removed" : "changed",
      left: before?.text,
      right: after?.text,
      note: x?.mode !== y?.mode ? "文件权限存在差异" : undefined,
    });
  }
  // Revalidate after reading: a displayed comparison must describe the scanned versions.
  if (
    (await analyzeSkillTree(left.path)).hash !== analyses[0].hash ||
    (await analyzeSkillTree(right.path)).hash !== analyses[1].hash
  )
    throw new Error("比较期间内容发生变化，请重新扫描");
  return result;
}
