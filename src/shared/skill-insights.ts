import type { SkillDuplicateGroup, SkillItem } from "./skills";
import type { SecurityTool } from "./security";

export const SKILL_SECURITY_TOOLS: Record<string, SecurityTool> = {
  "Codex / OpenAI Skills": "codex",
  "Claude Code": "claude",
  OpenCode: "opencode",
  WisCode: "wiscode",
};
export function skillReferences(other: SkillItem, item: SkillItem) {
  if (other.id === item.id) return false;
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/$/, "");
  const roots = [item.path, item.insight?.realPath]
    .filter((p): p is string => !!p)
    .map(normalize);
  const paths = [
    other.path,
    other.linkTarget,
    ...(other.insight?.dependencies ?? []),
  ]
    .filter((p): p is string => !!p)
    .map(normalize);
  return paths.some((p) =>
    roots.some((root) => p === root || p.startsWith(root + "/")),
  );
}
export function skillRiskLabel(item: SkillItem): string {
  const insight = item.insight;
  if (!insight?.risk) return insight?.riskError ? "检查未完成" : "尚未检查";
  const level = skillRiskLevel(item);
  const label =
    level === "high"
      ? "高风险"
      : level === "medium"
        ? "需注意"
        : level === "low"
          ? "发现外部地址"
          : "未发现规则命中";
  return `${label}${insight.risk.truncated || insight.riskError ? " · 部分检查" : ""}`;
}
export function skillRiskLevel(item: SkillItem) {
  const levels = [
    item.insight?.risk?.level ?? "none",
    ...(item.insight?.mcp.map((m) => m.report.level) ?? []),
  ];
  return levels.includes("high")
    ? "high"
    : levels.includes("medium")
      ? "medium"
      : levels.includes("low")
        ? "low"
        : "none";
}
export function skillHasRisk(item: SkillItem) {
  return (
    !item.insight?.riskIgnored &&
    ["high", "medium"].includes(skillRiskLevel(item))
  );
}
export function groupSkills(items: SkillItem[]): SkillDuplicateGroup[] {
  const identities = new Map<string, SkillItem[]>();
  const hashes = new Map<string, SkillItem[]>();
  const names = new Map<string, SkillItem[]>();
  const add = (
    map: Map<string, SkillItem[]>,
    key: string | undefined,
    item: SkillItem,
  ) => {
    if (key) map.set(key, [...(map.get(key) ?? []), item]);
  };
  for (const item of items) {
    add(identities, item.insight?.identity, item);
    if (!item.insight?.checkError) add(hashes, item.insight?.hash, item);
    if (!item.kind || item.kind === "skill" || item.kind === "linked-skill")
      add(names, item.name.trim().toLowerCase(), item);
  }
  // A family appears once even when it contains both identical copies and divergent versions.
  const parent = new Map(items.map((item) => [item.id, item.id]));
  const root = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const r = root(p);
    parent.set(id, r);
    return r;
  };
  for (const map of [identities, hashes, names])
    for (const members of map.values()) {
      for (const item of members.slice(1))
        parent.set(root(item.id), root(members[0].id));
    }
  const families = new Map<string, SkillItem[]>();
  for (const item of items) add(families, root(item.id), item);
  return [...families.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      const sameLocation =
        !!members[0].insight?.identity &&
        members.every(
          (item) => item.insight?.identity === members[0].insight?.identity,
        );
      const identical =
        !!members[0].insight?.hash &&
        members.every(
          (item) =>
            !item.insight?.checkError &&
            item.insight?.hash === members[0].insight?.hash,
        );
      return {
        id: `family:${members
          .map((item) => item.id)
          .sort()
          .join(":")}`,
        name: members[0].name,
        kind: sameLocation
          ? "same-location"
          : identical
            ? "identical"
            : "different",
        itemIds: members.map((item) => item.id),
      };
    });
}
export const USAGE_RECOMMENDATIONS = {
  observe: "继续观察",
  low: "低频使用",
  consider: "可考虑清理",
  cleanup: "建议清理",
  protected: "已保留",
};
