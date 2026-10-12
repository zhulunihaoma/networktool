import { useEffect, useState } from "react";
import {
  ChevronRight,
  Cpu,
  Info,
  Loader2,
  Pin,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { DesktopAPI, PlatformResult, PlatformScan } from "./shared/types";
import {
  IDENTITY_LABELS,
  TOOL_PRODUCTS,
  FEATURE_LABELS,
  installed,
  sortTools,
  UPDATE_LABELS,
  type ToolUpdate,
  type ToolInventory,
  type ToolInstall,
  type ToolFeature,
} from "./shared/assistant";
import { guidanceFor, repairEligibility } from "./shared/adapters";
import Modal from "./Modal";
import { PLATFORM_LABELS } from "./shared/platforms";
const TOOL_PUBLIC_ENTRY: Record<string, string> = {
  codex: "codex",
  "claude-desktop": "claude",
  cursor: "cursor",
  "deepseek-harness": "deepseek",
};
export default function InstalledTools({
  api,
  onError,
  onFiles,
  onDiagnose,
  onProviders,
  platformScan,
  onCheckPlatform,
}: {
  api: DesktopAPI;
  onError: (message: string) => void;
  onFiles: () => void;
  onProviders: (tool: ToolInstall) => void;
  onDiagnose: (
    tool: ToolInstall,
    componentId: string,
    feature: ToolFeature,
  ) => void;
  platformScan?: PlatformScan;
  onCheckPlatform: (platformId: string) => void;
}) {
  const [inventory, setInventory] = useState<ToolInventory>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState("installed");
  const [selected, setSelected] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState("network");
  const [manualProduct, setManualProduct] = useState("codex");
  const [feature, setFeature] = useState<ToolFeature>("model");
  const [componentId, setComponentId] = useState("");
  const refresh = async () => {
    setBusy(true);
    try {
      setInventory(await api.discoverTools());
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api
      .tools()
      .then((value) => {
        if (!active) return;
        setInventory(value);
        return value.checkingUpdates ? value : api.discoverTools();
      })
      .then((value) => {
        if (active && value) setInventory(value);
      })
      .catch((error) => {
        if (active) onError(error.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (!inventory?.scanning && !inventory?.checkingUpdates) return;
    let active = true;
    const timer = setInterval(() => {
      void api
        .tools()
        .then((value) => {
          if (active) setInventory(value);
        })
        .catch((error) => {
          if (active) onError(error.message);
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, inventory?.scanning, inventory?.checkingUpdates]);
  const all = sortTools(inventory?.installs || []);
  const tools =
    filter === "installed"
      ? all.filter(installed)
      : filter === "updates"
        ? all.filter((t) => installed(t) && hasUpdate(t))
        : all;
  const checkUpdates = async (id?: string) => {
    setChecking(true);
    try {
      setInventory(await api.checkToolUpdates(id));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const blocked =
    busy || checking || !!inventory?.scanning || !!inventory?.checkingUpdates;
  const updateCount = all.filter((t) => installed(t) && hasUpdate(t)).length;
  const candidateCount = all.filter(
    (t) => t.identityStatus === "candidate",
  ).length;
  const detail = all.find((tool) => tool.id === selected);
  const guidance = detail ? guidanceFor(detail.productId) : undefined;
  const installedCount = all.filter(installed).length;
  return (
    <section className="installed-tools panel" aria-label="本机工具">
      <div className="section-heading">
        <div>
          <h2>本机工具</h2>
          <p>
            {busy
              ? "正在核验已知安装位置…"
              : `已确认 ${installedCount} 个安装记录 · ${candidateCount} 个待确认 · ${updateCount} 个有新版本`}
          </p>
        </div>
        <div className="tool-actions">
          <button
            className="secondary"
            disabled={blocked || !installedCount}
            onClick={() => void checkUpdates()}
          >
            {checking ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}{" "}
            {checking ? "正在查询更新…" : "检查更新"}
          </button>
          <button
            className="secondary"
            disabled={blocked}
            onClick={() => void refresh()}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <RefreshCw size={15} />
            )}
            刷新识别
          </button>
        </div>
      </div>
      <div className="segmented" aria-label="工具安装筛选">
        {[
          ["installed", "已安装"],
          ["all", "全部工具与候选"],
          ["updates", `有新版本 (${updateCount})`],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            className={filter === id ? "active" : ""}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="tool-discovery-note">
        无需打开工具即可识别安装。刷新识别只读取本机安装元数据；检查更新联网查询公开发布版本，最多等待
        45 秒，不会安装更新。
      </p>
      {blocked && (
        <p className="field-help" role="status">
          {inventory?.checkingUpdates || checking
            ? "正在查询版本更新，完成后可刷新识别或置顶；不会安装更新。"
            : "正在读取安装记录，完成后可刷新识别或置顶。"}
        </p>
      )}
      <div className="installed-grid">
        {tools.map((tool) => (
          <article
            key={tool.id}
            className={`installed-card ${detail?.id === tool.id ? "selected" : ""}`}
            onClick={(event) => {
              if (
                !(event.target as HTMLElement).closest(
                  "button, a, input, select",
                )
              ) {
                setSelected(tool.id);
                setDrawerOpen(true);
                setTab("network");
                setComponentId(tool.components[0]?.id || "");
              }
            }}
          >
            <div className="section-heading">
              <h3>
                <button
                  className="tool-card-select"
                  aria-label={`选择${tool.name}`}
                  aria-pressed={selected === tool.id}
                  onClick={() => {
                    setSelected(tool.id);
                    setDrawerOpen(true);
                    setTab("network");
                    setComponentId(tool.components[0]?.id || "");
                  }}
                >
                  <Cpu size={17} />
                  {tool.name}
                </button>
              </h3>
              <button
                className={`icon-button ${tool.pinned ? "pinned" : ""}`}
                aria-label={`${tool.pinned ? "取消置顶" : "置顶"}${tool.name}`}
                aria-pressed={tool.pinned}
                disabled={blocked}
                onClick={async () => {
                  try {
                    setInventory(await api.pinTool(tool.id, !tool.pinned));
                  } catch (error) {
                    onError((error as Error).message);
                  }
                }}
              >
                <Pin size={15} />
              </button>
            </div>
            <span className={`badge ${installed(tool) ? "blue" : "amber"}`}>
              {IDENTITY_LABELS[tool.identityStatus]}
            </span>
            <p>
              版本 {tool.version || "未知"} ·{" "}
              {tool.components[0]?.role === "cli" ? "CLI" : "桌面宿主"}
            </p>
            <p className="muted">
              {tool.identityStatus === "running_confirmed"
                ? "进程实例与已知镜像路径一致"
                : tool.processKeys.length
                  ? "有运行候选，工具身份或镜像未完成核验"
                  : installed(tool)
                    ? "已安装 · 未确认正在运行"
                    : "当前运行实例未确认"}
            </p>
            <NetworkAvailability
              tool={tool}
              result={platformScan?.results.find(
                (result) =>
                  result.platformId === TOOL_PUBLIC_ENTRY[tool.productId],
              )}
              onCheck={() => {
                const platformId = TOOL_PUBLIC_ENTRY[tool.productId];
                if (platformId) onCheckPlatform(platformId);
                else {
                  setSelected(tool.id);
                  setTab("network");
                  setComponentId(tool.components[0]?.id || "");
                  setDrawerOpen(true);
                }
              }}
            />
            <p className="muted">{installationLabel(tool)}</p>
            {tool.components.some((c) => c.role === "extension") && (
              <p className="muted">
                {tool.components.filter((c) => c.role === "extension").length}{" "}
                条 Agent 扩展版本记录 · 启用状态未确认
              </p>
            )}
            {tool.components.some((c) => c.update?.status === "available") && (
              <p className="badge amber">
                {
                  tool.components.filter(
                    (c) => c.update?.status === "available",
                  ).length
                }{" "}
                条扩展记录有新版本
              </p>
            )}
            <UpdateNotice update={tool.update} version={tool.version} />
            <button className="secondary" onClick={() => onProviders(tool)}>
              <Wifi size={14} /> 检查相关模型服务
            </button>
            <button
              className="text-button"
              aria-haspopup="dialog"
              aria-expanded={drawerOpen && selected === tool.id}
              onClick={() => {
                setSelected(tool.id);
                setDrawerOpen(true);
                setTab("network");
                setFeature("model");
                setComponentId(tool.components[0]?.id || "");
              }}
            >
              查看组件与覆盖
              <ChevronRight size={14} />
            </button>
          </article>
        ))}
      </div>
      {!tools.length && (
        <div className="empty">
          <h3>
            {busy
              ? "正在发现工具"
              : filter === "updates"
                ? "当前没有已确认的新版本提示"
                : "本次尚未确认安装记录"}
          </h3>
          <p>
            {filter === "updates"
              ? "未检查或查询失败的记录不能判定已是最新，请检查更新并查看每项结果。"
              : "未发现不代表未安装。便携版、远端和不支持的位置需要进一步核验。"}
          </p>
          <button className="text-button" onClick={() => setFilter("all")}>
            查看识别候选与工具目录
          </button>
        </div>
      )}
      {filter === "all" && (
        <div className="tool-directory">
          <strong>支持发现的工具目录</strong>
          {TOOL_PRODUCTS.map((product) => (
            <span key={product.id}>
              {product.name} ·{" "}
              {all.some((tool) => tool.productId === product.id)
                ? "有记录"
                : "本次未发现"}
            </span>
          ))}
        </div>
      )}
      <details className="plain-details">
        <summary>未发现便携版或 CLI？手动确认程序位置</summary>
        <p>
          只核验你选定的本机路径，不执行程序。手动关联不提升进程、扩展归属精度，也不会启用未经验证的修复。
        </p>
        <div className="manual-tool-picker">
          <select
            aria-label="手动关联工具"
            value={manualProduct}
            onChange={(event) => setManualProduct(event.target.value)}
          >
            {TOOL_PRODUCTS.map((product) => (
              <option value={product.id} key={product.id}>
                {product.name}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await api.chooseToolPath(manualProduct);
                if (next) setInventory(next);
              } catch (error) {
                onError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            选择并确认程序位置
          </button>
        </div>
      </details>
      {detail && drawerOpen && (
        <Modal
          drawer
          title={`${detail.name} · 工具详情`}
          subtitle={`版本 ${detail.version || "未知"} · 适配未验证 · 文件访问未覆盖`}
          onClose={() => setDrawerOpen(false)}
        >
          <div className="installed-detail tool-drawer-content">
            <dl className="detail-grid">
              <dt>识别来源</dt>
              <dd>{detail.sources.join("；")}</dd>
              <dt>本机位置</dt>
              <dd className="local-path">{detail.location}</dd>
              <dt>身份状态</dt>
              <dd>
                {IDENTITY_LABELS[detail.identityStatus]}；
                {detail.identityStatus === "running_confirmed"
                  ? "已匹配镜像路径与进程创建时间；未核验加载中的二进制哈希"
                  : "运行镜像未确认"}
                ；未进行签名核验
              </dd>
            </dl>
            <div className="tool-update-detail">
              <h3>版本与更新</h3>
              <UpdateNotice
                update={detail.update}
                version={detail.version}
                detail
              />
              {detail.update?.sourceUrl && (
                <a
                  href={detail.update.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看发布来源
                </a>
              )}
              <button
                className="secondary"
                disabled={blocked || !installed(detail)}
                onClick={() => void checkUpdates(detail.id)}
              >
                检查此安装记录的更新
              </button>
            </div>
            <div className="segmented">
              {[
                ["network", "组件与联网"],
                ["repair", "处理建议"],
                ["files", "文件保护"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "network" && (
              <>
                <div className="component-path">
                  <span>{detail.name} 本机组件</span>
                  <ChevronRight size={18} />
                  <span>网关或供应商 · 未确认</span>
                </div>
                <p>
                  尚未验证此版本的代理优先级、证书来源与真实端点。宿主、扩展、CLI
                  和 MCP
                  的网络行为需要分别核验；本机不能直接观察云端网关的上游连接。
                </p>
                {guidance && (
                  <div className="adapter-guidance">
                    <h3>官方说明 · 适配草案</h3>
                    {guidance.facts.map((fact) => (
                      <p key={fact}>{fact}</p>
                    ))}
                    <a
                      href={guidance.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {guidance.source.label}
                    </a>
                    <small>核对 {guidance.reviewedAt} · 本机版本尚未实测</small>
                  </div>
                )}
                {detail.components.map((component) => (
                  <div key={component.id} className="component-row">
                    <strong>
                      {component.name} · {component.version || "版本未知"}
                    </strong>
                    <span>
                      {component.runtime === "local"
                        ? "本机"
                        : "实际运行位置未知"}{" "}
                      · 通用诊断
                    </span>
                    {component.source && <p>{component.source}</p>}
                    {component.role === "extension" && (
                      <>
                        <UpdateNotice
                          update={component.update}
                          version={component.version}
                          detail
                        />
                        {component.update?.sourceUrl && (
                          <a
                            href={component.update.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看扩展发布来源
                          </a>
                        )}
                      </>
                    )}
                    <div>
                      {component.features.map((feature) => (
                        <span key={feature.name} className="badge muted">
                          {feature.name}：未测试
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="notice amber">
                  <Info size={15} />
                  未提供专用适配档案。公开网页 HEAD
                  成功不证明登录、模型推理或流式响应正常。
                </div>
                <div className="manual-tool-picker">
                  <select
                    aria-label="诊断组件"
                    value={componentId}
                    onChange={(event) => setComponentId(event.target.value)}
                  >
                    {detail.components.map((component) => (
                      <option key={component.id} value={component.id}>
                        {component.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="失败功能"
                    value={feature}
                    onChange={(event) =>
                      setFeature(event.target.value as ToolFeature)
                    }
                  >
                    {Object.entries(FEATURE_LABELS).map(([id, label]) => (
                      <option value={id} key={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary"
                    disabled={blocked || detail.identityStatus === "stale"}
                    onClick={() => {
                      setDrawerOpen(false);
                      onDiagnose(detail, componentId, feature);
                    }}
                  >
                    诊断所选功能
                    <ChevronRight size={14} />
                  </button>
                </div>
              </>
            )}
            {tab === "repair" && (
              <>
                <h3>先确认失败功能，再按证据处理</h3>
                <p>
                  代理 407 核对代理认证；TLS 错误核对时间和信任源；无凭据 HEAD
                  的 401 仅说明入口要求认证；429
                  核对限流与配额。直连和代理结果不同，还需在目标组件确认代理实际生效。
                </p>
                {guidance?.manualSteps.map((step, index) => (
                  <p key={step}>
                    {index + 1}. {step}
                  </p>
                ))}
                <div className="notice amber">
                  {repairEligibility(detail.productId, detail.version).reason}{" "}
                  不会修改系统代理、关闭证书校验或重放原任务。
                </div>
                {guidance && (
                  <details className="plain-details">
                    <summary>专用修复发布前需要验证什么</summary>
                    {guidance.missingTests.map((test) => (
                      <p key={test}>{test}</p>
                    ))}
                  </details>
                )}
                <button
                  className="secondary"
                  disabled={blocked || detail.identityStatus === "stale"}
                  onClick={() => {
                    setDrawerOpen(false);
                    onDiagnose(
                      detail,
                      componentId || detail.components[0].id,
                      feature,
                    );
                  }}
                >
                  诊断并记录目标功能复测
                  <ChevronRight size={14} />
                </button>
              </>
            )}
            {tab === "files" && (
              <>
                <div className="notice amber">
                  <ShieldCheck size={16} />
                  当前工具未接入文件网关或隔离启动，无法记录或阻止它直接访问文件。
                </div>
                <p>
                  可以先选择项目并设置读取、修改、发送模型三项策略。策略校验通过不代表第三方工具保护已经生效，已有内存与上下文中的内容也不能撤回。
                </p>
                <button
                  className="secondary"
                  onClick={() => {
                    setDrawerOpen(false);
                    onFiles();
                  }}
                >
                  设置文件范围与策略
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      <details className="plain-details">
        <summary>
          发现范围与限制
          {inventory?.checkedAt
            ? ` · ${new Date(inventory.checkedAt).toLocaleTimeString("zh-CN")}`
            : ""}
        </summary>
        {(inventory?.limitations || []).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </details>
    </section>
  );
}

function NetworkAvailability({
  tool,
  result,
  onCheck,
}: {
  tool: ToolInstall;
  result?: PlatformResult;
  onCheck: () => void;
}) {
  const knownEntry = !!TOOL_PUBLIC_ENTRY[tool.productId];
  const checking = result?.status === "checking";
  const networkReachable =
    result &&
    ["reachable", "auth_required", "restricted", "busy"].includes(
      result.status,
    );
  const tone =
    result?.status === "reachable" || result?.status === "auth_required"
      ? "green"
      : result?.status === "network_error"
        ? "red"
        : result?.status === "restricted" || result?.status === "busy"
          ? "amber"
          : checking
            ? "blue"
            : "muted";
  const label = checking
    ? PLATFORM_LABELS.checking
    : !knownEntry
      ? "服务地址未配置"
      : !result || result.status === "pending" || result.status === "cancelled"
        ? "尚未检测"
        : result.status === "reachable"
          ? "网络可达 · 入口已响应"
          : result.status === "auth_required"
            ? "网络可达 · 入口要求登录"
            : result.status === "restricted"
              ? "已连到入口 · 访问受限"
              : result.status === "busy"
                ? "已连到入口 · 服务异常"
                : result.status === "network_error"
                  ? "网络连接失败"
                  : "检测未完成";
  return (
    <div
      className="installed-network"
      aria-live={checking ? "polite" : undefined}
    >
      <div className="installed-network-copy">
        {checking ? (
          <Loader2 size={15} className="spin" />
        ) : networkReachable ? (
          <Wifi size={15} />
        ) : result?.status === "network_error" ? (
          <WifiOff size={15} />
        ) : result?.status === "check_failed" ? (
          <TriangleAlert size={15} />
        ) : (
          <Wifi size={15} />
        )}
        <strong>网络</strong>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      {knownEntry ? (
        <button
          className="text-button"
          disabled={checking}
          onClick={onCheck}
          aria-label={`${checking ? "正在检测" : "检测"}${tool.name}网络入口`}
        >
          {checking ? "检测中…" : "检测入口"}
        </button>
      ) : (
        <button
          className="text-button"
          onClick={onCheck}
          aria-label={`为${tool.name}指定网络服务并诊断`}
        >
          指定服务诊断
        </button>
      )}
      <small>
        {knownEntry
          ? "仅测公开服务入口，不代表客户端模型请求正常"
          : "按此工具实际使用的 API 或代理地址检测"}
        {result?.checkedAt
          ? ` · ${new Date(result.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
          : ""}
      </small>
    </div>
  );
}

function UpdateNotice({
  update,
  version,
  detail = false,
}: {
  update?: ToolUpdate;
  version?: string;
  detail?: boolean;
}) {
  const value = update || {
    status: "not_checked" as const,
    message: "点击检查更新核对发布版本。",
  };
  return (
    <div
      className={`tool-update ${value.status === "available" ? "has-update" : ""}`}
    >
      <span
        className={`badge ${value.status === "available" ? "amber" : "muted"}`}
      >
        {UPDATE_LABELS[value.status]}
      </span>
      {value.latestVersion && (
        <p>
          本机 {version || "未知"} → 发布源 {value.latestVersion}
        </p>
      )}
      <p>{value.message}</p>
      {detail && (
        <>
          {value.source && <p>来源：{value.source}</p>}
          {value.channel && <p>比较渠道：{value.channel}</p>}
        </>
      )}
      {value.checkedAt && (
        <small>查询 {new Date(value.checkedAt).toLocaleString("zh-CN")}</small>
      )}
    </div>
  );
}

function installationLabel(tool: ToolInstall) {
  const nvm = /\.nvm\/versions\/node\/([^/]+)\//.exec(tool.location);
  if (nvm) return `NVM · Node ${nvm[1]} 安装`;
  if (tool.location.includes(".app/Contents/")) return "桌面应用附带的组件";
  if (tool.location.includes("/.local/")) return "用户级原生安装";
  if (tool.components[0]?.role === "host") return "桌面应用包";
  return "独立 CLI 安装";
}

function hasUpdate(tool: ToolInstall) {
  return (
    tool.update?.status === "available" ||
    tool.components.some((c) => c.update?.status === "available")
  );
}
