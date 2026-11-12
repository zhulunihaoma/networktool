import { useEffect, useState } from "react";
import Modal from "./Modal";
import type {
  InventoryDiff,
  McpCheckReport,
  SecurityAPI,
  SecurityPolicy,
} from "./shared/security";
import { RULES, RULE_TITLES, TOOL_NAMES } from "./shared/security";
const list = (text: string) =>
  text
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
type Props = {
  service: SecurityAPI;
  notify: (message: string, error?: boolean) => void;
};
type ProtectionListProps = {
  title: string;
  label: string;
  tone: "sensitive" | "branch" | "path" | "command";
  values: string[];
  hint: string;
  controls: { title: string; enabled: boolean }[];
  placeholder?: string;
  disabled: boolean;
  onChange: (values: string[]) => void;
};
function ProtectionList({
  title,
  label,
  tone,
  values,
  hint,
  controls,
  placeholder,
  disabled,
  onChange,
}: ProtectionListProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(values.join(", "));
  useEffect(() => {
    if (!editing) setText(values.join(", "));
  }, [values, editing]);
  return (
    <section
      className={`protection-list protection-list-${tone}`}
      aria-label={title}
    >
      <div className="security-title">
        <h4>
          {title}
          <span className="protection-count">{values.length} 项</span>
        </h4>
        <button
          type="button"
          className="link-button"
          disabled={disabled}
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "收起编辑" : "编辑清单"}
        </button>
      </div>
      <p className="protection-hint">{hint}</p>
      <div className="protection-tokens" aria-label={`${title}清单`}>
        {values.map((value, i) => (
          <code
            key={`${value}-${i}`}
            className={`protection-token token-${tone}`}
          >
            {value}
          </code>
        ))}
        {!values.length && (
          <span className="protection-empty">
            尚未添加
            {title === "额外拦截命令"
              ? "额外命令，内置高危命令规则仍由下方开关控制"
              : "保护项"}
          </span>
        )}
      </div>
      <div className="protection-controls">
        {controls.map((control) => (
          <span
            key={control.title}
            className={control.enabled ? "control-on" : "control-off"}
          >
            {control.title}：{control.enabled ? "已开启" : "已关闭，不拦截"}
          </span>
        ))}
      </div>
      {editing && (
        <label className="security-field">
          {label}
          <textarea
            rows={tone === "sensitive" ? 5 : 3}
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              onChange(list(e.target.value));
            }}
          />
        </label>
      )}
    </section>
  );
}
export function PolicyEditor({
  service,
  policy,
  notify,
  saved,
}: Props & { policy: SecurityPolicy; saved: () => Promise<void> }) {
  const [draft, setDraft] = useState(policy),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(policy);
  }, [policy, dirty]);
  const edit = (next: SecurityPolicy) => {
    setDraft(next);
    setDirty(true);
  };
  const execute = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const enabled = (id: string) =>
    draft.rules.some((r) => r.id === id && r.enabled);
  const addProject = () =>
    execute(async () => {
      const root = await service.securityChooseProject();
      if (root && !(draft.projects ?? []).some((p) => p.root === root))
        edit({
          ...draft,
          projects: [
            ...(draft.projects ?? []),
            { root, enabled: true, protectedBranches: [], protectedPaths: [] },
          ],
        });
    });
  return (
    <div className="panel security-box">
      <div className="security-title">
        <div>
          <h2>项目与防护规则</h2>
          <p>管理全局保护清单、规则开关与项目的额外保护。</p>
        </div>
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() =>
            execute(async () => {
              await service.securitySavePolicy(draft);
              setDirty(false);
              await saved();
              notify("防护规则已保存");
            })
          }
        >
          保存防护规则
        </button>
      </div>
      {dirty && <p role="status">有未保存的修改，请保存后再离开此页。</p>}
      <section
        className="protection-focus"
        aria-labelledby="protection-focus-title"
      >
        <div className="security-title">
          <h3 id="protection-focus-title">重点保护清单</h3>
          <span className={`protection-draft${dirty ? " is-dirty" : ""}`}>
            {dirty ? "预览未保存的修改" : "已保存的配置"}
          </span>
        </div>
        <p>
          优先保护凭据、发布分支和关键配置。下列清单用于所有已接入防护的工具，点击“编辑清单”可调整。
        </p>
        <div className="protection-grid">
          <ProtectionList
            title="敏感文件与后缀"
            tone="sensitive"
            values={draft.sensitivePaths}
            label="额外保护的敏感文件（逗号或换行分隔，支持 ~ 与 * 通配）"
            hint="命中这些文件名、后缀或目录时，分别按读取与改写开关拦截；* 匹配单层名称。"
            controls={[
              { title: "读取保护", enabled: enabled("credential_read") },
              { title: "改写保护", enabled: enabled("credential_write") },
            ]}
            placeholder="例如：~/secrets/*, deploy/.env.prod"
            disabled={busy}
            onChange={(sensitivePaths) => edit({ ...draft, sensitivePaths })}
          />
          <ProtectionList
            title="全局保护分支"
            tone="branch"
            values={draft.protectedBranches}
            label="全局保护分支（逗号或换行分隔）"
            hint="拦截直接推送到这些分支；release/* 表示该前缀下的发布分支。"
            controls={[
              { title: "发布分支保护", enabled: enabled("protected_branch") },
            ]}
            disabled={busy}
            onChange={(protectedBranches) =>
              edit({ ...draft, protectedBranches })
            }
          />
          <ProtectionList
            title="全局保护路径"
            tone="path"
            values={draft.writeProtectedPaths}
            label="全局保护路径（逗号或换行分隔）"
            hint="拦截对这些文件、目录及其子文件的改写。"
            controls={[
              {
                title: "Git 钩子与配置保护",
                enabled: enabled("protected_path_write"),
              },
            ]}
            disabled={busy}
            onChange={(writeProtectedPaths) =>
              edit({ ...draft, writeProtectedPaths })
            }
          />
          <ProtectionList
            title="额外拦截命令"
            tone="command"
            values={draft.blockedCommands}
            label="额外拦截的命令（逗号或换行分隔，按开头匹配）"
            hint="按每段命令的开头匹配，不区分大小写；复合命令会分段检查。"
            controls={[
              { title: "高危命令拦截", enabled: enabled("destructive") },
            ]}
            placeholder="例如：terraform apply, aws s3 rm"
            disabled={busy}
            onChange={(blockedCommands) => edit({ ...draft, blockedCommands })}
          />
        </div>
        <p className="protection-effect-note">
          <b>何时生效：</b>
          保存后，已加载防护钩子的工具会在下一次操作时读取新规则。首次接入或修复后需重开工具会话，Codex
          还需完成信任；关闭的规则或下方项目例外不会拦截。可到“防护与规则 → 防护开关”自检，并在“事件分析 → 事件列表”查看真实运行记录。
        </p>
      </section>
      <h3 className="protection-switch-title">规则开关</h3>
      {RULES.map((r) => (
        <label className="security-row" key={r.id}>
          <div>
            <b>{r.title}</b>
            <p>{r.detail}</p>
          </div>
          <input
            type="checkbox"
            aria-label={r.title}
            checked={draft.rules.find((x) => x.id === r.id)?.enabled ?? false}
            disabled={busy}
            onChange={(e) =>
              edit({
                ...draft,
                rules: draft.rules.map((x) =>
                  x.id === r.id ? { ...x, enabled: e.target.checked } : x,
                ),
              })
            }
          />
        </label>
      ))}
      <h3>指定项目</h3>
      <p>
        这里添加项目相对路径，例如 deploy/release.yml。文件保护由“保护 Git
        钩子与配置”开关控制；它也覆盖下方自定义路径。
      </p>
      {(draft.projects ?? []).map((p, i) => {
        const update = (patch: Partial<typeof p>) =>
          edit({
            ...draft,
            projects: draft.projects!.map((v, j) =>
              i === j ? { ...v, ...patch } : v,
            ),
          });
        return (
          <section className="security-project" key={p.root}>
            <div className="security-title">
              <b>{p.root}</b>
              <button
                className="secondary"
                onClick={() =>
                  edit({
                    ...draft,
                    projects: draft.projects!.filter((_, j) => j !== i),
                  })
                }
              >
                移除项目
              </button>
            </div>
            <label>
              <input
                type="checkbox"
                checked={p.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />{" "}
              启用此项目的额外保护
            </label>
            <label className="security-field">
              额外保护分支
              <input
                value={p.protectedBranches.join(", ")}
                onChange={(e) =>
                  update({ protectedBranches: list(e.target.value) })
                }
              />
            </label>
            <label className="security-field">
              保护文件或目录（项目相对路径）
              <input
                value={p.protectedPaths.join(", ")}
                onChange={(e) =>
                  update({ protectedPaths: list(e.target.value) })
                }
              />
            </label>
          </section>
        );
      })}
      <button className="secondary" disabled={busy} onClick={addProject}>
        添加保护项目
      </button>
      {!!policy.exceptions?.length && (
        <>
          <h3>已设置的项目例外</h3>
          {policy.exceptions.map((e) => (
            <div className="security-row" key={e.project + e.ruleId}>
              <span>
                {e.project} · {RULE_TITLES[e.ruleId] ?? e.ruleId}
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  execute(async () => {
                    await service.securityRemoveException(e.ruleId, e.project);
                    await saved();
                    notify("例外已移除");
                  })
                }
              >
                恢复拦截
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
export function InstallationCheck({ service, notify }: Props) {
  const [text, setText] = useState(""),
    [report, setReport] = useState<McpCheckReport>(),
    [busy, setBusy] = useState(false);
  return (
    <div className="panel security-box">
      <h2>MCP 安装前检查</h2>
      <p>
        粘贴将要导入的 JSON / JSONC
        配置，查看启动命令、外部地址及风险。检查不会安装或执行 MCP。Skill
        复制检查请使用左侧 Skill 中心。
      </p>
      <label className="security-field">
        MCP 配置
        <textarea
          rows={10}
          value={text}
          placeholder={
            '{ "mcpServers": { "example": { "command": "npx", "args": ["server@1.0.0"] } } }'
          }
          onChange={(e) => {
            setText(e.target.value);
            setReport(undefined);
          }}
        />
      </label>
      <button
        className="primary"
        disabled={busy || !text.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            setReport(await service.securityCheckMcp(text));
          } catch (e) {
            notify(String(e), true);
          } finally {
            setBusy(false);
          }
        }}
      >
        检查 MCP 配置
      </button>
      {report && (
        <>
          <h3>
            {report.level === "high"
              ? "发现高风险启动行为，建议先处理"
              : report.findings.length
                ? "发现需要注意的配置"
                : "未命中当前检查规则"}
          </h3>
          {report.servers.map((s) => (
            <div className="security-project" key={s.name}>
              <b>{s.name}</b>
              <p>{s.command}</p>
              <p>{s.url}</p>
            </div>
          ))}
          {report.findings.map((f, i) => (
            <div className="security-row" key={i}>
              <div>
                <b>{f.title}</b>
                <p>{f.detail}</p>
              </div>
            </div>
          ))}
          <details>
            <summary>查看脱敏后的配置</summary>
            <pre className="security-code">{report.redactedConfig}</pre>
          </details>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await service.securityCopyMcp(text);
                notify("脱敏配置已复制，请自行补充环境变量后导入工具");
              } catch (e) {
                notify(String(e), true);
              }
            }}
          >
            复制脱敏配置
          </button>
        </>
      )}
    </div>
  );
}
export function InventoryPanel({
  service,
  notify,
  lastResult,
  saved,
}: Props & {
  lastResult?: InventoryDiff;
  saved: () => Promise<void>;
}) {
  const [localResult, setResult] = useState<InventoryDiff>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmBaseline, setConfirmBaseline] = useState(false),
    [tool, setTool] = useState("all");
  const result = localResult ?? lastResult;
  const changes = result
    ? result.added.length + result.changed.length + result.removed.length
    : 0;
  const tools = [
    ...new Set(
      result
        ? [...result.added, ...result.changed, ...result.removed].map(
            (item) => item.tool,
          )
        : [],
    ),
  ];
  const kinds = {
    mcp: "MCP 服务",
    plugin: "插件",
    endpoint: "模型接口地址",
    config: "配置文件",
  };
  const check = async (reset = false) => {
    setBusy(true);
    setError("");
    try {
      const r = await service.securityInventory(reset);
      setResult(r);
      setTool("all");
      setConfirmBaseline(false);
      notify(
        reset
          ? "已将当前配置设为基线"
          : !result
            ? "首次检查完成，已建立配置基线"
            : "巡检完成",
      );
      void saved().catch(() => {});
    } catch (e) {
      setConfirmBaseline(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel security-box inventory-panel">
      <h2>配置变更巡检</h2>
      <p className="inventory-intro">
        发现 AI
        工具的配置有没有发生意料之外的变化，帮助你核对新增服务、插件和模型接口。
      </p>
      <div className="inventory-examples" aria-label="能发现哪些变化">
        <div>
          <b>MCP 服务变化</b>
          <span>多了陌生服务，或启动命令、连接地址被改动</span>
        </div>
        <div>
          <b>插件与模型入口变化</b>
          <span>新增了插件，或模型接口换成了陌生地址</span>
        </div>
        <div>
          <b>配置文件变化</b>
          <span>文件内容发生变化，提示你回到源文件核对</span>
        </div>
      </div>
      <ol className="inventory-steps" aria-label="使用步骤">
        <li>
          <b>1. 建立基线</b>
          <span>首次检查保存当前配置，作为之后比较的参照。</span>
        </li>
        <li>
          <b>2. 检查变化</b>
          <span>安装插件、导入 MCP 或修改配置后，点击检查。</span>
        </li>
        <li>
          <b>3. 核对后更新</b>
          <span>确认变化符合预期，再设为新基线。</span>
        </li>
      </ol>
      <p className="inventory-scope">
        检查本机已支持的 AI
        工具用户配置，仅在点击时读取。发现变化后由你核对，不会自动修改或恢复工具配置；配置变化也不代表已经发生数据外发。
      </p>
      <div className="inventory-toolbar">
        <div>
          <b>{!result ? "还没有配置基线" : "已保存配置基线"}</b>
          <p>
            {result
              ? `基线：${result.baselineAt ? new Date(result.baselineAt).toLocaleString() : "未知"} · 上次检查：${new Date(result.checkedAt).toLocaleString()} · 当前清单 ${result.total} 项`
              : "第一次检查会保存参照配置，后续检查才会显示差异。"}
          </p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => check(false)}
        >
          {busy
            ? "正在读取并对比配置…"
            : error
              ? "重试检查"
              : result
                ? "检查配置变化"
                : "建立配置基线"}
        </button>
      </div>
      {error && (
        <div className="inventory-error" role="alert">
          <b>检查未完成</b>
          <p>{error}</p>
          <p>
            已有基线保持不变。请检查配置格式或文件读取权限后重试。
            {result && "下方保留上次成功检查的结果。"}
          </p>
        </div>
      )}
      {result && (
        <div className="inventory-results" aria-busy={busy}>
          <div
            className={`inventory-summary ${changes ? "has-changes" : ""}`}
            role="status"
          >
            <b>
              {changes
                ? `有 ${changes} 项配置变化待核对`
                : result.total
                  ? "与基线相比，未发现配置变化"
                  : "未读取到受支持的配置项"}
            </b>
            <p>
              {changes
                ? `新增 ${result.added.length} 项 · 变更 ${result.changed.length} 项 · 移除 ${result.removed.length} 项。请先核对下方条目，陌生变化可按来源路径检查原配置。`
                : result.total
                  ? "安装插件、导入 MCP 或修改模型接口后，可再次检查；没有变化时无需更新基线。"
                  : "当前清单为空。若已安装 AI 工具，请确认它使用的是受支持的用户配置路径，再重新检查。"}
            </p>
          </div>
          {changes > 0 && (
            <>
              <div className="inventory-review-bar">
                <label>
                  筛选工具{" "}
                  <select
                    value={tool}
                    disabled={busy}
                    onChange={(e) => setTool(e.target.value)}
                  >
                    <option value="all">全部工具</option>
                    {tools.map((t) => (
                      <option value={t} key={t}>
                        {TOOL_NAMES[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <span>同一文件及其中的 MCP 等配置项会分别计数。</span>
              </div>
              {(
                [
                  ["新增", result.added],
                  ["变更", result.changed],
                  ["移除", result.removed],
                ] as const
              ).map(([label, rows]) => (
                <details className="inventory-group" key={label} open>
                  <summary>
                    {label}{" "}
                    {
                      rows.filter((r) => tool === "all" || r.tool === tool)
                        .length
                    }{" "}
                    项
                  </summary>
                  {rows.filter((r) => tool === "all" || r.tool === tool)
                    .length === 0 && (
                    <p className="inventory-group-empty">
                      {tool === "all" ? "没有此类变化" : "此工具没有此类变化"}
                    </p>
                  )}
                  {rows
                    .filter((r) => tool === "all" || r.tool === tool)
                    .map((r) => (
                      <div className="security-row inventory-item" key={r.id}>
                        <div>
                          <b>
                            {TOOL_NAMES[r.tool]} · {r.name}
                          </b>
                          <span className="inventory-kind">
                            {kinds[r.kind]}
                          </span>
                          {r.kind === "config" ? (
                            <>
                              <p>
                                配置文件
                                {label === "变更"
                                  ? "内容已变化，请核对源文件"
                                  : label === "新增"
                                    ? "已新增"
                                    : "已移除"}
                                。
                              </p>
                              <details>
                                <summary>查看文件摘要</summary>
                                <code>{r.target}</code>
                              </details>
                            </>
                          ) : (
                            <p className="inventory-target">{r.target}</p>
                          )}
                          <small>
                            来源：<code>~/{r.source}</code>
                            {label === "移除" ? "（基线中记录的配置）" : ""}
                          </small>
                        </div>
                      </div>
                    ))}
                </details>
              ))}
              <div className="inventory-baseline-action">
                <div>
                  <b>这些变化都符合你的预期？</b>
                  <p>
                    确认后更新比较基准，本次差异将不再显示。若有陌生变化，先核对并处理原配置，再重新检查。
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={busy || !!error}
                  onClick={() => setConfirmBaseline(true)}
                >
                  将当前配置设为新基线
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {confirmBaseline && (
        <Modal
          title="确认更新配置基线？"
          onClose={() => {
            if (!busy) setConfirmBaseline(false);
          }}
        >
          <div className="modal-body">
            <p>
              将重新读取当前配置，替换之前保存的比较基准；之前的差异将不再显示。此操作只更新巡检记录，不修改
              AI 工具配置。
            </p>
            <p>
              请确认所有变化均符合预期。如果配置在检查后又被修改，新基线也会包含这些修改。
            </p>
          </div>
          <footer className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmBaseline(false)}
            >
              继续核对
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => check(true)}
            >
              {busy ? "正在更新…" : "确认更新基线"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
