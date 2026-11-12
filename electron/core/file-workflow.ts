import fs from "node:fs/promises";
import {
  constants,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { FilePolicies, identity, type State } from "./file-policies";
import type { Store } from "./store";
import type {
  FileOperation,
  FileDecision,
  FilePolicy,
  FileWorkspace,
} from "../../src/shared/assistant";
import {
  FILE_OPERATIONS,
  fileDecision,
  type FileDraft,
  type FileTrial,
  type FileTask,
  type FileTaskResult,
  type FileWorkflowData,
} from "../../src/shared/file-workflow";

const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function redactLocalText(text: string) {
  let replacements = 0;
  const patterns = [
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
    /((?:api[_-]?key|secret|password|token|密码|密钥)\s*[:=]\s*)[^\r\n]+/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b1[3-9]\d{9}\b/g,
    /\b\d{15,19}\b/g,
  ];
  for (const pattern of patterns)
    text = text.replace(pattern, (_match, prefix?: string) => {
      replacements++;
      return (typeof prefix === "string" ? prefix : "") + "[已隐藏]";
    });
  return { content: text, replacements };
}

/** Own-process gate. It never grants permission to arbitrary third-party apps. */
export class FileWorkflow extends FilePolicies {
  private copies = new Map<
    string,
    { content: string; digest: string; expiresAt: number }
  >();
  private trials = new Map<string, FileTrial>();
  private running = new Set<string>();
  private deploymentError = "";
  constructor(
    store: Pick<Store, "assistant" | "putAssistant">,
    private snapshotFile?: string,
  ) {
    super(store);
    const state = this.state(),
      data = this.data(state);
    // Local UI sessions cannot survive a process restart as live permissions.
    for (const g of data.grants)
      if (g.status === "active") g.status = "invalid";
    for (const t of data.tasks)
      if (t.status === "running" || t.status === "ready") {
        t.status = "failed";
        t.detail = "应用重启，未确认操作结果；请重新发起。";
      }
    this.persist(state);
    this.deploy();
  }
  protected override policyDecision(
    state: State,
    scopeId: string,
    resourceId: string,
    operation: FileOperation,
  ) {
    return this.effective(state, scopeId, resourceId, operation).decision;
  }
  private effective(
    state: State,
    scopeId: string,
    resourceId: string,
    operation: FileOperation = "read",
  ): { decision: FileDecision; fingerprint: string } {
    const origin = state.scopes.find((s) => s.id === scopeId);
    const file = origin?.candidates.find((c) => c.id === resourceId);
    if (!origin || !file)
      return { decision: "deny" as const, fingerprint: "missing" };
    const target = path.join(origin.root, file.relativePath);
    const rules = state.scopes
      .flatMap((s) =>
        s.policies
          .filter((p) => p.enabled)
          .flatMap((p) => {
            const c = s.candidates.find((c) => c.id === p.resourceId);
            if (!c || path.join(s.root, c.relativePath) !== target) return [];
            return [
              {
                scopeId: s.id,
                resourceId: p.resourceId,
                revision: p.revision,
                decision:
                  c.review !== "stale" && c.identity === file.identity
                    ? fileDecision(p, operation)
                    : "deny",
              },
            ];
          }),
      )
      .sort(
        (a, b) =>
          a.scopeId.localeCompare(b.scopeId) ||
          a.resourceId.localeCompare(b.resourceId),
      );
    const decision = rules.some((p) => p.decision === "deny")
      ? "deny"
      : !rules.length || rules.some((p) => p.decision === "ask")
        ? "ask"
        : "allow";
    return { decision, fingerprint: hash(rules) };
  }
  private data(state: State): FileWorkflowData {
    return (state.workflow ??= {
      tasks: [],
      grants: [],
      events: [],
      history: [],
    });
  }
  private event(
    state: State,
    event: Omit<FileWorkflowData["events"][number], "id" | "at">,
  ) {
    const data = this.data(state);
    if (data.events.length >= 5000)
      throw new Error("任务记录容量已满，请先导出并归档。");
    data.events.unshift({ ...event, id: randomUUID(), at: Date.now() });
  }
  private snapshot() {
    return {
      version: 1,
      entries: this.state().scopes.flatMap((s) =>
        s.policies
          .filter((p) => p.enabled)
          .map((p) => {
            const c = s.candidates.find((c) => c.id === p.resourceId);
            return c
              ? [
                  {
                    path: path.join(s.root, c.relativePath),
                    identity: c.identity,
                    stale: c.review === "stale",
                    read: p.read,
                    write: p.write,
                    delete: p.delete || "deny",
                    revision: p.revision,
                    resourceId: p.resourceId,
                  },
                ]
              : [];
          })
          .flat(),
      ),
    };
  }
  private ensureMarker() {
    if (!this.snapshotFile) return;
    mkdirSync(path.dirname(this.snapshotFile), {
      recursive: true,
      mode: 0o700,
    });
    const marker = path.join(
      path.dirname(this.snapshotFile),
      "file-policy-required",
    );
    if (!existsSync(marker)) {
      try {
        writeFileSync(marker, "enabled", { mode: 0o600, flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }
  private deploy() {
    if (!this.snapshotFile) return;
    try {
      mkdirSync(path.dirname(this.snapshotFile), {
        recursive: true,
        mode: 0o700,
      });
      const snapshot = this.snapshot();
      if (snapshot.entries.length) this.ensureMarker();
      const temp = this.snapshotFile + ".tmp";
      writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
      renameSync(temp, this.snapshotFile);
      this.deploymentError = "";
    } catch {
      this.deploymentError =
        "规则已保存，但钩子快照写入失败。请检查数据目录权限后重试下发。";
    }
  }
  retryDeployment() {
    this.deploy();
    return this.workspace();
  }
  override workspace(): FileWorkspace {
    const state = this.state(),
      data = this.data(state);
    let changed = false;
    for (const g of data.grants) {
      const task = data.tasks.find((t) => t.id === g.taskId);
      if (
        g.status === "active" &&
        task &&
        this.effective(state, task.scopeId, task.resourceId).fingerprint !==
          task.policyFingerprint
      ) {
        g.status = "invalid";
        changed = true;
      }
      if (g.status === "active" && g.expiresAt <= Date.now()) {
        g.status = "expired";
        changed = true;
      }
    }
    if (changed) this.persist(state);
    let published = false;
    try {
      published =
        !!this.snapshotFile &&
        hash(JSON.parse(readFileSync(this.snapshotFile, "utf8"))) ===
          hash(this.snapshot());
    } catch {}
    const required =
      !!this.snapshotFile &&
      existsSync(
        path.join(path.dirname(this.snapshotFile), "file-policy-required"),
      );
    return {
      ...super.workspace(),
      coverage: {
        mode: "managed_local",
        ruleEnabled: state.scopes.some((s) =>
          s.policies.some((p) => p.enabled),
        ),
        eventCollection: "assistant_only",
        canBlockToolAccess: false,
        gaps: [
          "本地任务只处理明确选择的 UTF-8 文本；不修改或删除原件。",
          "文件规则快照只约束已加载本应用钩子、且提供可解析路径的 AI 操作；任意脚本、远程、容器和其他应用未覆盖。",
          "未安装 Windows Minifilter 或 macOS Endpoint Security 扩展；未接入模型提交通道，生成副本不代表已发送。",
        ],
      },
      workflow: {
        ...data,
        hook: {
          state: published
            ? "published"
            : this.deploymentError || required
              ? "error"
              : "unavailable",
          detail:
            this.deploymentError ||
            (published
              ? "当前文件规则快照已写入并回读一致；工具是否加载钩子请在操作规则页核验。"
              : required
                ? "文件规则快照缺失、损坏或与当前规则不一致；钩子可能暂时阻止操作或使用旧规则，请点击重新下发并核验。"
                : "未配置或快照不一致；不能确认 AI 钩子已接收本版规则。"),
        },
      },
    };
  }
  override async scan(root: string, scopeId?: string) {
    await super.scan(root, scopeId);
    this.deploy();
    return this.workspace();
  }
  override async addCandidate(scopeId: string, file: string) {
    await super.addCandidate(scopeId, file);
    this.deploy();
    return this.workspace();
  }
  private async current(scopeId: string, resourceId: string) {
    if (super.workspace().scanning)
      throw new Error("请先完成或停止扫描再操作。");
    const scope = this.state().scopes.find((s) => s.id === scopeId),
      candidate = scope?.candidates.find((c) => c.id === resourceId);
    if (!scope || !candidate) throw new Error("文件引用已失效，请重新扫描。");
    if (candidate.review === "stale")
      throw new Error(
        "文件已变化或未发现，请先重新确认文件版本；原规则仍保持限制。",
      );
    const current = await this.manualCandidate(
      scope.root,
      candidate.relativePath,
    );
    if (current.unsupported || current.identity !== candidate.identity)
      throw new Error(
        "文件版本或身份已变化，请重新扫描并确认；旧授权不可复用。",
      );
    if (super.workspace().scanning)
      throw new Error("扫描正在进行，文件引用尚未稳定，请稍后重试。");
    const latestScope = this.state().scopes.find((s) => s.id === scopeId);
    const latestCandidate = latestScope?.candidates.find(
      (c) => c.id === resourceId,
    );
    if (
      !latestScope ||
      !latestCandidate ||
      latestCandidate.identity !== candidate.identity
    )
      throw new Error("扫描范围已变化，请重新确认。");
    return { scope: latestScope, candidate: latestCandidate };
  }
  async reconfirm(scopeId: string, resourceId: string) {
    if (super.workspace().scanning) throw new Error("请先完成或停止扫描。");
    const stateBefore = this.state(),
      scopeBefore = stateBefore.scopes.find((s) => s.id === scopeId),
      old = scopeBefore?.candidates.find((c) => c.id === resourceId);
    if (!scopeBefore || !old || old.review !== "stale")
      throw new Error("文件不需要重新确认，请刷新。");
    const fresh = await this.manualCandidate(
      scopeBefore.root,
      old.relativePath,
    );
    if (fresh.unsupported)
      throw new Error("文件存在多个硬链接，暂不支持确认。");
    if (super.workspace().scanning)
      throw new Error("扫描正在进行，请稍后重试。");
    const state = this.state(),
      scope = state.scopes.find((s) => s.id === scopeId),
      candidate = scope?.candidates.find((c) => c.id === resourceId);
    if (
      !scope ||
      !candidate ||
      candidate.review !== "stale" ||
      candidate.identity !== old.identity
    )
      throw new Error("文件状态已变化，请刷新。");
    this.ensureMarker();
    candidate.identity = fresh.identity;
    candidate.size = fresh.size;
    candidate.unsupported = false;
    candidate.review = "confirmed";
    candidate.reason = "文件版本已由用户重新确认；原有操作策略继续生效。";
    const policy = scope.policies.find((p) => p.resourceId === resourceId);
    if (policy) {
      policy.revision++;
      policy.activeRevision = policy.revision;
    }
    this.invalidate(state, resourceId);
    this.trials.clear();
    this.event(state, {
      kind: "publication",
      scopeId,
      resourceId,
      title: "重新确认文件版本",
      detail: "保留原规则并创建新修订版，旧授权和试运行失效。",
    });
    this.persist(state);
    this.deploy();
    return this.workspace();
  }
  async trial(scopeId: string, draft: FileDraft, expectedRevision: number) {
    const { candidate } = await this.current(scopeId, draft.resourceId);
    const scope = this.state().scopes.find((s) => s.id === scopeId)!;
    const old = scope.policies.find((p) => p.resourceId === draft.resourceId);
    if ((old?.revision || 0) !== expectedRevision)
      throw new Error("策略已被更新，请刷新并重新试运行。");
    const normalized: FileDraft = {
      resourceId: draft.resourceId,
      enabled: !!draft.enabled,
      read: draft.read,
      write: draft.write,
      delete: draft.delete || "deny",
      disclose: draft.disclose,
    };
    for (const op of FILE_OPERATIONS)
      if (!["allow", "ask", "deny"].includes(normalized[op]!))
        throw new Error("策略决定无效。");
    const proposed = structuredClone(this.state());
    const proposedScope = proposed.scopes.find((s) => s.id === scopeId)!;
    proposedScope.policies = [
      ...proposedScope.policies.filter(
        (p) => p.resourceId !== draft.resourceId,
      ),
      {
        ...normalized,
        revision: expectedRevision + 1,
        activeRevision: expectedRevision + 1,
      },
    ];
    const trial: FileTrial = {
      id: randomUUID(),
      scopeId,
      resourceId: draft.resourceId,
      identity: candidate.identity,
      expectedRevision,
      expiresAt: Date.now() + 5 * 60_000,
      draft: normalized,
      checks: FILE_OPERATIONS.map((operation) => ({
        operation,
        before: this.effective(
          this.state(),
          scopeId,
          draft.resourceId,
          operation,
        ).decision,
        after: this.effective(proposed, scopeId, draft.resourceId, operation)
          .decision,
      })),
    };
    for (const [id, t] of this.trials)
      if (t.expiresAt < Date.now()) this.trials.delete(id);
    if (this.trials.size >= 100) throw new Error("试运行过多，请稍后再试。");
    this.trials.set(trial.id, trial);
    return trial;
  }
  async publish(trialId: string) {
    const trial = this.trials.get(trialId);
    if (!trial || trial.expiresAt < Date.now())
      throw new Error("试运行已失效，请重新检查后发布。");
    await this.current(trial.scopeId, trial.resourceId);
    const state = this.state(),
      scope = state.scopes.find((s) => s.id === trial.scopeId)!;
    const candidate = scope.candidates.find((c) => c.id === trial.resourceId)!;
    const old = scope.policies.find((p) => p.resourceId === trial.resourceId);
    if (
      (old?.revision || 0) !== trial.expectedRevision ||
      candidate.identity !== trial.identity
    )
      throw new Error("文件或策略已更新，请重新试运行。");
    this.ensureMarker(); // Fail before saving if the guard cannot be put in required mode.
    const revision = trial.expectedRevision + 1;
    this.data(state).history.push({
      scopeId: scope.id,
      resourceId: candidate.id,
      previous: old,
      publishedRevision: revision,
    });
    scope.policies = [
      ...scope.policies.filter((p) => p.resourceId !== candidate.id),
      { ...trial.draft, revision, activeRevision: revision },
    ];
    candidate.review = trial.draft.enabled ? "confirmed" : "pending";
    this.invalidate(state, candidate.id);
    this.event(state, {
      kind: "publication",
      scopeId: scope.id,
      resourceId: candidate.id,
      title: "发布文件策略",
      detail: `本地校验器已接收 v${revision}；钩子下发状态独立核验，未声明系统防护。`,
    });
    this.persist(state);
    this.trials.delete(trialId);
    this.deploy();
    return this.workspace();
  }
  private invalidate(state: State, resourceId: string) {
    for (const g of this.data(state).grants) {
      const t = this.data(state).tasks.find((t) => t.id === g.taskId);
      if (t?.resourceId === resourceId && g.status === "active")
        g.status = "invalid";
    }
  }
  async rollback(scopeId: string, resourceId: string, expected: number) {
    await this.current(scopeId, resourceId);
    const state = this.state(),
      data = this.data(state),
      scope = state.scopes.find((s) => s.id === scopeId)!;
    const policy = scope.policies.find((p) => p.resourceId === resourceId);
    if (policy?.revision !== expected)
      throw new Error("策略已更新，请刷新后回滚。");
    const index = data.history
      .map((h) => h.scopeId === scopeId && h.resourceId === resourceId)
      .lastIndexOf(true);
    if (index < 0) throw new Error("没有可恢复的发布记录。");
    const history = data.history[index];
    scope.policies = scope.policies.map((p) =>
      p.resourceId !== resourceId
        ? p
        : {
            ...(history.previous || {
              resourceId,
              read: "deny",
              write: "deny",
              delete: "deny",
              disclose: "deny",
              enabled: false,
            }),
            revision: expected + 1,
            activeRevision: expected + 1,
          },
    );
    data.history.splice(index, 1);
    this.invalidate(state, resourceId);
    scope.candidates.find((c) => c.id === resourceId)!.review = history.previous
      ?.enabled
      ? "confirmed"
      : "pending";
    this.event(state, {
      kind: "rollback",
      scopeId,
      resourceId,
      title: "回滚并创建新版本",
      detail: `已生成 v${expected + 1}；历史任务保留，未撤销已经发生的文件访问。`,
    });
    this.persist(state);
    this.deploy();
    return this.workspace();
  }
  review(scopeId: string, resourceId: string, deferred: boolean) {
    const state = this.state(),
      c = state.scopes
        .find((s) => s.id === scopeId)
        ?.candidates.find((c) => c.id === resourceId);
    if (!c) throw new Error("候选不存在，请刷新。");
    if (c.review === "stale")
      throw new Error("文件版本待重新确认，不能通过暂缓绕过原规则。");
    c.review = deferred ? "deferred" : "pending";
    this.event(state, {
      kind: "discovery",
      scopeId,
      resourceId,
      title: deferred ? "候选暂缓确认" : "重新纳入候选",
      detail: "只变更人工处理状态，不解除现有规则，也不表示文件无风险。",
    });
    this.persist(state);
    return this.workspace();
  }
  async start(
    scopeId: string,
    resourceId: string,
    kind: FileTask["kind"],
  ): Promise<FileTaskResult> {
    const { candidate } = await this.current(scopeId, resourceId);
    const state = this.state(),
      data = this.data(state),
      policy = state.scopes
        .find((s) => s.id === scopeId)!
        .policies.find((p) => p.resourceId === resourceId);
    if (data.tasks.length >= 1000)
      throw new Error("任务容量已满，请先归档记录。");
    const effective = this.effective(state, scopeId, resourceId);
    const decision = effective.decision;
    const task: FileTask = {
      id: randomUUID(),
      scopeId,
      resourceId,
      kind,
      identity: candidate.identity,
      revision: policy?.revision || 0,
      policyFingerprint: effective.fingerprint,
      createdAt: Date.now(),
      status:
        decision === "deny"
          ? "denied"
          : decision === "ask"
            ? "awaiting_approval"
            : "ready",
      detail:
        decision === "deny"
          ? "读取策略禁止（包括重叠范围的更严格规则），本次未打开文件正文。请检查各范围策略，或使用不含秘密的样例材料。"
          : decision === "ask"
            ? "本地文本处理需要单独授权；尚未读取正文，也没有向模型发送。"
            : "规则允许，准备执行本地文本处理。",
    };
    data.tasks.unshift(task);
    this.event(state, {
      kind: "task",
      title: kind === "preview" ? "本地文本预览请求" : "本地脱敏副本请求",
      scopeId,
      resourceId,
      taskId: task.id,
      detail: task.detail,
    });
    this.persist(state);
    if (task.status === "ready") return this.run(task.id);
    return { task };
  }
  async grant(taskId: string, reason: string) {
    if (!reason.trim() || reason.length > 200)
      throw new Error("请填写 1–200 字的授权原因。");
    const task = this.data(this.state()).tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "awaiting_approval")
      throw new Error("这项任务不能授权，请重新发起。");
    await this.current(task.scopeId, task.resourceId);
    const state = this.state(),
      data = this.data(state),
      latest = data.tasks.find((t) => t.id === taskId)!;
    const policy = state.scopes
      .find((s) => s.id === latest.scopeId)
      ?.policies.find((p) => p.resourceId === latest.resourceId);
    if (
      latest.identity !== task.identity ||
      (policy?.revision || 0) !== task.revision ||
      this.effective(state, task.scopeId, task.resourceId).decision !== "ask" ||
      this.effective(state, task.scopeId, task.resourceId).fingerprint !==
        task.policyFingerprint
    )
      throw new Error("策略已变化，请重新发起。");
    for (const g of data.grants)
      if (g.taskId === taskId && g.status === "active") g.status = "revoked";
    data.grants.unshift({
      id: randomUUID(),
      taskId,
      expiresAt: Date.now() + 15 * 60_000,
      status: "active",
      reason: reason.trim(),
    });
    this.event(state, {
      kind: "approval",
      title: "创建单次本地授权",
      scopeId: task.scopeId,
      resourceId: task.resourceId,
      taskId,
      detail:
        "仅该文件版本、该本地任务一次，有效 15 分钟；不能用于 AI 钩子或外发。",
    });
    this.persist(state);
    return this.workspace();
  }
  revoke(grantId: string) {
    const state = this.state(),
      data = this.data(state),
      g = data.grants.find((g) => g.id === grantId);
    if (!g || g.status !== "active") throw new Error("授权已失效或不存在。");
    g.status = "revoked";
    const t = data.tasks.find((t) => t.id === g.taskId)!;
    this.event(state, {
      kind: "approval",
      title: "撤销单次授权",
      scopeId: t.scopeId,
      resourceId: t.resourceId,
      taskId: t.id,
      detail: "原策略不变，后续操作需重新确认。",
    });
    this.persist(state);
    return this.workspace();
  }
  async copyContent(taskId: string, digest: string) {
    const copy = this.copies.get(taskId),
      task = this.data(this.state()).tasks.find((t) => t.id === taskId);
    if (
      !copy ||
      copy.expiresAt < Date.now() ||
      copy.digest !== digest ||
      task?.kind !== "redact" ||
      task.status !== "completed"
    )
      throw new Error("副本预览已失效，请重新生成。");
    const { scope } = await this.current(task.scopeId, task.resourceId);
    if (
      (scope.policies.find((p) => p.resourceId === task.resourceId)?.revision ||
        0) !== task.revision ||
      this.effective(this.state(), task.scopeId, task.resourceId)
        .fingerprint !== task.policyFingerprint
    )
      throw new Error("策略已变化，请重新生成副本。");
    return copy.content;
  }
  async run(taskId: string): Promise<FileTaskResult> {
    if (this.running.has(taskId))
      throw new Error("此任务正在执行，请勿重复提交。");
    this.running.add(taskId);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      let state = this.state(),
        data = this.data(state),
        t = data.tasks.find((t) => t.id === taskId);
      if (!t || !["ready", "awaiting_approval"].includes(t.status))
        throw new Error("任务已执行或失效，请重新发起。");
      const { scope, candidate } = await this.current(t.scopeId, t.resourceId);
      state = this.state();
      data = this.data(state);
      t = data.tasks.find((t) => t.id === taskId)!;
      const policy = state.scopes
        .find((s) => s.id === t.scopeId)
        ?.policies.find((p) => p.resourceId === t.resourceId);
      const effective = this.effective(state, t.scopeId, t.resourceId);
      const decision = effective.decision;
      if (
        t.identity !== candidate.identity ||
        (policy?.revision || 0) !== t.revision ||
        effective.fingerprint !== t.policyFingerprint ||
        decision === "deny"
      )
        throw new Error("文件或策略已变化，本次未执行。");
      const grant = data.grants.find(
        (g) =>
          g.taskId === taskId &&
          g.status === "active" &&
          g.expiresAt > Date.now(),
      );
      if (decision === "ask" && !grant)
        throw new Error("需要有效的单次授权；到期或已使用的许可不可重用。");
      if (grant) grant.status = "used";
      t.status = "running";
      t.detail = "已消费本次许可，开始本地读取；不向模型发送。";
      this.persist(state); // Reserve before async I/O, with a durable single-use claim.
      handle = await fs.open(
        path.join(scope.root, candidate.relativePath),
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        identity(before) !== t.identity
      )
        throw new Error("打开的对象与批准文件不一致。");
      if (before.size > 256 * 1024)
        throw new Error(
          "本地处理仅支持 256 KiB 以内的 UTF-8 文本；原件未修改。",
        );
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await handle.read(
          bytes,
          count,
          bytes.length - count,
          count,
        );
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (identity(await handle.stat()) !== t.identity || count !== before.size)
        throw new Error("读取过程中内容发生变化，请重新扫描确认。");
      await this.current(t.scopeId, t.resourceId);
      state = this.state();
      data = this.data(state);
      const latest = data.tasks.find((task) => task.id === taskId)!;
      const latestPolicy = state.scopes
        .find((s) => s.id === t!.scopeId)
        ?.policies.find((p) => p.resourceId === t!.resourceId);
      if (
        (latestPolicy?.revision || 0) !== t.revision ||
        this.effective(state, t.scopeId, t.resourceId).fingerprint !==
          t.policyFingerprint
      )
        throw new Error("读取期间策略发生变化，结果已丢弃。");
      let text: string;
      try {
        if (bytes.subarray(0, count).includes(0)) throw new Error();
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, count),
        );
      } catch {
        throw new Error(
          "此格式不是支持的 UTF-8 文本；Word、Excel、PDF 解析尚未接入。",
        );
      }
      const output =
        t.kind === "redact" ? redactLocalText(text) : { content: text };
      latest.status = "completed";
      latest.bytes = count;
      latest.detail =
        t.kind === "redact"
          ? "本地副本已生成，原件未改动；规则可能漏检，请审阅保留的字段。没有向模型发送。"
          : "已取得本地读取回执；内容仅返回预览，不写入审计或发送给模型。";
      this.event(state, {
        kind: "task",
        title: "本地处理完成",
        scopeId: t.scopeId,
        resourceId: t.resourceId,
        taskId,
        detail: latest.detail,
      });
      this.persist(state);
      const digest = hash(output.content);
      if (t.kind === "redact") {
        for (const [id, c] of this.copies)
          if (c.expiresAt < Date.now()) this.copies.delete(id);
        if (this.copies.size >= 20)
          this.copies.delete(this.copies.keys().next().value!);
        this.copies.set(taskId, {
          content: output.content,
          digest,
          expiresAt: Date.now() + 5 * 60_000,
        });
      }
      return { task: latest, ...output, digest };
    } catch (error) {
      const state = this.state(),
        t = this.data(state).tasks.find((t) => t.id === taskId);
      if (!t) throw error;
      if (!["completed", "failed", "denied", "stale"].includes(t.status)) {
        t.status = "failed";
        t.detail = (error as Error).message;
        this.invalidate(state, t.resourceId);
        this.event(state, {
          kind: "task",
          title: "任务未完成",
          scopeId: t.scopeId,
          resourceId: t.resourceId,
          taskId,
          detail: t.detail,
        });
        this.persist(state);
      }
      return { task: t };
    } finally {
      await handle?.close();
      this.running.delete(taskId);
    }
  }
}
