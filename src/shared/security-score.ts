import {
  CATEGORY_LABELS,
  SCORE_BASE,
  SCORE_MIN,
  SCORE_WEIGHTS,
  type DoctorReport,
  type Finding,
  type ScoreItem,
  type TimelinePage,
  type ToolStatus,
} from "./security";

/** Current configuration only. Repeated findings share a single category budget. */
export function securityScore(
  findings: Finding[],
  tools: ToolStatus[],
  doctor: DoctorReport | undefined,
  chain: TimelinePage["chain"],
) {
  const items: ScoreItem[] = [];
  for (const [category, title] of Object.entries(CATEGORY_LABELS)) {
    const group = findings.filter((f) => f.category === category);
    const brokenChain = category === "integrity" && chain.status === "broken";
    if (!group.length && !brokenChain) continue;
    const highest = group.reduce<Finding | undefined>(
      (a, f) => (!a || SCORE_WEIGHTS[f.level] > SCORE_WEIGHTS[a.level] ? f : a),
      undefined,
    );
    const level = brokenChain ? "high" : highest!.level;
    items.push({
      id: `category:${category}`,
      title,
      level,
      deduction: SCORE_WEIGHTS[level],
      findingId: highest?.id,
      reason: `${group.length} 个当前问题${brokenChain ? "；安全记录校验异常" : ""}，按本类最高风险合并扣分，不按条数累加`,
    });
  }
  const bonus = (id: string, title: string, points: number, reason: string) =>
    items.push({ id, title, deduction: 0, bonus: points, reason });
  const files = doctor?.scanned.reduce((n, s) => n + s.files, 0) ?? 0;
  const incomplete = doctor?.findings.some((f) => /:unreadable:/.test(f.id));
  bonus(
    "doctor",
    "完成配置体检",
    files > 0 && !incomplete ? 5 : 0,
    !doctor
      ? "尚未体检，未检查项目不视为通过"
      : incomplete
        ? "有配置未能读取，完成检查后可加 5 分"
        : files
          ? `已读取 ${files} 个配置文件，加 5 分；发现的问题另按类别扣分`
          : "未读取到配置文件，暂不加分",
  );
  bonus(
    "chain",
    "安全记录校验",
    chain.status === "ok" ? 5 : 0,
    chain.status === "ok"
      ? `已校验 ${chain.checked} 条记录，加 5 分`
      : chain.status === "empty"
        ? "暂无记录，暂不加分"
        : "记录校验异常，已并入完整性类扣分",
  );
  const supported = tools.filter((t) => t.installed && t.canToggle);
  const connected = supported.filter((t) =>
    ["enabled", "verified", "needs_restart"].includes(t.state),
  );
  bonus(
    "protection",
    "执行前防护接入",
    supported.length
      ? Math.floor((10 * connected.length) / supported.length)
      : 0,
    supported.length
      ? `${connected.length}/${supported.length} 个支持的工具已接入，按比例加分（向下取整）；接入不代表当前会话已加载，请通过真实事件核验`
      : "未发现支持的工具，暂不加分",
  );
  const raw =
    SCORE_BASE + items.reduce((n, i) => n + (i.bonus ?? 0) - i.deduction, 0);
  if (raw < SCORE_MIN)
    bonus(
      "floor",
      "评分下限调整",
      SCORE_MIN - raw,
      "最低展示 30 分，当前风险仍需处理",
    );
  return { score: Math.max(SCORE_MIN, Math.min(100, raw)), scoreItems: items };
}
