import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Layers3,
  Copy,
  ShieldAlert,
  ShieldCheck,
  Clock3,
  Pin,
  Trash2,
} from "lucide-react";
import Modal from "./Modal";
import SkillRiskText from "./SkillRiskText";
import SkillTidy from "./SkillTidy";
import type { DesktopAPI } from "./shared/types";
import type {
  SkillComparison,
  SkillDeletePreview,
  SkillDeleteResult,
  SkillDuplicateGroup,
  SkillItem,
  SkillScan,
} from "./shared/skills";
import {
  groupSkills,
  skillHasRisk,
  skillRiskLabel,
  skillRiskLevel,
  SKILL_SECURITY_TOOLS,
  USAGE_RECOMMENDATIONS,
} from "./shared/skill-insights";
import {
  INSTALL_LABELS,
  SOURCE_LABELS,
  type SecurityOverview,
  type SecurityEvent,
} from "./shared/security";
import { RISK_RULES } from "./shared/security-scan";

export type SkillView = "all" | "duplicates" | "security" | "usage";
export function SkillViewSwitch({
  view,
  onChange,
  items,
  disabled,
}: {
  view: SkillView;
  onChange: (v: SkillView) => void;
  items: SkillItem[];
  disabled: boolean;
}) {
  const views = [
    ["all", "全部安装", items.length, Layers3],
    ["duplicates", "重复整理", groupSkills(items).length, Copy],
    ["security", "安全风险", items.filter(skillHasRisk).length, ShieldAlert],
    [
      "usage",
      "低频建议",
      items.filter((i) =>
        ["consider", "cleanup"].includes(i.usage?.recommendation ?? ""),
      ).length,
      Clock3,
    ],
  ] as const;
  return (
    <div
      className="skill-view-switch"
      role="tablist"
      aria-label="Skill 管理视图"
    >
      {views.map(([id, label, count, Icon]) => (
        <button
          type="button"
          role="tab"
          aria-selected={view === id}
          className={`skill-view-${id}${view === id ? " active" : ""}`}
          key={id}
          onClick={() => onChange(id)}
          disabled={disabled}
        >
          <Icon size={16} />
          {label}
          <span>{count}</span>
        </button>
      ))}
    </div>
  );
}
function SkillListEvidence({ item }: { item: SkillItem }) {
  const allFindings = [
    ...(item.insight?.risk?.findings ?? []).map(f => ({
      label: f.label, location: `${f.file}:${f.line}`, text: f.text, level: f.level,
    })),
    ...(item.insight?.mcp ?? []).flatMap(({ file, report }) => report.findings.map(f => ({
      label: f.title, location: file, text: f.detail, level: f.level,
    }))),
  ].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.level] - { high: 0, medium: 1, low: 2 }[b.level]));
  const findings = allFindings.some(f => f.level !== "low")
    ? allFindings.filter(f => f.level !== "low")
    : allFindings;
  const renderFinding = (f: typeof findings[number], index: number) => (
    <div className={`skill-list-evidence-item ${f.level}`} key={`${f.location}-${index}`}>
      <div className="skill-list-evidence-label"><strong>{f.label}</strong><small>{f.location}</small></div>
      <code><SkillRiskText text={f.text} /></code>
    </div>
  );
  return <div className="skill-list-evidence" aria-label="风险命中依据">
    {(item.insight?.riskError || item.insight?.risk?.truncated) && <p className="skill-evidence-warning">{item.insight.riskError || "部分文件未检查，请查看完整依据。"}</p>}
    {findings.slice(0, 2).map(renderFinding)}
    {findings.length > 2 && <details><summary>展开其余 {findings.length - 2} 条依据</summary>{findings.slice(2).map(renderFinding)}</details>}
    {!findings.length && <p>{item.insight?.risk ? "当前检查范围内未发现规则命中。" : "尚未取得检查结果。"}</p>}
  </div>;
}

interface Props {
  view: SkillView;
  items: SkillItem[];
  scan: SkillScan;
  api: DesktopAPI;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onScan: (scan: SkillScan) => void;
  onInspect: (item: SkillItem) => void;
  onCopy: (id: string, target?: string) => void;
  onDelete: (ids: string[]) => void;
  onSecurity?: () => void;
}
export function SkillManagement({
  view,
  items,
  scan,
  api,
  busy,
  onBusy,
  onScan,
  onInspect,
  onCopy,
  onDelete,
  onSecurity,
}: Props) {
  const [group, setGroup] = useState<SkillDuplicateGroup>();
  const [usageFilter, setUsageFilter] = useState("suggested");
  const [riskFilter, setRiskFilter] = useState("open");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setGroup(undefined);
  }, [scan]);
  useEffect(() => {
    setGroup(undefined);
    setError("");
    setMessage("");
  }, [view]);
  const groups = groupSkills(items);
  const preference = async (
    item: SkillItem,
    kind: "preserve" | "ignore-risk",
    value: boolean,
  ) => {
    if (!api.skillPreference) {
      setError("当前实例缺少管理能力，请重新启动桌面应用");
      return;
    }
    onBusy(true);
    setError("");
    try {
      onScan(await api.skillPreference(item.id, kind, value));
      setMessage(
        kind === "preserve"
          ? value
            ? "已保留此安装项，低频清理将跳过它"
            : "已取消保留"
          : value
            ? "本版本风险已暂不处理；内容更新后会重新提醒"
            : "已恢复风险提醒",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  const usageItems = items.filter(
    (i) =>
      usageFilter === "all" ||
      (usageFilter === "suggested"
        ? ["consider", "cleanup"].includes(i.usage?.recommendation ?? "")
        : usageFilter === "protected"
          ? i.insight?.preserved
          : !["consider", "cleanup", "protected"].includes(
              i.usage?.recommendation ?? "",
            )),
  );
  const riskItems = items.filter(
    (i) =>
      riskFilter === "all" ||
      (riskFilter === "ignored"
        ? i.insight?.riskIgnored
        : riskFilter === "incomplete"
          ? !i.insight?.risk || i.insight.risk.truncated || i.insight.riskError
          : skillHasRisk(i)),
  );
  return (
    <div className="skill-management">
      {error && (
        <div className="notice amber" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="notice green" role="status">
          {message}
        </div>
      )}
      {view === "duplicates" && (
        <>
          <SkillTidy api={api} scan={scan} busy={busy} onBusy={onBusy} onScan={onScan} onCopy={onCopy} />
          <div className="skill-management-heading">
            <div>
              <h3>按位置、完整内容与同名版本整理</h3>
              <p>
                分组合并展示不移动文件。跨工具安装各自保留；同一工具的相同副本需预检后才能清理。
              </p>
            </div>
          </div>
          {!groups.length ? (
            <div className="skill-insight-empty">
              <Layers3 size={25} />
              <h3>当前范围没有发现重复组</h3>
              <p>
                只有完整目录校验成功的项目才判定为内容一致；未完成项可在详情查看依据。
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <div className="skill-group-card" key={g.id}>
                <div>
                  <span
                    className={`skill-insight-tag ${g.kind === "different" ? "medium" : ""}`}
                  >
                    {g.kind === "same-location"
                      ? "同一实际位置"
                      : g.kind === "identical"
                        ? "完整内容一致"
                        : "同名版本待比较"}
                  </span>
                  <h3>{g.name}</h3>
                  <p>
                    {g.itemIds.length} 个安装入口 ·{" "}
                    {
                      new Set(
                        items
                          .filter((i) => g.itemIds.includes(i.id))
                          .map((i) => i.source),
                      ).size
                    }{" "}
                    个来源
                  </p>
                </div>
                <div className="skill-group-locations">
                  {items
                    .filter((i) => g.itemIds.includes(i.id))
                    .map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => onInspect(i)}
                      >
                        <strong>{i.source}</strong>
                        <span title={i.path}>{i.path}</span>
                      </button>
                    ))}
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setGroup(g)}
                >
                  查看分组与处理
                  <ChevronRight size={14} />
                </button>
              </div>
            ))
          )}
        </>
      )}
      {view === "security" && (
        <>
          <div className="skill-management-heading">
            <div>
              <h3>AI 盒子安全检查</h3>
              <p>
                复用现有内容检查、MCP
                检查和工具防护状态。静态命中与真实拦截分别展示。
              </p>
            </div>
            {onSecurity && (
              <button className="secondary" type="button" onClick={onSecurity}>
                前往安全中心
                <ChevronRight size={14} />
              </button>
            )}
          </div>
          <label className="skill-inline-filter">
            显示
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value)}
            >
              <option value="open">待处理风险</option>
              <option value="incomplete">尚未完整检查</option>
              <option value="ignored">暂不处理</option>
              <option value="all">全部检查结果</option>
            </select>
            <span>当前 {riskItems.length} 项</span>
          </label>
          {!riskItems.length && (
            <div className="skill-insight-empty">
              <ShieldCheck size={25} />
              <h3>
                {riskFilter === "open"
                  ? "当前范围暂无待处理风险"
                  : "当前筛选没有结果"}
              </h3>
              <p>可切换“尚未完整检查”核对覆盖范围，或查看全部检查结果。</p>
            </div>
          )}
          {riskItems.map((item) => (
            <div className={`skill-insight-row skill-security-row ${skillRiskLevel(item)}`} key={item.id}>
              <div>
                <button
                  type="button"
                  className="skill-insight-name"
                  onClick={() => onInspect(item)}
                >
                  {item.name}
                </button>
                <small>
                  {item.source} · {item.insight?.risk?.scannedFiles ?? 0}{" "}
                  个文本文件已检查
                </small>
                <SkillListEvidence item={item} />
                <span className={`skill-insight-tag ${skillRiskLevel(item)}`}>
                  {skillRiskLabel(item)}
                </span>
                {item.insight?.change === "changed" && (
                  <span className="skill-insight-tag medium">内容已变化</span>
                )}
              </div>
              <div className="skill-insight-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => onInspect(item)}
                >
                  查看依据
                </button>
                {skillHasRisk(item) || item.insight?.riskIgnored ? (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy || !item.insight?.hash}
                    onClick={() =>
                      void preference(
                        item,
                        "ignore-risk",
                        !item.insight?.riskIgnored,
                      )
                    }
                  >
                    {item.insight?.riskIgnored ? "恢复提醒" : "暂不处理本版本"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </>
      )}
      {view === "usage" && (
        <>
          <div className="skill-management-heading">
            <div>
              <h3>按安装位置评估低频使用</h3>
              <p>
                观察满 30 天、近 30 天至少 20
                个有效日志会话且覆盖完整，才生成清理建议。读取未知的项目继续观察。
              </p>
            </div>
            <button
              className="secondary"
              type="button"
              disabled={
                busy ||
                !usageItems.some(
                  (i) =>
                    ["consider", "cleanup"].includes(
                      i.usage?.recommendation ?? "",
                    ) && !i.insight?.preserved,
                )
              }
              onClick={() =>
                onDelete(
                  usageItems
                    .filter(
                      (i) =>
                        ["consider", "cleanup"].includes(
                          i.usage?.recommendation ?? "",
                        ) && !i.insight?.preserved,
                    )
                    .map((i) => i.id),
                )
              }
            >
              <Trash2 size={14} />
              预览清理建议项
            </button>
          </div>
          <label className="skill-inline-filter">
            显示
            <select
              value={usageFilter}
              onChange={(e) => setUsageFilter(e.target.value)}
            >
              <option value="suggested">可考虑 / 建议清理</option>
              <option value="observe">继续观察 / 低频</option>
              <option value="protected">已保留</option>
              <option value="all">全部使用情况</option>
            </select>
            <span>当前 {usageItems.length} 项</span>
          </label>
          {!usageItems.length && (
            <div className="skill-insight-empty">
              <Clock3 size={25} />
              <h3>
                {usageFilter === "suggested"
                  ? "暂时没有满足条件的清理建议"
                  : "当前筛选没有结果"}
              </h3>
              <p>
                记录不足不代表没有使用。切换“继续观察 /
                低频”可查看每项缺少的依据。
              </p>
              {usageFilter === "suggested" && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setUsageFilter("observe")}
                >
                  查看观察中的项目
                </button>
              )}
            </div>
          )}
          {usageItems.map((item) => (
            <div className="skill-insight-row" key={item.id}>
              <div>
                <button
                  type="button"
                  className="skill-insight-name"
                  onClick={() => onInspect(item)}
                >
                  {item.name}
                </button>
                <small>
                  {item.source} · {item.path}
                </small>
                <UsageEvidence item={item} />
              </div>
              <div className="skill-insight-actions">
                <span className="skill-insight-tag">
                  {
                    USAGE_RECOMMENDATIONS[
                      item.usage?.recommendation ?? "observe"
                    ]
                  }
                </span>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void preference(item, "preserve", !item.insight?.preserved)
                  }
                >
                  <Pin size={13} />
                  {item.insight?.preserved ? "取消保留" : "保留此项"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => onInspect(item)}
                >
                  查看依据
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {group && (
        <DuplicateDialog
          group={group}
          scan={scan}
          api={api}
          busy={busy}
          onBusy={onBusy}
          onClose={() => setGroup(undefined)}
          onScan={onScan}
          onCopy={onCopy}
        />
      )}
    </div>
  );
}

function DuplicateDialog({
  group,
  scan,
  api,
  busy,
  onBusy,
  onClose,
  onScan,
  onCopy,
}: {
  group: SkillDuplicateGroup;
  scan: SkillScan;
  api: DesktopAPI;
  busy: boolean;
  onBusy: (v: boolean) => void;
  onClose: () => void;
  onScan: (s: SkillScan) => void;
  onCopy: (id: string, target?: string) => void;
}) {
  const members = scan.items.filter((i) => group.itemIds.includes(i.id));
  const [keep, setKeep] = useState(members[0]?.id ?? "");
  const [other, setOther] = useState(members[1]?.id ?? "");
  const [comparison, setComparison] = useState<SkillComparison>();
  const [preview, setPreview] = useState<SkillDeletePreview>();
  const [results, setResults] = useState<SkillDeleteResult[]>();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  const selected = members.find((i) => i.id === keep);
  const removable = members.filter(
    (i) =>
      i.id !== keep &&
      i.source === selected?.source &&
      i.insight?.hash &&
      i.insight.hash === selected?.insight?.hash &&
      !i.insight.checkError &&
      (!i.kind || i.kind === 'skill') &&
      !i.insight.preserved &&
      i.cleanup?.deletable,
  );
  const reset = () => {
    seq.current++;
    setComparison(undefined);
    setPreview(undefined);
    setAck(false);
    setError("");
  };
  const run = async (fn: () => Promise<void>) => {
    onBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (results)
      void run(async () => {
        onScan(await api.skills());
        onClose();
      });
    else onClose();
  };
  return (
    <Modal
      title={`整理 ${group.name}`}
      subtitle={`${members.length} 个安装入口 · 先查看依据，再选择操作`}
      onClose={close}
    >
      <div className="modal-body skill-duplicate-dialog">
        <p>
          选择保留或作为复制来源的版本。跨工具的副本保留各自入口；整理只移动同一工具内完整内容一致的副本。
        </p>
        <label>
          保留 / 来源版本
          <select
            value={keep}
            disabled={busy || !!results}
            onChange={(e) => {
              reset();
              setKeep(e.target.value);
              if (e.target.value === other)
                setOther(
                  members.find((i) => i.id !== e.target.value)?.id ?? "",
                );
            }}
          >
            {members.map((i) => (
              <option key={i.id} value={i.id}>
                {i.source} · {i.path}
              </option>
            ))}
          </select>
        </label>
        {selected && <p className="skill-path">{selected.path}</p>}
        <label>
          比较另一份
          <select
            value={other}
            disabled={busy || !!results}
            onChange={(e) => {
              reset();
              setOther(e.target.value);
            }}
          >
            {members
              .filter((i) => i.id !== keep)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.source} · {i.path}
                </option>
              ))}
          </select>
        </label>
        <div className="skill-insight-actions horizontal">
          <button
            className="secondary"
            disabled={busy || !other || !api.compareSkills || !!results}
            type="button"
            onClick={() =>
              void run(async () => {
                const ticket = ++seq.current;
                const value = await api.compareSkills!(keep, other);
                if (ticket === seq.current) setComparison(value);
              })
            }
          >
            比较文件差异
          </button>
          <button
            className="secondary"
            disabled={busy || !selected || (!!selected.kind && selected.kind !== 'skill') || !!results}
            type="button"
            onClick={() => {
              const target = scan.targets.find(
                (t) =>
                  t.label === members.find((i) => i.id === other)?.source &&
                  t.copySupported !== false,
              )?.id;
              onClose();
              onCopy(keep, target);
            }}
          >
            用此版本复制 / 更新其他工具
          </button>
        </div>
        {comparison && (
          <div className="skill-compare" aria-label="文件差异">
            <p>
              {comparison.files.length
                ? `${comparison.files.length} 个文件存在差异`
                : "完整目录内容、权限与链接一致"}
              {comparison.truncated
                ? " · 部分内容未展开，不能据此判断完整一致"
                : ""}
            </p>
            {comparison.files.map((f) => (
              <details key={f.path}>
                <summary>
                  {f.path} ·{" "}
                  {
                    {
                      added: "另一份新增",
                      removed: "另一份缺少",
                      changed: "内容或权限变化",
                    }[f.status]
                  }
                </summary>
                {f.note && <p>{f.note}</p>}
                <div className="skill-compare-columns">
                  <div>
                    <strong>保留 / 来源版本</strong>
                    <pre>{f.left ?? "此版本无此文件"}</pre>
                  </div>
                  <div>
                    <strong>另一版本</strong>
                    <pre>{f.right ?? "此版本无此文件"}</pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
        <div className="skill-merge-section">
          <h3>清理同一工具内的相同副本</h3>
          <p>
            {group.kind === "same-location"
              ? "这些入口指向同一实际位置。合并展示即可，无需删除文件。"
              : removable.length
                ? `可预检 ${removable.length} 个同工具副本。需自行确认工具加载配置仍会读取保留位置。`
                : "当前保留版本没有可清理的同工具副本。跨工具、版本不同、共享或已保留项目不进入合并清理。"}
          </p>
          {!results && (
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                group.kind === "same-location" ||
                !removable.length ||
                !api.previewMergeSkills
              }
              onClick={() =>
                void run(async () => {
                  setAck(false);
                  setPreview(
                    await api.previewMergeSkills!(
                      keep,
                      removable.map((i) => i.id),
                    ),
                  );
                })
              }
            >
              预检重复副本
            </button>
          )}
          {preview && !results && (
            <div className="skill-merge-preview">
              <strong>保留原位</strong>
              <p className="skill-path">{preview.retained?.path}</p>
              <strong>移入回收区</strong>
              {preview.items.map((row) => (
                <p className="skill-path" key={row.id}>
                  {row.path}
                </p>
              ))}
              <label className="skill-confirm-check">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(e) => setAck(e.target.checked)}
                />
                我已核对加载配置，保留位置可供该工具继续读取
              </label>
              <button
                className="primary"
                type="button"
                disabled={busy || !ack || !api.mergeSkills}
                onClick={() =>
                  void run(async () => {
                    const value = await api.mergeSkills!(
                      keep,
                      preview.items.map((i) => i.id),
                      preview.token,
                    );
                    setResults(value);
                  })
                }
              >
                确认整理 {preview.items.length} 个副本
              </button>
            </div>
          )}
          {results && (
            <div role="status">
              {results.map((row) => (
                <p key={row.id}>
                  {row.name}：{row.message}
                </p>
              ))}
              <p>成功移动的项目可在 Skill 中心回收区恢复。</p>
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    onScan(await api.skills());
                    onClose();
                  })
                }
              >
                完成并刷新列表
              </button>
            </div>
          )}
        </div>
        {error && (
          <div className="notice amber" role="alert">
            {error}
            <p>内容变化或预检过期时，请关闭此窗口并重新扫描。</p>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={close}
        >
          {busy ? "正在处理…" : results ? "刷新并关闭" : "关闭"}
        </button>
      </div>
    </Modal>
  );
}

export function UsageEvidence({ item }: { item: SkillItem }) {
  const u = item.usage;
  const complete = u?.coverage === "recorded";
  const rate =
    complete && (u.eligibleSessions30 ?? 0) > 0
      ? `${Math.round(((u.sessions30 ?? 0) / u.eligibleSessions30!) * 1000) / 10}%`
      : "—";
  return (
    <div className="skill-usage-evidence">
      <p>
        近 30 天确认加载：{u?.sessions30 ?? "—"} 个会话 · 会话加载占比：{rate}
      </p>
      <p>
        日志跨度：{u?.observationDays ?? "—"} 天 · 有效会话：
        {u?.eligibleSessions30 ?? "—"} ·{" "}
        {complete
          ? "已读取可用日志"
          : u?.coverage === "unsupported"
            ? "此工具暂不支持"
            : "日志覆盖不完整"}
      </p>
      {u?.lastObservedAt && (
        <p>
          {u.confirmed ? "最近确认加载" : "最近读取请求（未确认成功）"}：
          {new Date(u.lastObservedAt).toLocaleString()}
        </p>
      )}
      {u?.reasons?.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      <small>
        {u?.evidence ?? "当前没有可确认的使用记录，不生成低频清理建议。"}
      </small>
    </div>
  );
}
export function SkillEvidence({
  item,
  api,
  onScan,
  onBusy,
  busy,
  onSecurity,
}: {
  item: SkillItem;
  api: DesktopAPI;
  onScan: (s: SkillScan) => void;
  onBusy: (b: boolean) => void;
  busy: boolean;
  onSecurity?: () => void;
}) {
  const [overview, setOverview] = useState<SecurityOverview>();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [error, setError] = useState("");
  const tool = SKILL_SECURITY_TOOLS[item.source];
  useEffect(() => {
    let live = true;
    setOverview(undefined);
    setEvents([]);
    setError("");
    if (api.security)
      void Promise.all([
        api.security.securityOverview(),
        tool
          ? api.security.securityTimeline({
              tool,
              limit: 5,
              sources: ["real_block", "real_allow"],
            })
          : Promise.resolve(undefined),
      ])
        .then(([o, e]) => {
          if (live) {
            setOverview(o);
            setEvents(e?.events ?? []);
          }
        })
        .catch((e) => {
          if (live) setError(`安全状态读取失败：${String(e)}`);
        });
    return () => {
      live = false;
    };
  }, [api, item.id, item.insight?.checkedAt, tool]);
  const state = overview?.tools.find((t) => t.tool === tool);
  const change = async (kind: "preserve" | "ignore-risk", value: boolean) => {
    if (!api.skillPreference) {
      setError("当前实例缺少此能力，请重新启动应用");
      return;
    }
    onBusy(true);
    setError("");
    try {
      onScan(await api.skillPreference(item.id, kind, value));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="skill-evidence">
      <h3>AI 盒子安全检查</h3>
      <p>
        <span className={`skill-insight-tag ${skillRiskLevel(item)}`}>
          {skillRiskLabel(item)}
        </span>
        {item.insight?.riskIgnored && " · 本版本已暂不处理"}
      </p>
      <p>
        {item.insight?.risk?.scannedFiles ?? 0} 个文本文件已检查
        {item.insight?.checkedAt
          ? ` · ${new Date(item.insight.checkedAt).toLocaleString()}`
          : ""}
      </p>
      {(item.insight?.riskError || item.insight?.checkError) && (
        <p className="skill-evidence-warning">
          {item.insight.riskError} {item.insight.checkError}
        </p>
      )}
      {item.insight?.risk?.truncated && (
        <p className="skill-evidence-warning">
          部分文件因大小、类型、链接或数量限制未检查，不能视为完整通过。
        </p>
      )}
      <p>
        以下是文件内容中的规则命中，不代表指令已执行。外部地址仅表示文本中出现该地址。
      </p>
      {item.insight?.risk?.findings.map((f, i) => (
        <div
          className={`skill-risk-finding ${f.level}`}
          key={`${f.file}-${f.line}-${i}`}
        >
          <strong>{f.label}</strong>
          <small>
            {f.file}:{f.line}
          </small>
          <code><SkillRiskText text={f.text} /></code>
          <p>{RISK_RULES[f.rule]?.advice}</p>
        </div>
      ))}
      {item.insight?.mcp.map(({ file, report }) => (
        <details key={file}>
          <summary>
            MCP 配置检查 · {file} · {report.findings.length} 项提醒
          </summary>
          {report.findings.map((f, i) => (
            <p key={i}>
              {f.title}：<SkillRiskText text={f.detail} />
            </p>
          ))}
          <pre><SkillRiskText text={report.redactedConfig} /></pre>
        </details>
      ))}
      {item.insight?.hash && (
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => void change("ignore-risk", !item.insight?.riskIgnored)}
        >
          {item.insight.riskIgnored
            ? "恢复此版本风险提醒"
            : "暂不处理此版本风险"}
        </button>
      )}
      <h3>所属工具防护</h3>
      <p>
        {!tool
          ? "此来源暂未接入工具防护；内容扫描结果仍可查看。"
          : state
            ? INSTALL_LABELS[state.state]
            : "尚未取得防护状态"}
      </p>
      {state && <p>{state.note}</p>}
      {onSecurity && (
        <button type="button" className="secondary" onClick={onSecurity}>
          前往安全中心管理防护
          <ChevronRight size={14} />
        </button>
      )}
      <details>
        <summary>所属工具最近的真实防护记录（{events.length}）</summary>
        <p>这些是工具级记录，尚未建立与此 Skill 的直接因果关联。</p>
        {events.map((e) => (
          <p key={e.id}>
            {new Date(e.at).toLocaleString()} · {SOURCE_LABELS[e.source]} ·{" "}
            {e.operation} · {e.reason}
          </p>
        ))}
        {!events.length && <p>暂无可展示的真实防护记录。</p>}
      </details>
      <h3>使用与清理依据</h3>
      <UsageEvidence item={item} />
      <button
        className="secondary"
        type="button"
        disabled={busy}
        onClick={() => void change("preserve", !item.insight?.preserved)}
      >
        <Pin size={14} />
        {item.insight?.preserved
          ? "取消保留此安装项"
          : "保留此安装项，跳过低频清理"}
      </button>
      {error && (
        <p role="alert" className="skill-evidence-warning">
          {error}
        </p>
      )}
    </div>
  );
}
