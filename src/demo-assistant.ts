import {
  type AssistantAPI,
  type FileWorkspace,
  type AuditEvent,
  type ToolInventory,
} from "./shared/assistant";
export function createDemoAssistant(): AssistantAPI {
  const inventory: ToolInventory = {
    scanning: false,
    checkedAt: Date.now(),
    limitations: ["演示数据；没有扫描本机应用，也不具备原生文件采集能力。"],
    installs: [
      {
        id: crypto.randomUUID(),
        productId: "cursor",
        name: "Cursor",
        location: "演示位置 /Applications/Cursor.app",
        version: "示例版本",
        identityStatus: "installed_confirmed",
        pinned: false,
        processKeys: [],
        lastSeen: Date.now(),
        sources: ["演示应用元数据"],
        components: [
          {
            id: crypto.randomUUID(),
            name: "Cursor 宿主（演示）",
            role: "host",
            runtime: "local",
            adapterStatus: "unknown",
            features: ["登录", "模型调用", "MCP"].map((name) => ({
              name,
              status: "not_tested",
              targetSource: "示例",
            })),
          },
        ],
      },
    ],
  };
  const workspace: FileWorkspace = {
    scanning: false,
    scopes: [],
    alerts: [],
    coverage: {
      mode: "policy_validation_only",
      ruleEnabled: false,
      eventCollection: "assistant_only",
      canBlockToolAccess: false,
      gaps: ["演示模式；没有实际工具访问事件或阻断能力。"],
    },
  };
  const events: AuditEvent[] = [];
  const record = (event: Omit<AuditEvent, "id" | "seq" | "time">) => {
    const next = {
      ...event,
      id: crypto.randomUUID(),
      seq: events.length + 1,
      time: Date.now(),
    };
    events.push(next);
    return next;
  };
  const copy = <T>(value: T): T => structuredClone(value);
  return {
    tools: async () => copy(inventory),
    discoverTools: async () => copy(inventory),
    checkToolUpdates: async () => {
      inventory.installs.forEach((t) => {
        t.update = { status: "unknown", message: "演示模式不查询真实发布源。" };
      });
      return copy(inventory);
    },
    pinTool: async (id, pinned) => {
      const tool = inventory.installs.find((t) => t.id === id);
      if (!tool) throw new Error("示例工具不存在");
      tool.pinned = pinned;
      return copy(inventory);
    },
    chooseToolPath: async () => copy(inventory),
    fileWorkspace: async () => copy(workspace),
    chooseFileScope: async () => {
      if (!workspace.scopes.length) {
        const scopeId = crypto.randomUUID();
        workspace.scopes.push({
          id: scopeId,
          name: "演示项目（非本机扫描）",
          scannedAt: Date.now(),
          examined: 32,
          skipped: 2,
          truncated: false,
          warnings: ["以下为示例候选；未枚举你的文件。"],
          policies: [],
          candidates: [".env", "certs/private.key", "data/customer.sql"].map(
            (relativePath) => ({
              id: crypto.randomUUID(),
              relativePath,
              size: 128,
              identity: "demo",
              reason: "名称与类型候选（演示）",
              unsupported: false,
            }),
          ),
        });
        record({
          scopeId,
          operation: "enumerate",
          source: "scanner_actor",
          result: "metadata_only",
          detail: "演示：元数据枚举示例，没有读取本机文件。",
        });
      }
      return copy(workspace);
    },
    cancelFileScan: async () => {},
    rescanFileScope: async () => copy(workspace),
    chooseSensitiveFile: async () => copy(workspace),
    saveFilePolicy: async (scopeId, input, expected) => {
      const scope = workspace.scopes.find((s) => s.id === scopeId);
      if (!scope) throw new Error("示例范围不存在");
      const old = scope.policies.find((p) => p.resourceId === input.resourceId);
      if ((old?.revision || 0) !== expected)
        throw new Error("策略已更新，请刷新。");
      scope.policies = [
        ...scope.policies.filter((p) => p.resourceId !== input.resourceId),
        { ...input, revision: expected + 1, activeRevision: expected + 1 },
      ];
      workspace.coverage.ruleEnabled = workspace.scopes.some((s) =>
        s.policies.some((p) => p.enabled),
      );
      record({
        scopeId,
        resourceId: input.resourceId,
        operation: "policy_update",
        source: "user_policy",
        result: "policy_saved",
        detail: "演示策略已保存，刷新页面会清空。",
      });
      return copy(workspace);
    },
    evaluateFilePolicy: async (scopeId, resourceId, operation) => {
      const scope = workspace.scopes.find((s) => s.id === scopeId);
      if (!scope?.candidates.some((c) => c.id === resourceId))
        throw new Error("示例文件不存在");
      const policy = scope.policies.find((p) => p.resourceId === resourceId),
        decision = policy?.enabled ? policy[operation] : "ask";
      const event = record({
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
        detail: "演示策略自检；未读改或发送文件。",
        policyRevision: policy?.revision,
      });
      if (decision === "deny")
        workspace.alerts.push({
          id: crypto.randomUUID(),
          ruleId:
            operation === "read"
              ? "F01"
              : operation === "write"
                ? "F03"
                : "F05",
          scopeId,
          resourceId,
          operation,
          state: "open",
          first: event.time,
          last: event.time,
          count: 1,
          evidenceIds: [event.id],
        });
      return { decision, workspace: copy(workspace) };
    },
    auditEvents: async (filter) => {
      const all = events
        .filter(
          (e) =>
            (!filter.scopeId || e.scopeId === filter.scopeId) &&
            (!filter.operation || e.operation === filter.operation) &&
            (!filter.cursor || e.seq < filter.cursor),
        )
        .reverse();
      return {
        events: copy(all.slice(0, 100)),
        nextCursor: all.length > 100 ? all[99].seq : undefined,
      };
    },
    acknowledgeFileAlert: async (id) => {
      const alert = workspace.alerts.find((a) => a.id === id);
      if (!alert) throw new Error("示例提醒不存在");
      alert.state = "acknowledged";
      return copy(workspace);
    },
    previewFileAudit: async (_id, format) => ({
      format,
      digest: "demo-only",
      content:
        format === "json"
          ? JSON.stringify(
              {
                mode: "demo",
                events: events.map((e) => ({
                  seq: e.seq,
                  operation: e.operation,
                  result: e.result,
                  source: e.source,
                })),
              },
              null,
              2,
            )
          : "# 文件审计演示\n\n仅示例事件；没有本机文件或第三方工具访问证据。",
    }),
    exportFileAudit: async () => {
      throw new Error("演示模式不保存真实审计报告，请在桌面应用使用原生保存。");
    },
  };
}
