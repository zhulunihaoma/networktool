import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileAuditReport } from "./file-report";
import type { Store } from "./store";
import type {
  FileWorkspace,
  FileScope,
  FilePolicy,
  FileOperation,
  FileCandidate,
  AuditEvent,
  FileAlert,
  AuditPage,
} from "../../src/shared/assistant";
interface LocalScope extends FileScope {
  root: string;
  manualPaths?: string[];
}
interface State {
  scopes: LocalScope[];
  events: AuditEvent[];
  alerts: FileAlert[];
  sequence: number;
}
const initial = (): State => ({
  scopes: [],
  events: [],
  alerts: [],
  sequence: 0,
});
export function candidateReason(relative: string): string | undefined {
  const name = path.basename(relative).toLowerCase();
  const parts = relative.toLowerCase().split(/[\\/]/);
  if (name === ".env" || name.startsWith(".env."))
    return "环境配置，可能包含密钥（候选）";
  if (
    /^(id_rsa|id_ed25519|id_ecdsa)$/.test(name) ||
    /\.(key|p12|pfx|pem)$/.test(name)
  )
    return "密钥或证书文件（候选）";
  if (parts.includes(".aws") && ["credentials", "config"].includes(name))
    return "云账号配置（候选）";
  if (parts.includes(".ssh") && name === "config") return "SSH 配置（候选）";
  if (/\.(sql|bak|dump)$/.test(name)) return "数据库或备份文件（候选）";
  if (/(客户|财务|薪资|customer|payroll)/i.test(name))
    return "名称提示客户或财务数据（候选）";
  return undefined;
}
const identity = (stat: Awaited<ReturnType<typeof fs.lstat>>) =>
  `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}`;
export async function scanCandidates(
  root: string,
  signal: AbortSignal,
  limits = { entries: 10000, candidates: 500, depth: 12, milliseconds: 10000 },
) {
  const start = Date.now();
  const candidates: FileCandidate[] = [],
    warnings: string[] = [];
  let examined = 0,
    skipped = 0,
    truncated = false;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("请选择本机真实目录；不支持符号链接或文件。");
  const canonical = await fs.realpath(root);
  const visit = async (directory: string, depth: number) => {
    signal.throwIfAborted();
    if (depth > limits.depth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.opendir(directory);
    } catch {
      skipped++;
      warnings.push("部分目录权限不足，未枚举。");
      return;
    }
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (
        examined >= limits.entries ||
        candidates.length >= limits.candidates ||
        Date.now() - start > limits.milliseconds
      ) {
        truncated = true;
        break;
      }
      examined++;
      const full = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) {
          skipped++;
          continue;
        }
        // Recheck containment at each directory boundary. Enumeration never opens file contents.
        const final = await fs.realpath(full);
        const relativeFinal = path.relative(canonical, final);
        if (
          relativeFinal.startsWith(".." + path.sep) ||
          relativeFinal === ".." ||
          path.isAbsolute(relativeFinal)
        ) {
          skipped++;
          continue;
        }
        if (stat.isDirectory()) {
          if (
            ["node_modules", ".git", ".codegraph", "dist", "release"].includes(
              entry.name,
            )
          ) {
            skipped++;
            continue;
          }
          await visit(full, depth + 1);
          if (truncated) break;
        } else if (stat.isFile()) {
          const relativePath = path.relative(canonical, full),
            reason = candidateReason(relativePath);
          if (reason)
            candidates.push({
              id: randomUUID(),
              relativePath,
              reason,
              size: stat.size,
              identity: identity(stat),
              unsupported: stat.nlink > 1,
            });
        } else skipped++;
      } catch (error) {
        signal.throwIfAborted();
        skipped++;
      }
    }
  };
  await visit(canonical, 0);
  if (skipped)
    warnings.push(
      "符号链接、特殊文件、生成目录或不可访问位置已跳过；此结果不是完整敏感文件清单。",
    );
  if (truncated)
    warnings.push("达到扫描预算，候选清单不完整。请缩小范围后重新扫描。");
  return {
    root: canonical,
    candidates: candidates.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
    examined,
    skipped,
    truncated,
    warnings: [...new Set(warnings)],
  };
}
export class FilePolicies {
  private scanController?: AbortController;
  constructor(private store: Pick<Store, "assistant" | "putAssistant">) {}
  private state() {
    return this.store.assistant<State>("files", initial());
  }
  workspace(): FileWorkspace {
    const state = this.state();
    return {
      scopes: state.scopes.map(
        ({ root: _root, manualPaths: _manualPaths, ...scope }) => scope,
      ),
      alerts: [...state.alerts].reverse(),
      scanning: !!this.scanController,
      coverage: {
        mode: "policy_validation_only",
        ruleEnabled: state.scopes.some((s) =>
          s.policies.some((p) => p.enabled),
        ),
        eventCollection: "assistant_only",
        canBlockToolAccess: false,
        gaps: [
          "当前仅保存并校验文件策略；尚未接入第三方工具的文件调用。",
          "仅记录助手自己的元数据扫描和策略校验，未采集任何 AI 工具读取事件。",
          "没有隔离启动、OS 文件审计、系统阻断或模型提交回执；已有工具、终端、其他 MCP 及远端均未覆盖。",
        ],
      },
    };
  }
  private record(state: State, event: Omit<AuditEvent, "id" | "seq" | "time">) {
    const record = {
      ...event,
      id: randomUUID(),
      seq: ++state.sequence,
      time: Date.now(),
    };
    state.events.push(record);
    return record;
  }
  private persist(state: State) {
    // Fail visibly rather than discard evidence when this initial storage budget is exhausted.
    if (state.events.length > 10000 || state.alerts.length > 2000)
      throw new Error(
        "审计记录容量已达上限，已拒绝本次变更；请先归档本地数据库。",
      );
    this.store.putAssistant("files", state);
  }
  cancel() {
    this.scanController?.abort(new Error("扫描已取消，原有范围和策略已保留。"));
  }
  async scan(root: string, scopeId?: string) {
    if (this.scanController)
      throw new Error("另一个范围正在扫描，请先等待或停止。");
    if (!scopeId && this.state().scopes.length >= 20)
      throw new Error("最多保存 20 个保护范围，请使用已有范围。");
    const controller = (this.scanController = new AbortController());
    try {
      const scanned = await scanCandidates(root, controller.signal);
      controller.signal.throwIfAborted();
      // Read the latest state after async work so concurrent policy edits are not lost.
      let state = this.state();
      const previous = state.scopes.find(
        (s) => s.id === scopeId || s.root === scanned.root,
      );
      for (const relativePath of previous?.manualPaths || []) {
        if (scanned.candidates.some((c) => c.relativePath === relativePath))
          continue;
        try {
          const candidate = await this.manualCandidate(
            scanned.root,
            relativePath,
          );
          if (scanned.candidates.length < 500)
            scanned.candidates.push(candidate);
          else scanned.truncated = true;
        } catch {
          scanned.warnings.push(
            "部分手动候选已消失、替换或不在支持范围，请重新确认。",
          );
        }
      }
      controller.signal.throwIfAborted();
      state = this.state();
      const warnings = [...scanned.warnings];
      let changed = 0;
      for (const candidate of scanned.candidates) {
        const old = previous?.candidates.find(
          (c) => c.relativePath === candidate.relativePath,
        );
        // Reuse resource identity only if the physical file and its version are unchanged.
        if (old?.identity === candidate.identity) candidate.id = old.id;
        else if (old) changed++;
      }
      if (changed)
        warnings.push(
          `${changed} 个候选文件已变更或替换，原精确规则不再绑定，请重新确认。`,
        );
      const scope: LocalScope = {
        ...scanned,
        warnings,
        id: previous?.id || randomUUID(),
        name: path.basename(scanned.root) || scanned.root,
        manualPaths: previous?.manualPaths || [],
        policies: (previous?.policies || []).filter((p) =>
          scanned.candidates.some((c) => c.id === p.resourceId),
        ),
        scannedAt: Date.now(),
      };
      state.scopes = [...state.scopes.filter((s) => s.id !== scope.id), scope];
      this.record(state, {
        scopeId: scope.id,
        operation: "enumerate",
        result: "metadata_only",
        source: "scanner_actor",
        detail: `枚举 ${scope.examined} 个条目，发现 ${scope.candidates.length} 个候选；没有读取正文。${scope.truncated ? "预算截断。" : ""}`,
      });
      this.persist(state);
      return { ...this.workspace(), scanning: false };
    } finally {
      if (this.scanController === controller) this.scanController = undefined;
    }
  }
  async rescan(id: string) {
    const scope = this.state().scopes.find((s) => s.id === id);
    if (!scope) throw new Error("范围不存在。");
    return this.scan(scope.root, scope.id);
  }
  scopeRoot(id: string) {
    const scope = this.state().scopes.find((s) => s.id === id);
    if (!scope) throw new Error("范围不存在。");
    return scope.root;
  }
  private async manualCandidate(
    root: string,
    relativePath: string,
  ): Promise<FileCandidate> {
    if (
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(".." + path.sep)
    )
      throw new Error("请选择当前范围内的文件。");
    const full = path.join(root, relativePath),
      stat = await fs.lstat(full);
    const final = await fs.realpath(full),
      relative = path.relative(root, final);
    if (!stat.isFile() || stat.isSymbolicLink() || relative !== relativePath)
      throw new Error("不支持符号链接、范围外文件或特殊对象。");
    return {
      id: randomUUID(),
      relativePath,
      reason: "用户指定敏感候选（未读取内容）",
      size: stat.size,
      identity: identity(stat),
      unsupported: stat.nlink > 1,
    };
  }
  async addCandidate(scopeId: string, absolutePath: string) {
    if (this.scanController) throw new Error("请等待扫描结束。");
    const root = this.scopeRoot(scopeId);
    // macOS native dialogs and os.tmpdir may use /var while realpath uses /private/var.
    // Canonicalize the parent, then lstat the selected file without following its link.
    const parent = await fs.realpath(path.dirname(absolutePath));
    const relative = path.relative(
      root,
      path.join(parent, path.basename(absolutePath)),
    );
    const candidate = await this.manualCandidate(root, relative);
    const state = this.state(),
      scope = state.scopes.find((s) => s.id === scopeId)!;
    const old = scope.candidates.find((c) => c.relativePath === relative);
    if (!old && scope.candidates.length >= 500)
      throw new Error("候选已达 500 个，请缩小范围。");
    if (old?.identity === candidate.identity) candidate.id = old.id;
    scope.candidates = [
      ...scope.candidates.filter((c) => c.relativePath !== relative),
      candidate,
    ].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    scope.policies = scope.policies.filter((p) =>
      scope.candidates.some((c) => c.id === p.resourceId),
    );
    scope.manualPaths = [...new Set([...(scope.manualPaths || []), relative])];
    this.record(state, {
      scopeId,
      resourceId: candidate.id,
      operation: "enumerate",
      result: "metadata_only",
      source: "scanner_actor",
      detail: "添加用户指定文件，仅查询元数据；未读取内容。",
    });
    this.persist(state);
    return this.workspace();
  }
  save(
    scopeId: string,
    policy: Omit<FilePolicy, "revision" | "activeRevision">,
    expected: number,
  ) {
    if (this.scanController)
      throw new Error("请先完成扫描再保存策略，避免文件身份发生变化。");
    const state = this.state(),
      scope = state.scopes.find((s) => s.id === scopeId);
    if (!scope || !scope.candidates.some((c) => c.id === policy.resourceId))
      throw new Error("候选文件不存在，请重新扫描。");
    const old = scope.policies.find((p) => p.resourceId === policy.resourceId);
    if ((old?.revision || 0) !== expected)
      throw new Error("策略已被更新，请刷新后重新提交；未覆盖其他修改。");
    const revision = expected + 1;
    // This is acknowledged by the local evaluator only, never a sandbox/driver deployment.
    const saved: FilePolicy = { ...policy, revision, activeRevision: revision };
    scope.policies = [
      ...scope.policies.filter((p) => p.resourceId !== policy.resourceId),
      saved,
    ];
    this.record(state, {
      scopeId,
      resourceId: policy.resourceId,
      operation: "policy_update",
      result: "policy_saved",
      source: "user_policy",
      policyRevision: revision,
      detail: "本地策略校验器已确认此版本；第三方工具访问未受控。",
    });
    this.persist(state);
    return this.workspace();
  }
  async evaluate(
    scopeId: string,
    resourceId: string,
    operation: FileOperation,
  ) {
    const snapshot = this.state(),
      scope = snapshot.scopes.find((s) => s.id === scopeId);
    const candidate = scope?.candidates.find((c) => c.id === resourceId);
    if (!scope || !candidate) throw new Error("文件引用已失效，请重新扫描。");
    let stale = false;
    try {
      const current = await this.manualCandidate(
        scope.root,
        candidate.relativePath,
      );
      stale =
        current.identity !== candidate.identity ||
        current.unsupported !== candidate.unsupported;
    } catch {
      stale = true;
    }
    const state = this.state(),
      latestScope = state.scopes.find((s) => s.id === scopeId);
    stale ||= !latestScope?.candidates.some(
      (c) => c.id === resourceId && c.identity === candidate.identity,
    );
    const policy = latestScope?.policies.find(
      (p) => p.resourceId === resourceId,
    );
    const decision =
      stale || candidate.unsupported
        ? "deny"
        : policy?.enabled
          ? policy[operation]
          : "ask";
    const event = this.record(state, {
      scopeId,
      resourceId,
      operation,
      source: "policy_validation",
      result:
        decision === "deny"
          ? "denied"
          : decision === "ask"
            ? "confirmation_required"
            : "allowed_evaluation",
      policyRevision: policy?.revision,
      detail: stale
        ? "文件身份、范围或可访问性已变化；自检拒绝，请重新扫描。未访问正文。"
        : candidate.unsupported
          ? "多硬链接对象不支持；策略校验拒绝，未访问正文。"
          : "助手策略自检请求；未读取、修改或发送文件，也不是 AI 工具访问事件。",
    });
    if (decision === "deny") {
      const ruleId =
        stale || candidate.unsupported
          ? "F06"
          : operation === "read"
            ? "F01"
            : operation === "write"
              ? "F03"
              : "F05";
      let alert = state.alerts.find(
        (a) =>
          a.ruleId === ruleId &&
          a.scopeId === scopeId &&
          a.resourceId === resourceId &&
          a.operation === operation &&
          a.state === "open" &&
          event.time - a.last <= 30000,
      );
      if (alert) {
        alert.last = event.time;
        alert.count++;
        alert.evidenceIds.push(event.id);
      } else {
        alert = {
          id: randomUUID(),
          scopeId,
          resourceId,
          operation,
          ruleId,
          state: "open",
          first: event.time,
          last: event.time,
          count: 1,
          evidenceIds: [event.id],
        };
        state.alerts.push(alert);
      }
    }
    this.persist(state);
    return { decision, workspace: this.workspace() };
  }
  audit(filter: {
    scopeId?: string;
    operation?: AuditEvent["operation"];
    cursor?: number;
  }): AuditPage {
    const events = this.state()
      .events.filter(
        (e) =>
          (!filter.scopeId || e.scopeId === filter.scopeId) &&
          (!filter.operation || e.operation === filter.operation) &&
          (!filter.cursor || e.seq < filter.cursor),
      )
      .reverse();
    const page = events.slice(0, 100);
    return {
      events: page,
      nextCursor: events.length > 100 ? page.at(-1)!.seq : undefined,
    };
  }
  acknowledge(id: string) {
    const state = this.state(),
      alert = state.alerts.find((a) => a.id === id);
    if (!alert) throw new Error("告警不存在。");
    alert.state = "acknowledged";
    this.persist(state);
    return this.workspace();
  }
  report(scopeId: string | undefined, format: "md" | "json") {
    const state = this.state();
    if (scopeId && !state.scopes.some((s) => s.id === scopeId))
      throw new Error("范围不存在，请刷新。");
    return fileAuditReport(
      this.workspace(),
      [...state.events].reverse(),
      scopeId,
      format,
    );
  }
}
