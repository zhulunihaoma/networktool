import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  FolderSearch,
  FolderX,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import Modal from "./Modal";
import type { DesktopAPI } from "./shared/types";
import type {
  SkillCopyPreview,
  SkillCopyResult,
  SkillDeletePreview,
  SkillDeleteResult,
  SkillItem,
  SkillScan,
  SkillVerification,
} from "./shared/skills";
import {
  ALL_SOURCE,
  loadSourceState,
  moveSource,
  orderSources,
  saveSourceState,
  sourceProductId,
  type SourceState,
  type StorageLike,
} from "./shared/source-order";
import type { ToolUsage } from "./shared/tool-usage";

function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function VerificationDetails({ value }: { value?: SkillVerification }) {
  if (!value) return null;
  const labels = { passed: "通过", warning: "有差异", failed: "未通过", unverified: "未验证" };
  return <details className="skill-verification">
    <summary>自动检查结果</summary>
    {value.ruleSource && <p>{value.ruleSource.label} · 规则更新 {value.rulesDate}</p>}
    <ul>{value.checks.map((check, index) => <li key={index}>
      <strong>{check.label}：{labels[check.state]}</strong> — {check.detail}
    </li>)}</ul>
    <details><summary>校验依据</summary>
      <p>检查时间：{new Date(value.checkedAt).toLocaleString()}</p>
      {value.ruleSource && <p>规则来源：{value.ruleSource.url}</p>}
      {value.sourceHash && <p>源目录 SHA-256：<code style={{ overflowWrap: "anywhere" }}>{value.sourceHash}</code></p>}
      {value.expectedHash && value.expectedHash !== value.sourceHash && <p>自动修复后预期 SHA-256：<code style={{ overflowWrap: "anywhere" }}>{value.expectedHash}</code></p>}
      {value.destinationHash && <p>目标目录 SHA-256：<code style={{ overflowWrap: "anywhere" }}>{value.destinationHash}</code></p>}
    </details>
  </details>;
}

const STEPS = ["扫描本机", "选择 Skill", "确认操作", "查看结果"];

function usageLabel(item: SkillItem) {
  if (item.usage?.status !== "observed-read" || !item.usage.lastObservedAt) return "使用情况未知";
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(item.usage.lastObservedAt)) / 86_400_000));
  return days === 0 ? "今天有读取记录" : `最近确认读取：${days} 天前`;
}

export default function SkillCenter({
  api,
  onError,
}: {
  api: DesktopAPI;
  onError: (message: string) => void;
}) {
  const [scan, setScan] = useState<SkillScan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(ALL_SOURCE);
  const storage = browserStorage();
  const [sourceState, setSourceState] = useState<SourceState>(() => loadSourceState(browserStorage()));
  const [toolUsage, setToolUsage] = useState<ToolUsage>();
  const [draggingSource, setDraggingSource] = useState<string>();
  const [dragOverSource, setDragOverSource] = useState<string>();
  const draggingRef = useRef<string | undefined>(undefined);
  const [cleanupOnly, setCleanupOnly] = useState(false);
  const [detail, setDetail] = useState<SkillItem>();
  const [copyOpen, setCopyOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(true);
  const [scanning, setScanning] = useState(true);
  const [result, setResult] = useState<string>();
  const [resultRows, setResultRows] = useState<SkillCopyResult[]>([]);
  const [copyTarget, setCopyTarget] = useState("");
  const [copyToastVisible, setCopyToastVisible] = useState(false);
  const [copyDetailsOpen, setCopyDetailsOpen] = useState(false);
  const [preview, setPreview] = useState<SkillCopyPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deletePreview, setDeletePreview] = useState<SkillDeletePreview>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteResults, setDeleteResults] = useState<SkillDeleteResult[]>([]);
  const [restoreMessage, setRestoreMessage] = useState<string>();
  const revision = useRef(0);
  const operation = useRef(false);
  const [failure, setFailure] = useState<string>();

  // 旧运行实例可能没有注入 skills 能力，这里先行判断，避免把 TypeError 抛给用户。
  const canScan = typeof api.skills === "function";
  const items = scan?.items ?? [];
  const discoveredSources = useMemo(
    () => Array.from(new Set(items.map((item) => item.source))),
    [items],
  );
  const sources = useMemo(
    () => orderSources(discoveredSources, sourceState, toolUsage),
    [discoveredSources, sourceState, toolUsage],
  );
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        const text =
          `${item.name} ${item.description} ${item.features.join(" ")}`.toLowerCase();
        return (
          (!query || text.includes(query.toLowerCase())) &&
          (source === "全部" || item.source === source) &&
          (!cleanupOnly || item.cleanup?.level === "cleanup")
        );
      }),
    [items, query, source, cleanupOnly],
  );
  const cleanupCount = items.filter((item) => item.cleanup?.level === "cleanup").length;
  const selectedDeletableCount = items.filter((item) => selected.includes(item.id) && item.cleanup?.deletable).length;
  const copyStatusCounts = resultRows.reduce(
    (counts, row) => ({ ...counts, [row.status]: counts[row.status] + 1 }),
    { copied: 0, skipped: 0, failed: 0 },
  );
  const copyCheckCounts = resultRows.reduce((counts, row) => {
    for (const check of row.verification?.checks ?? []) counts[check.state] += 1;
    return counts;
  }, { passed: 0, warning: 0, failed: 0, unverified: 0 });
  const blocked = scan
    ? scan.roots.filter((root) => root.status !== "scanned")
    : [];
  const detected = scan
    ? scan.targets.filter((tool) => tool.installed).length
    : 0;
  const currentStep = copyOpen || deleteOpen ? 2 : result || deleteResults.length || restoreMessage ? 3 : scan ? 1 : 0;
  const selectedTarget = scan?.targets.find(option => option.id === target);
  const targetBlocked = selectedTarget?.copySupported === false;
  const copyableCount = preview?.target === target
    ? preview.items.filter((item) => item.status === "ready" || item.status === "update" || item.status === "convert").length
    : 0;
  const targetPreviewItems = preview?.target === target ? preview.items : undefined;
  const sameExistingCount = targetPreviewItems?.filter((item) =>
    item.status === "skipped" && item.verification?.checks.some((check) => check.label === "已有文件完整性"),
  ).length ?? 0;
  const updateExistingCount = targetPreviewItems?.filter((item) => item.status === "update").length ?? 0;
  const unsafeExistingCount = targetPreviewItems?.filter((item) =>
    item.status === "blocked" && item.reason?.startsWith("目标同名路径"),
  ).length ?? 0;
  const batchDuplicateCount = targetPreviewItems?.filter((item) =>
    item.status === "skipped" && item.verification?.checks.some((check) => check.label === "批次同名检查"),
  ).length ?? 0;
  const unknownExistingCount = targetPreviewItems?.filter((item) =>
    item.status === "blocked" && !item.reason?.startsWith("目标同名路径"),
  ).length ?? 0;
  const absentExistingCount = targetPreviewItems?.filter((item) => item.status === "ready").length ?? 0;
  const targetPresenceNeedsAttention = updateExistingCount + unsafeExistingCount + unknownExistingCount > 0;
  const targetPresenceMessage = targetBlocked
    ? selectedTarget?.blockedReason ?? "当前目标不支持直接复制，无法检查同名 Skill。"
    : previewError
      ? "检查未完成，暂时无法确认目标目录是否已有同名 Skill。请查看下方错误。"
      : !targetPreviewItems
        ? "正在检查当前目标目录是否已有所选 Skill…"
        : [
            sameExistingCount ? `已有 ${sameExistingCount} 项同名 Skill，内容一致，复制时会跳过` : "",
            updateExistingCount ? `已有 ${updateExistingCount} 项同名 Skill，内容不同，确认后先备份再更新` : "",
            unsafeExistingCount ? `${unsafeExistingCount} 项存在不安全的同名路径，无法自动替换` : "",
            absentExistingCount ? `${absentExistingCount} 项未发现同名 Skill，可以复制` : "",
            batchDuplicateCount ? `${batchDuplicateCount} 项与本次选择中的同名 Skill 合并，不会重复写入` : "",
            unknownExistingCount ? `${unknownExistingCount} 项暂时无法确认目标是否有同名项，请查看下方原因` : "",
          ].filter(Boolean).join("；") || "没有可安全写入的项目，请查看下方检查原因。";
  const invalidatePreview = useCallback(() => {
    revision.current += 1;
    setPreview(undefined);
    setPreviewError(undefined);
  }, []);
  const closeCopy = () => {
    if (operation.current) return;
    invalidatePreview();
    setCopyOpen(false);
  };
  const openDelete = (ids: string[]) => {
    if (operation.current || !ids.length) return;
    setDeleteIds(ids);
    setDeletePreview(undefined);
    setDeleteError(undefined);
    setDeleteOpen(true);
    setDetail(undefined);
  };
  const closeDelete = () => {
    if (operation.current) return;
    setDeleteOpen(false);
    setDeletePreview(undefined);
    setDeleteError(undefined);
  };
  const openSingleCopy = (id: string) => {
    if (operation.current) return;
    invalidatePreview();
    setSelected([id]);
    setDetail(undefined);
    setCopyOpen(true);
  };

  const runScan = useCallback(async () => {
    if (operation.current) return;
    operation.current = true;
    invalidatePreview();
    setBusy(true);
    setScanning(true);
    setFailure(undefined);
    try {
      if (!canScan) {
        setFailure(
          "当前应用实例未提供 Skill 扫描能力，请退出并重新启动 360AI盒子 后重试。",
        );
        return;
      }
      const next = await api.skills();
      setScan(next);
      setFailure(undefined);
      setResult(undefined);
      setResultRows([]);
      setCopyTarget("");
      setCopyToastVisible(false);
      setCopyDetailsOpen(false);
      setDeleteResults([]);
      setRestoreMessage(undefined);
      setTarget((old) => next.targets.some(item => item.id === old && item.copySupported !== false)
        ? old : next.targets.find(item => item.copySupported !== false)?.id || "");
      setSelected((old) =>
        old.filter((id) => next.items.some((item) => item.id === id)),
      );
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
      setScanning(false);
    }
  }, [api, canScan, invalidatePreview]);
  useEffect(() => {
    void runScan();
  }, [runScan]);
  useEffect(() => {
    if (typeof api.toolUsage !== "function") return;
    let active = true;
    api.toolUsage()
      .then((value) => {
        if (active) setToolUsage(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, scan]);
  const didPersist = useRef(false);
  useEffect(() => {
    if (!didPersist.current) {
      didPersist.current = true;
      return;
    }
    saveSourceState(storage, sourceState);
  }, [sourceState, storage]);
  const selectSource = (value: string) => {
    setSource(value);
  };
  const reorderSource = (from: string | undefined, to: string | undefined) => {
    if (!from || !to || from === ALL_SOURCE || to === ALL_SOURCE || from === to) return;
    const current = sources.filter((value) => value !== ALL_SOURCE);
    setSourceState((old) => ({ ...old, order: moveSource(current, from, to) }));
  };
  const usageHint = (value: string) => {
    const id = sourceProductId(value);
    const entry = id ? toolUsage?.tools[id] : undefined;
    if (!entry?.opens) return "拖动可调整顺序，顺序会记住";
    const when = entry.lastOpenedAt
      ? ` · 最近 ${new Date(entry.lastOpenedAt).toLocaleString()}`
      : "";
    return `本机已记录打开 ${entry.opens} 次${when}；拖动可调整顺序，顺序会记住`;
  };
  const toggle = (id: string) => {
    if (operation.current) return;
    invalidatePreview();
    setSelected((old) =>
      old.includes(id) ? old.filter((value) => value !== id) : [...old, id],
    );
  };
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((item) => selected.includes(item.id));
  const selectAll = () => {
    if (operation.current) return;
    invalidatePreview();
    setSelected((old) =>
      allVisibleSelected
        ? old.filter((id) => !filtered.some((item) => item.id === id))
        : [...new Set([...old, ...filtered.map((item) => item.id)])],
    );
  };
  const checkCopy = useCallback(async () => {
    if (operation.current || !target || !selected.length || targetBlocked) return;
    operation.current = true;
    invalidatePreview();
    const version = revision.current;
    setBusy(true);
    try {
      if (typeof api.previewSkills !== "function")
        throw new Error("当前实例缺少兼容检查能力，请重启应用后重试。");
      const next = await api.previewSkills(selected, target);
      if (next.items.some((item) => item.status === "convert"))
        throw new Error("当前主进程仍使用旧转换规则，请完全退出并启动新版应用后重试，以确保原文完整保留。");
      if (version === revision.current) setPreview(next);
    } catch (error) {
      if (version === revision.current)
        setPreviewError((error as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }, [api, target, selected, targetBlocked, invalidatePreview]);
  useEffect(() => {
    if (copyOpen) void checkCopy();
  }, [copyOpen, checkCopy]);
  const checkDelete = useCallback(async () => {
    if (operation.current || !deleteIds.length) return;
    operation.current = true;
    setBusy(true);
    setDeletePreview(undefined);
    setDeleteError(undefined);
    try {
      if (typeof api.previewDeleteSkills !== "function") throw new Error("当前实例缺少 Skill 回收区能力，请完全退出并启动新版应用。");
      setDeletePreview(await api.previewDeleteSkills(deleteIds));
    } catch (error) { setDeleteError((error as Error).message); }
    finally { operation.current = false; setBusy(false); }
  }, [api, deleteIds]);
  useEffect(() => { if (deleteOpen) void checkDelete(); }, [deleteOpen, checkDelete]);
  const doDelete = async () => {
    if (operation.current || !deletePreview || !deletePreview.items.some((row) => row.status === "ready")) return;
    operation.current = true;
    setBusy(true);
    try {
      const rows = await api.deleteSkills(deleteIds, deletePreview.token);
      setDeleteResults(rows);
      setRestoreMessage(undefined);
      setResult(undefined);
      setResultRows([]);
      setCopyTarget("");
      setCopyToastVisible(false);
      setCopyDetailsOpen(false);
      setDeleteOpen(false);
      setDeletePreview(undefined);
      setSelected([]);
      setScan(await api.skills());
    } catch (error) { setDeleteError((error as Error).message); onError((error as Error).message); }
    finally { operation.current = false; setBusy(false); }
  };
  const restoreOne = async (id: string) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      const row = await api.restoreSkill(id);
      setScan(await api.skills());
      setDeleteResults([]);
      setRestoreMessage(`已恢复 ${row.name} 到 ${row.originalPath}`);
    } catch (error) { onError((error as Error).message); }
    finally { operation.current = false; setBusy(false); }
  };
  const doCopy = async () => {
    if (
      operation.current ||
      !preview ||
      targetBlocked ||
      preview.target !== target ||
      !preview.items.some(
        (item) => item.status === "ready" || item.status === "update" || item.status === "convert",
      )
    )
      return;
    operation.current = true;
    setBusy(true);
    try {
      const rows = await api.copySkills(
        selected,
        target,
        preview.token,
        false, // Legacy hosts must never perform the former lossy conversion.
      );
      const copied = rows.filter((row) => row.status === "copied").length;
      const skipped = rows.filter((row) => row.status === "skipped").length;
      const failed = rows.filter((row) => row.status === "failed").length;
      setResult(
        `已复制 ${copied}/${rows.length} 项${skipped ? `，${skipped} 项跳过` : ""}${failed ? `，${failed} 项失败` : ""}`,
      );
      setResultRows(rows);
      setCopyTarget(target);
      setCopyToastVisible(true);
      setCopyDetailsOpen(false);
      invalidatePreview();
      setCopyOpen(false);
      setSelected([]);
    } catch (error) {
      invalidatePreview();
      setPreviewError((error as Error).message);
      onError((error as Error).message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!copyToastVisible) return;
    const timer = window.setTimeout(() => setCopyToastVisible(false), 8000);
    return () => window.clearTimeout(timer);
  }, [copyToastVisible, resultRows]);

  return (
    <div className="skill-center">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL SKILLS · INVENTORY</div>
          <h1>Skill 中心</h1>
          <p>
            扫描本机 Skill，查看用途、复制到其他工具，或按依据清理本地副本。
          </p>
        </div>
        <span className="badge green">
          <ShieldCheck size={14} />
          扫描不执行脚本 · 清理可恢复
        </span>
      </div>

      <div className="skill-steps" aria-label="Skill 操作步骤">
        {STEPS.map((label, index) => (
          <div
            key={label}
            className={`skill-step ${index === currentStep ? "active" : index < currentStep ? "done" : ""}`}
          >
            <span>{index < currentStep ? <Check size={11} /> : index + 1}</span>
            {label}
            {index < STEPS.length - 1 && <ChevronRight size={13} />}
          </div>
        ))}
      </div>

      <section className="panel skill-list">
        <div className="section-heading">
          <div>
            <h2>管理本机 Skill</h2>
            <p>
              {scanning
                ? "正在扫描本地主流工具的 Skill 目录…"
                : scan
                  ? `已发现 ${scan.items.length} 个 Skill · 已读取 ${scan.roots.length - blocked.length}/${scan.roots.length} 个目录 · ${detected} 个工具目录存在 · 当前 ${filtered.length} 条结果 · 点击名称查看功能摘要`
                  : "本次未读到本机 Skill"}
            </p>
          </div>
          <div className="skill-actions">
            {resultRows.length > 0 && <button className="skill-copy-history" type="button" onClick={() => setCopyDetailsOpen(true)}><ClipboardCheck size={14} />最近复制（{resultRows.length}）</button>}
            <button
              className="text-button"
              onClick={selectAll}
              disabled={busy || !filtered.length}
            >
              {allVisibleSelected ? "清空选择" : "全选当前结果"}
            </button>
            <button
              className="primary"
              onClick={() => {
                invalidatePreview();
                setCopyOpen(true);
              }}
              disabled={busy || !selected.length}
            >
              <ClipboardCheck size={15} />
              复制（{selected.length}）
            </button>
            <button className="skill-batch-delete" type="button" disabled={busy || !selectedDeletableCount} onClick={() => openDelete(selected)}>
              <Trash2 size={15} />
              移入回收区（{selectedDeletableCount}）
            </button>
          </div>
        </div>

        <div className="skill-toolbar">
          <div className="search-field">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、用途或功能"
            />
          </div>
          <div className="segmented" role="tablist" aria-label="按来源筛选 Skill">
            {sources.map((value) => {
              const draggable = value !== ALL_SOURCE;
              return (
                <button
                  key={value}
                  role="tab"
                  aria-selected={source === value}
                  className={[
                    source === value ? "active" : "",
                    draggingSource === value ? "dragging" : "",
                    dragOverSource === value ? "drag-over" : "",
                  ].filter(Boolean).join(" ")}
                  draggable={draggable}
                  title={draggable ? usageHint(value) : undefined}
                  onClick={() => selectSource(value)}
                  onDragStart={(event) => {
                    if (!draggable) return;
                    draggingRef.current = value;
                    setDraggingSource(value);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", value);
                  }}
                  onDragOver={(event) => {
                    const from = draggingRef.current;
                    if (!draggable || !from || from === value) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverSource(value);
                  }}
                  onDragLeave={() => {
                    setDragOverSource((current) => (current === value ? undefined : current));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    reorderSource(draggingRef.current, value);
                    draggingRef.current = undefined;
                    setDraggingSource(undefined);
                    setDragOverSource(undefined);
                  }}
                  onDragEnd={() => {
                    draggingRef.current = undefined;
                    setDraggingSource(undefined);
                    setDragOverSource(undefined);
                  }}
                >
                  {value}
                </button>
              );
            })}
          </div>
          <button className={`skill-cleanup-filter ${cleanupOnly ? "active" : ""}`} type="button" onClick={() => setCleanupOnly((old) => !old)} aria-pressed={cleanupOnly}>
            建议清理 <span>{cleanupCount}</span>
          </button>
          <button
            className="secondary"
            onClick={() => void runScan()}
            disabled={busy}
          >
            {scanning ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {scanning ? "扫描中" : "重新扫描"}
          </button>
        </div>

        {deleteResults.length > 0 && <div className="skill-results skill-notice" role="status">
          <div className="notice green"><CheckCircle2 size={15} /><div>本次清理结果：{deleteResults.filter(row => row.status === "trashed").length} 项已移入回收区。可在下方恢复。</div></div>
          {deleteResults.map(row => <div className="skill-transfer-row" key={row.id}>
            <div><strong>{row.name}</strong><span className={`badge ${row.status === "trashed" ? "green" : "amber"}`}>{row.status === "trashed" ? "可恢复" : row.status === "skipped" ? "已跳过" : "失败"}</span></div>
            <p>{row.message}</p>
            {row.trashId && <button className="secondary skill-restore-button" type="button" disabled={busy} onClick={() => void restoreOne(row.trashId!)}><RotateCcw size={14} />恢复原位置</button>}
          </div>)}
        </div>}
        {restoreMessage && <div className="notice green skill-notice" role="status"><RotateCcw size={15} /><div>{restoreMessage}</div></div>}
        {scan?.trashError && <div className="notice amber skill-notice"><TriangleAlert size={15} /><div>回收区暂时无法读取：{scan.trashError}</div></div>}

        {blocked.length > 0 && !failure && (
          <div className="notice amber skill-notice">
            <Info size={15} />
            <div>
              以下目录本次未完整读取：
              {blocked.map((root) => `${root.source} ${root.path}${root.message ? `：${root.message}` : ""}`).join("；")}
            </div>
          </div>
        )}

        {scanning && !scan ? (
          <div className="skill-state" role="status">
            <div className="empty">
              <div className="empty-icon">
                <Loader2 size={22} className="spin" />
              </div>
              <h3>正在扫描本机 Skill</h3>
              <p>自动读取各工具与共享 Skill 目录，完成后显示扫描结果。</p>
            </div>
          </div>
        ) : failure ? (
          <div className="skill-state">
            <div className="empty">
              <div className="empty-icon">
                <FolderX size={22} />
              </div>
              <h3>没有读到本机 Skill</h3>
              <p>{failure}</p>
              <button
                className="primary"
                onClick={() => void runScan()}
                disabled={busy}
              >
                <RefreshCw size={15} />
                重新扫描
              </button>
            </div>
          </div>
        ) : !filtered.length ? (
          <div className="skill-state">
            <div className="empty">
              <div className="empty-icon">
                {items.length ? (
                  <Sparkles size={22} />
                ) : (
                  <FolderSearch size={22} />
                )}
              </div>
              <h3>{cleanupOnly ? "暂无建议清理的 Skill" : items.length ? "没有匹配的 Skill" : "未发现本机 Skill"}</h3>
              <p>
                {cleanupOnly ? "可关闭“建议清理”筛选，查看所有 Skill 及逐项依据。" : items.length
                  ? "换个关键词或切换来源；也可以重新扫描获取最新目录。"
                  : "主流工具与共享目录中暂未发现 SKILL.md，安装 Skill 后可重新扫描。"}
              </p>
            </div>
          </div>
        ) : (
          <div className="skill-table">
            <div className="skill-table-head">
              <span />
              <span>名称与用途</span>
              <span>主要功能</span>
              <span>来源 / 范围</span>
              <span>状态</span>
              <span>操作</span>
            </div>
            {filtered.map((item) => (
              <div
                key={item.id}
                className={`skill-row ${selected.includes(item.id) ? "selected" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={busy}
                  onChange={() => toggle(item.id)}
                  aria-label={`选择 ${item.name}`}
                />
                <button className="skill-name" onClick={() => setDetail(item)}>
                  <strong>{item.name}</strong>
                  <span>{item.description}</span>
                </button>
                <div className="skill-tags">
                  {item.features.slice(0, 2).map((feature) => (
                    <span className="badge" key={feature}>
                      {feature}
                    </span>
                  ))}
                  {item.features.length > 2 && (
                    <span className="badge more">
                      +{item.features.length - 2}
                    </span>
                  )}
                </div>
                <div className="skill-meta">
                  <strong>{item.source}</strong>
                  <small>{item.scope}</small>
                </div>
                <div className="skill-status">
                  <span className={`skill-advice-tag ${item.cleanup?.level ?? "unknown"}`} title={item.cleanup?.reasons.join("；")}>
                    {item.cleanup?.title ?? "依据待检查"}
                  </span>
                  <small className="skill-usage-label">{usageLabel(item)}</small>
                </div>
                <div className="skill-row-actions"><button
                  className="skill-row-copy"
                  type="button"
                  disabled={busy || (item.kind != null && item.kind !== "skill")}
                  onClick={(event) => {
                    event.stopPropagation();
                    openSingleCopy(item.id);
                  }}
                  aria-label={`复制 ${item.name}`}
                  title="复制这个 Skill"
                >
                  <ClipboardCheck size={13} />
                  复制
                </button><button className="skill-row-delete" type="button" disabled={busy || !item.cleanup?.deletable} onClick={() => openDelete([item.id])} aria-label={`移入回收区 ${item.name}`} title={item.cleanup?.deletable ? "检查后移入回收区" : item.cleanup?.reasons.join("；") ?? "当前不能安全清理"}><Trash2 size={14} /></button></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="skill-footnote">
        <Info size={13} />
        “最近确认读取”只表示本机会话日志明确读取了该位置的 SKILL.md，不能证明完整运行；未知也不代表长期未用。清理建议只基于可核查的文件状态，移入回收区后可恢复。
      </div>

      {scan && <details className="skill-trash-panel"><summary><span><Trash2 size={15} />回收区 <strong>{scan.trash?.length ?? 0}</strong></span><small>保留原位置，可逐项恢复；恢复时不会覆盖现有目录</small></summary>
        <div className="skill-trash-content">{!scan.trash?.length ? <p>回收区为空。</p> : scan.trash.map(entry => <div className="skill-trash-row" key={entry.id}><div><strong>{entry.name}</strong><small>{new Date(entry.deletedAt).toLocaleString()} · {entry.source}</small><span className="skill-path">{entry.originalPath}</span></div><button className="secondary" type="button" disabled={busy} onClick={() => void restoreOne(entry.id)}><RotateCcw size={14} />恢复</button></div>)}</div>
      </details>}

      {copyToastVisible && resultRows.length > 0 && <div className={`skill-copy-toast ${copyStatusCounts.failed || copyCheckCounts.failed ? "amber" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        {copyStatusCounts.failed || copyCheckCounts.failed ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}
        <div className="skill-copy-toast-content">
          <strong>{result}</strong>
          <span>{copyCheckCounts.passed + copyCheckCounts.warning + copyCheckCounts.failed + copyCheckCounts.unverified > 0
            ? `检查：${copyCheckCounts.passed} 项通过 · ${copyCheckCounts.warning + copyCheckCounts.failed} 项有差异 · ${copyCheckCounts.unverified} 项未验证`
            : "复制结果与文件位置已记录"}</span>
          <button className="text-button" type="button" onClick={() => setCopyDetailsOpen(true)}>查看完整结果 <ChevronRight size={13} /></button>
        </div>
        <button className="icon-button skill-copy-toast-close" type="button" aria-label="收起复制结果提示" onClick={() => setCopyToastVisible(false)}><X size={16} /></button>
      </div>}

      {copyDetailsOpen && resultRows.length > 0 && <Modal
        drawer
        title="最近复制的结果"
        subtitle={`${resultRows.length} 项 · ${scan?.targets.find(option => option.id === copyTarget)?.label ?? copyTarget}`}
        onClose={() => setCopyDetailsOpen(false)}
      >
        <div className="modal-body skill-copy-report">
          <div className={`notice ${copyStatusCounts.failed || copyCheckCounts.failed ? "amber" : "green"}`} role="status">
            {copyStatusCounts.failed || copyCheckCounts.failed ? <TriangleAlert size={15} /> : <CheckCircle2 size={15} />}
            <div><strong>{result}</strong><p>{copyCheckCounts.passed + copyCheckCounts.warning + copyCheckCounts.failed + copyCheckCounts.unverified > 0
              ? `检查：${copyCheckCounts.passed} 项通过 · ${copyCheckCounts.warning + copyCheckCounts.failed} 项有差异 · ${copyCheckCounts.unverified} 项未验证`
              : "未返回逐项检查；请查看复制状态及失败原因。"}</p></div>
          </div>
          {resultRows.map((row, index) => <div className="skill-transfer-row" key={`${row.name}-${index}`}>
            <div><strong>{row.name}</strong><span className={`badge ${row.status === "copied" ? "green" : row.status === "failed" ? "amber" : "blue"}`}>{row.status === "copied" ? "已复制并检查" : row.status === "skipped" ? "已跳过" : "复制失败"}</span></div>
            <p>{row.message}</p>
            {row.activationHint && <p>使用方式：{row.activationHint}</p>}
            {(row.destination || row.backup) && <details className="skill-copy-report-paths"><summary>复制路径与旧版本备份</summary>
              {row.destination && <p>目标目录：<span className="skill-path">{row.destination}</span></p>}
              {row.backup && <p>备份目录：<span className="skill-path">{row.backup}</span></p>}
            </details>}
            <VerificationDetails value={row.verification} />
          </div>)}
        </div>
      </Modal>}

      {detail && (
        <Modal
          drawer
          title={detail.name}
          subtitle={`${detail.source} · ${detail.scope}`}
          onClose={() => setDetail(undefined)}
        >
          <div className="modal-body skill-detail">
            <p className="skill-lead">{detail.description}</p>
            <h3>主要功能</h3>
            <div className="skill-tags">
              {detail.features.map((feature) => (
                <span className="badge blue" key={feature}>
                  {feature}
                </span>
              ))}
            </div>
            <h3>本机位置</h3>
            <div>
              <span className="skill-path">{detail.path}</span>
            </div>
            <dl className="detail-grid">
              <dt>摘要依据</dt>
              <dd>说明文件与标题规则提取 · 运行能力未验证</dd>
              <dt>复制内容</dt>
              <dd>整个 Skill 目录内的说明、脚本与资源文件</dd>
            </dl>
            <div className="skill-cleanup-detail"><h3>清理建议</h3><span className={`skill-advice-tag ${detail.cleanup?.level ?? "unknown"}`}>{detail.cleanup?.title ?? "依据待检查"}</span>
              {detail.cleanup?.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
              {detail.cleanup?.impact.map((impact, index) => <p className="impact" key={index}>影响：{impact}</p>)}
              <p>{usageLabel(detail)}。{detail.usage?.evidence}</p>
              {detail.usage?.lastObservedAt && <p>记录时间：{new Date(detail.usage.lastObservedAt).toLocaleString()}</p>}
            </div>
            {(() => {
              // 免责声明已由上面的"摘要依据"行与列表脚注表达；抽屉里只保留该 Skill 特有的提醒
              const specific = detail.warnings.filter(
                (warning) =>
                  !warning.startsWith("摘要来自") &&
                  !warning.startsWith("依赖、脚本与配置"),
              );
              return specific.length > 0 ? (
                <div className="notice amber">
                  <TriangleAlert size={15} />
                  <div>
                    <strong>复制前需要注意</strong>
                    {specific.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}
            <div className="skill-detail-actions"><button
              className="primary"
              disabled={busy || (detail.kind != null && detail.kind !== "skill")}
              onClick={() => openSingleCopy(detail.id)}
            >
              <ClipboardCheck size={15} />
              复制这个 Skill
            </button><button className="skill-batch-delete" type="button" disabled={busy || !detail.cleanup?.deletable} onClick={() => openDelete([detail.id])}><Trash2 size={15} />移入回收区</button></div>
          </div>
        </Modal>
      )}

      {copyOpen && (
        <Modal
          title="检查并复制 Skill"
          subtitle={`已选择 ${selected.length} 个 Skill · 自动检查与修复，源文件不变`}
          onClose={closeCopy}
        >
          <div className="modal-body skill-copy-body">
            <label>
              复制到
              <select
                value={target}
                disabled={busy}
                onChange={(event) => {
                  invalidatePreview();
                  setTarget(event.target.value);
                }}
              >
                {(scan?.targets.length
                  ? scan.targets
                  : [{ id: "", label: "暂不可用", path: "", installed: false, copySupported: false, directoryExists: false }]
                ).map((option) => (
                  <option key={option.id} value={option.id} disabled={option.copySupported === false}>
                    {option.copySupported === false
                      ? `${option.label}（需在工具内导入）`
                      : (option.directoryExists ?? option.installed)
                        ? `${option.label}（目录存在）`
                        : `${option.label}（将创建目录）`}
                  </option>
                ))}
              </select>
            </label>
            <div className="skill-transfer-path">
              <small>目标用户级目录 · 目录存在不代表工具已安装</small>
              <span className="skill-path">
                {preview?.path ??
                  scan?.targets.find((option) => option.id === target)?.path ??
                  "请选择目标工具"}
              </span>
            </div>
            <div
              className={`notice skill-target-presence ${!targetPreviewItems && !previewError && !targetBlocked ? "" : targetPresenceNeedsAttention || previewError || targetBlocked ? "amber" : "green"}`}
              role="status"
              aria-live="polite"
            >
              {!targetPreviewItems && !previewError && !targetBlocked ? (
                <Loader2 size={15} className="spin" />
              ) : targetPresenceNeedsAttention || previewError || targetBlocked ? (
                <TriangleAlert size={15} />
              ) : (
                <CheckCircle2 size={15} />
              )}
              <div>
                <strong>目标同名检查</strong>
                <p>{targetPresenceMessage}</p>
              </div>
            </div>
            {selectedTarget?.activationHint && <p>使用方式：{selectedTarget.activationHint}</p>}
            {selectedTarget?.directorySource && <details>
              <summary>目录依据</summary>
              <p>{selectedTarget.directorySource.label} · 核对日期 {selectedTarget.directoryCheckedAt}</p>
              <p>{selectedTarget.directorySource.url}</p>
              <p>适用于目标工具的默认本机用户配置；自定义配置目录、远程和云端会话需要在对应环境安装。</p>
            </details>}
            {scan?.targets.some(option => option.copySupported === false) && <details>
              <summary>暂不支持直接复制的工具</summary>
              {scan.targets.filter(option => option.copySupported === false).map(option => <p key={option.id}>{option.label}：{option.blockedReason}</p>)}
            </details>}
            <div className="skill-tags skill-copy-list">
              {items
                .filter((item) => selected.includes(item.id))
                .map((item) => (
                  <span className="badge" key={item.id}>
                    {item.name}
                  </span>
                ))}
            </div>
            <div className="skill-copy-check">
              <strong>复制说明</strong>
              <span>
                <Check size={14} />
                内容相同则跳过；内容不同时先备份旧目录，再安装新副本
              </span>
              <span>
                <Check size={14} />
                Skill 内部符号链接会展开复制并保留可执行权限；外部链接保留为本机依赖并提示
              </span>
              <span>
                <Check size={14} />
                不安装依赖、不执行任何脚本
              </span>
              <span><Check size={14} />明确的元信息缩进错误会在目标副本自动修复，并验证字段值保持一致</span>
              <details>
                <summary>复制规则</summary>
                <p>复制前会解析符号链接、检查链接失效、循环引用、内容凭据、资源路径、权限及目录大小。普通文件名包含 token 或 secret 不会单独拦截。无法复制时会列出具体路径和原因；超限或权限不足时不会留下不完整副本。</p>
              </details>
            </div>
            <p role="status" aria-live="polite">
              {targetBlocked
                ? selectedTarget?.blockedReason
                : busy && preview
                ? "正在复制并检查文件完整性…"
                : !preview && !previewError
                  ? "正在自动检查，请稍候…"
                  : previewError
                    ? "检查未完成，请处理提示的问题后重新检查。"
                    : copyableCount
                      ? `自动检查已完成，${copyableCount} 项可复制或备份后更新。可直接确认。`
                      : "自动检查已完成，暂无可复制项，请查看下方结果。"}
            </p>
            {previewError && (
              <div className="notice amber" role="alert">
                <TriangleAlert size={15} />
                <div>{previewError}</div>
              </div>
            )}
            {preview && (
              <div className="skill-transfer-preview" aria-label="兼容检查结果">
                <p>
                  点击“确认复制”后，保留说明、元信息、脚本和资源；下方列出的格式修复会自动应用到目标副本。工具核对源内容及预期副本哈希，源文件保持不变。OpenCode CLI 可用时还会检查目标文件是否被发现。
                </p>
                {preview.items.map((item) => (
                  <div className="skill-transfer-row" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <span
                        className={`badge ${item.status === "ready" ? "green" : item.status === "update" ? "blue" : item.status === "convert" ? "blue" : "amber"}`}
                      >
                        {
                          {
                            ready: item.verification?.checks.some(check => check.label === "自动修复计划") ? "自动修复后复制" : "可原样复制",
                            update: "备份后更新",
                            convert: "自动转换",
                            blocked: "检查未通过",
                            skipped: "跳过",
                          }[item.status]
                        }
                      </span>
                    </div>
                    {item.reason && <p>{item.reason}</p>}
                    {item.changes.length > 0 && (
                      <ul aria-label="自动处理摘要">
                        {item.changes.map((change, index) => (
                          <li key={index}>{change}</li>
                        ))}
                      </ul>
                    )}
                    {!item.verification && item.warnings.length > 0 && (
                      <ul
                        className="skill-transfer-warnings"
                        aria-label="兼容提醒"
                      >
                        {item.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <VerificationDetails value={item.verification} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={closeCopy}>
              返回选择
            </button>
            <button
              className="secondary"
              disabled={busy || !target || !selected.length || targetBlocked}
              onClick={() => void checkCopy()}
              title="源文件或目标目录发生变化后，可重新检查；首次打开和切换目标时会自动检查"
            >
              {busy && !preview ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <ShieldCheck size={15} />
              )}
              {busy && !preview ? "检查中…" : "重新检查"}
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                targetBlocked ||
                !copyableCount
              }
              onClick={() => void doCopy()}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <ClipboardCheck size={15} />
              )}
              {busy && preview
                ? "复制并检查中…"
                : !preview && !previewError
                  ? "检查中…"
                  : `确认复制${preview ? `（${copyableCount}）` : ""}`}
            </button>
          </div>
        </Modal>
      )}
      {deleteOpen && <Modal title="检查并移入回收区" subtitle={`已选择 ${deleteIds.length} 项 · 逐项核对后可恢复`} onClose={closeDelete}>
        <div className="modal-body skill-delete-body">
          <div className="notice amber"><Info size={15} /><div>只移动本机已扫描的 Skill 目录或链接；移动前会再次核对路径、类型及内容。不会执行 Skill 脚本，不会删除链接指向的原文件。恢复时不会覆盖同名目录。</div></div>
          {deleteError && <div className="notice amber" role="alert"><TriangleAlert size={15} /><div>{deleteError}</div></div>}
          {!deletePreview && !deleteError && <p className="skill-delete-wait"><Loader2 size={16} className="spin" />正在检查所选项目…</p>}
          {deletePreview?.items.map(row => <div className="skill-delete-card" key={row.id}>
            <div><strong>{row.name}</strong><span className={`skill-advice-tag ${row.status === "blocked" ? "repair" : row.cleanup.level}`}>{row.status === "blocked" ? "不能移动" : row.cleanup.title}</span></div>
            <span className="skill-path">{row.path}</span>
            {row.reason && <p className="skill-delete-reason">{row.reason}</p>}
            {row.cleanup.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
            {row.cleanup.impact.map((impact, index) => <p className="impact" key={index}>影响：{impact}</p>)}
            <p>{row.usage.status === "observed-read" && row.usage.lastObservedAt ? `最近确认读取：${new Date(row.usage.lastObservedAt).toLocaleString()}` : "使用情况未知"}。{row.usage.evidence}</p>
          </div>)}
        </div>
        <div className="modal-footer"><button className="secondary" disabled={busy} onClick={closeDelete}>取消</button><button className="secondary" disabled={busy} onClick={() => void checkDelete()}><RefreshCw size={15} />重新检查</button><button className="skill-delete-confirm" type="button" disabled={busy || !deletePreview?.items.some(row => row.status === "ready")} onClick={() => void doDelete()}>{busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}确认移入回收区（{deletePreview?.items.filter(row => row.status === "ready").length ?? 0}）</button></div>
      </Modal>}
    </div>
  );
}
