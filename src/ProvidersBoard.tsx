import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  Globe2,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  TriangleAlert,
  Wifi,
  X,
} from "lucide-react";
import {
  ALL_ENDPOINTS,
  PROVIDER_KIND_LABELS,
  providerConnectionView,
  providerPathText,
} from "./shared/providers";
import Modal from "./Modal";
import {
  AI_PLATFORMS,
  PLATFORM_LABELS,
  platformHelpText,
} from "./shared/platforms";
import type {
  DesktopAPI,
  ModelProvider,
  PlatformResult,
  PlatformScan,
  ProviderEndpoint,
  ProviderResult,
  ProviderScan,
} from "./shared/types";
import TriagePanel from "./TriagePanel";
import type { ToolInstall } from "./shared/assistant";
import { suggestedEndpoints, suggestedTriageTarget } from "./shared/tool-network";
import { autoProviderScan } from "./shared/auto-provider-scan";

const KIND_GROUPS: {
  id: "provider_api" | "aggregator";
  title: string;
  note: string;
}[] = [
  {
    id: "provider_api",
    title: "模型提供商官方 API",
    note: "检查能否连到官方 API；密钥、权限与模型调用需在原工具中确认",
  },
  {
    id: "aggregator",
    title: "聚合中转",
    note: "公开聚合服务；用户自配中转将在后续版本从工具配置解析",
  },
];

const goodProvider = (r: ProviderResult) =>
  r.status === "reachable" || r.status === "auth_required";
const good = (r: PlatformResult) =>
  r.status === "reachable" || r.status === "auth_required";
const tone = (r: PlatformResult) =>
  good(r)
    ? "green"
    : ["network_error", "restricted", "busy"].includes(r.status)
      ? "amber"
      : "muted";
export default function ProvidersBoard({
  api,
  onError,
  onAdvanced,
  tool,
  triageRequested = false,
  onClearTool,
  onBack,
}: {
  api: DesktopAPI;
  onError: (text: string) => void;
  onAdvanced: () => void;
  tool?: ToolInstall;
  triageRequested?: boolean;
  onClearTool: () => void;
  onBack: () => void;
}) {
  const [providers, setProviders] = useState<ProviderScan>();
  const [scan, setScan] = useState<PlatformScan>();
  const [copied, setCopied] = useState<string>();
  const [triageOpen, setTriageOpen] = useState(triageRequested ? 1 : 0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  const suggestions = suggestedEndpoints(tool?.productId);
  const [filter, setFilter] = useState("全部");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<string>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [providerDetail, setProviderDetail] = useState<string>();

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onProviders((value) => {
      if (active) setProviders(value);
    });
    void autoProviderScan(api)
      .then((value) => {
        if (active) setProviders(value);
      })
      .catch((e) => {
        if (active) onError(e.message);
      });
    const unsubPlatforms = api.onPlatforms((value) => {
      if (active) setScan(value);
    });
    void api
      .platforms()
      .then((value) => {
        if (active) setScan(value);
      })
      .catch((e) => {
        if (active) onError(e.message);
      });
    return () => {
      active = false;
      unsubscribe();
      unsubPlatforms();
    };
  }, [api]);

  const check = async (id?: string) => {
    try {
      setProviders(await api.scanProviders(id));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const stopCheck = async () => {
    try {
      setProviders(await api.stopProviders());
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const action = async (id?: string) => {
    try {
      setScan(await api.scanPlatforms(id));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const stop = async () => {
    try {
      setScan(await api.stopPlatforms());
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const checking = providers?.status === "running";
  const scopeIds =
    providers?.endpointIds || ALL_ENDPOINTS.map((x) => x.endpoint.id);
  const scopeResults =
    providers?.results.filter((r) => scopeIds.includes(r.endpointId)) || [];
  const scopeTotal = Math.max(scopeIds.length, 1);
  const completed =
    scopeResults.filter(
      (r) => !["pending", "checking", "cancelled"].includes(r.status),
    ).length || 0;
  const available = scopeResults.filter(goodProvider).length;
  const problems = scopeResults.filter((r) =>
    ["network_error", "restricted", "busy"].includes(r.status),
  ).length;
  const failedChecks = scopeResults.filter(
    (r) => r.status === "check_failed",
  ).length;
  const detailResult = providers?.results.find(
    (r) => r.endpointId === providerDetail,
  );
  const detailItem = ALL_ENDPOINTS.find(
    (item) => item.endpoint.id === providerDetail,
  );
  const detailConnection = providerConnectionView(detailResult);

  return (
    <div className="tool-home">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MODEL PROVIDERS · CONNECTIVITY</div>
          <h1>网络检查</h1>
          <p>默认自动检查所有已收录 API 提供商；无凭据请求只证明网络路径。</p>
        </div>
        <span className="badge green">
          <ShieldCheck size={14} />
          自动检查 · 不携带凭据
        </span>
      </div>
      {tool && (
        <section className="notice tool-network-context">
          <Info size={18} />
          <div>
            <strong>正在为 {tool.name} 检查网络</strong>
            <p>
              下列建议不是已读取的应用配置。使用中转或其他模型时，请选择实际服务；检查完成后回到{" "}
              {tool.name} 重试原来的操作。
            </p>
            {suggestions.map(({ provider, endpoint }) => (
              <button
                key={endpoint.id}
                className="secondary"
                disabled={checking}
                onClick={() => void check(endpoint.id)}
              >
                检查建议服务：{provider.name}
              </button>
            ))}
            {!suggestions.length && (
              <p>该工具可使用多种服务，请在下方选择实际模型服务。</p>
            )}
            <button className="text-button" onClick={onBack}>
              返回应用列表并在原工具复测
            </button>
            <button className="text-button" onClick={onClearTool}>
              清除应用范围
            </button>
          </div>
        </section>
      )}
      <section className="tool-health">
        <div className={`health-symbol ${checking ? "checking" : ""}`}>
          {checking ? (
            <Loader2 size={32} className="spin" />
          ) : problems ? (
            <Wifi size={32} />
          ) : (
            <ShieldCheck size={32} />
          )}
        </div>
        <div className="health-description">
          <h2>
            {checking
              ? "正在探测模型服务端点"
              : providers?.status === "cancelled"
                ? "检查已停止，已完成结果保留"
                : providers?.status === "completed"
                  ? failedChecks
                    ? `检查完成，${failedChecks} 个端点检测未完成`
                    : problems
                      ? `检查完成，${problems} 个端点需要关注`
                      : `检查完成，${available} 个端点可连接`
                  : problems
                    ? `${problems} 个端点需要你关注`
                    : "正在准备自动检查模型服务端点"}
          </h2>
          <p>
            {checking
              ? `已完成 ${completed} / ${scopeTotal} · 可以继续使用电脑`
              : providers?.ended
                ? `本次完成于 ${new Date(providers.ended).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · 结果仅代表本次网络`
                : "首次进入自动检查全部端点；切换菜单不重复检查，可随时停止。"}
          </p>
          <div className="health-stats">
            <span>
              <i className="status-dot" />
              {available} 个端点可连接
            </span>
            <span>
              <i className="status-dot amber-dot" />
              {problems} 个需要关注
            </span>
            <span>{failedChecks} 个检测未完成</span>
          </div>
        </div>
        {checking ? (
          <button className="secondary" onClick={stopCheck}>
            <Square size={14} />
            停止检查
          </button>
        ) : (
          <button className="primary" onClick={() => void check()}>
            <RefreshCw size={16} />
            重新检查
          </button>
        )}
        <div className="health-progress">
          <span style={{ width: `${(completed / scopeTotal) * 100}%` }} />
        </div>
      </section>
      <div className="tool-scope">
        <Info size={16} />
        <p>
          对端点发送无凭据请求，只判断 DNS / TCP / TLS / HTTP 各层是否可达。
          <strong>
            收到服务响应说明本次路径已连通；不验证密钥、对话或工具功能。
          </strong>
        </p>
      </div>
      <div id="tool-triage">
        {(problems > 0 || failedChecks > 0) && (
          <div className="notice amber">
            <Info size={16} />
            <div>
              检查有异常？
              <button
                className="text-button"
                onClick={() => setTriageOpen((value) => value + 1)}
              >
                按顺序排查网络与代理
              </button>
            </div>
          </div>
        )}
        <TriagePanel
          key={tool?.id || "general"}
          api={api}
          initialTarget={tool ? suggestedTriageTarget(tool.productId) || "" : "codex"}
          platformChecking={checking}
          onError={onError}
          expandRequested={triageOpen}
        />
      </div>
      {KIND_GROUPS.map((kind) => {
        const items = ALL_ENDPOINTS.filter((x) => x.endpoint.kind === kind.id);
        if (!items.length) return null;
        return (
          <section key={kind.id}>
            <div className="section-heading">
              <div>
                <h2>{kind.title}</h2>
                <p>{kind.note}</p>
              </div>
            </div>
            <div className="tool-grid">
              {items.map(({ provider, endpoint }) => {
                const r = providers?.results.find(
                  (r) => r.endpointId === endpoint.id,
                );
                return (
                  <ProviderCard
                    key={endpoint.id}
                    provider={provider}
                    endpoint={endpoint}
                    result={r}
                    copied={copied === endpoint.id}
                    onDetails={() => setProviderDetail(endpoint.id)}
                    onCheck={() => void check(endpoint.id)}
                    onCopy={async () => {
                      if (!r) return;
                      try {
                        await api.copyProviderResult(endpoint.id);
                        setCopied(endpoint.id);
                      } catch {
                        onError("复制未完成，请选中下面的反馈内容手动复制。");
                      }
                    }}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
      {detailResult && detailItem && (
        <Modal
          drawer
          title={`${detailItem.provider.name} · 网络详情`}
          subtitle="各条路径仅代表本次检测"
          onClose={() => setProviderDetail(undefined)}
        >
          <div className="installed-detail tool-drawer-content provider-network-detail">
            <span className={`badge ${detailConnection.tone}`}>
              {detailConnection.label}
            </span>
            <p>{detailConnection.summary}</p>
            {detailConnection.pathNote && <p>{detailConnection.pathNote}</p>}
            <dl className="detail-grid">
              <dt>检测地址</dt>
              <dd>
                {detailResult.effectiveUrl}
                {detailItem.endpoint.probePath}
              </dd>
              <dt>完成时间</dt>
              <dd>
                {detailResult.checkedAt
                  ? new Date(detailResult.checkedAt).toLocaleString("zh-CN")
                  : "尚未完成"}
              </dd>
            </dl>
            <h3>各网络路径</h3>
            <div
              className="route-results provider-route-detail"
              aria-label="各网络路径结果"
            >
              {(detailResult.paths || []).map((path) => (
                <div key={path.label}>
                  <strong>{path.label}</strong>
                  <p
                    className={
                      path.status === "accessible"
                        ? "route-ok"
                        : path.status === "unreachable"
                          ? "route-failed"
                          : "route-limited"
                    }
                  >
                    {providerPathText(path)}
                  </p>
                </div>
              ))}
              {!detailResult.paths?.length && <p>本次没有完整的路径证据。</p>}
            </div>
            <h3>下一步</h3>
            <p>{detailResult.suggestion || "等待检测完成，或重新检测。"}</p>
            <div className="notice">
              <Info size={16} />
              无凭据探测只判断网络路径；密钥是否有效、模型调用是否正常，需在原工具中确认。
            </div>
            <button
              className="secondary"
              disabled={detailResult.status === "checking"}
              onClick={() => void check(detailResult.endpointId)}
            >
              <RefreshCw size={14} /> 重新检测
            </button>
          </div>
        </Modal>
      )}
      <PlatformCatalog />
      <div className="tool-bottom">
        <div>
          <ShieldCheck size={17} />
          <span>检查只读进行，不会修改公司网络设置。</span>
        </div>
        <button className="text-button" onClick={onAdvanced}>
          其他工具连接有问题？
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );

  function PlatformCatalog() {
    const result = scan?.results.find((r) => r.platformId === detail);
    const platform = AI_PLATFORMS.find((p) => p.id === detail);
    const platformChecking = scan?.status === "running";
    const filtered = AI_PLATFORMS.filter(
      (p) =>
        `${p.name} ${p.description}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "全部" ||
          filter === p.region ||
          (filter === "需要关注" &&
            scan?.results.some(
              (r) =>
                r.platformId === p.id &&
                [
                  "network_error",
                  "restricted",
                  "busy",
                  "check_failed",
                ].includes(r.status),
            ))),
    );
    return (
      <details
        open={catalogOpen}
        onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
        className="platform-catalog"
      >
        <summary>
          网页平台目录与入口检查 · {AI_PLATFORMS.length} 个平台
          <span>公开入口结果不代表模型 API 路径</span>
        </summary>
        <section className="tool-health">
          <div
            className={`health-symbol ${platformChecking ? "checking" : ""}`}
          >
            {platformChecking ? (
              <Loader2 size={32} className="spin" />
            ) : scan?.results.some((r) =>
                ["network_error", "restricted", "busy"].includes(r.status),
              ) ? (
              <Wifi size={32} />
            ) : (
              <ShieldCheck size={32} />
            )}
          </div>
          <div className="health-description">
            <h2>
              {platformChecking
                ? "正在检查公开网页入口"
                : scan?.status === "cancelled"
                  ? "检查已停止，已完成结果保留"
                  : scan?.status === "completed"
                    ? "检查完成"
                    : "按需检查公开网页入口"}
            </h2>
            <p>
              {platformChecking
                ? "可以继续使用电脑"
                : "仅作为辅助参考；模型 API 路径请以上方端点检查结果为准。"}
            </p>
          </div>
          {platformChecking ? (
            <button className="secondary" onClick={() => void stop()}>
              <Square size={14} />
              停止检查
            </button>
          ) : (
            <button className="primary" onClick={() => void action()}>
              <RefreshCw size={16} />
              {scan?.status === "idle" ? "开始检查网页入口" : "重新检查"}
            </button>
          )}
        </section>
        <div className="tool-filters">
          <div className="segmented">
            {["全部", "国内", "海外", "需要关注"].map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                className={filter === f ? "active" : ""}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="搜索平台"
              placeholder="搜索网页平台"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="tool-grid">
          {filtered.map((p) => {
            const r = scan?.results.find((r) => r.platformId === p.id);
            return (
              <article
                className={`tool-card ${r && tone(r) === "amber" ? "needs-attention" : ""}`}
                key={p.id}
              >
                <div className="tool-card-head">
                  <div
                    className="platform-icon"
                    style={{ background: p.color }}
                  >
                    {p.initials}
                  </div>
                  <div>
                    <h3>{p.name}</h3>
                    <small>
                      {p.region} · {p.category}
                    </small>
                  </div>
                  <span className={`badge ${r ? tone(r) : "muted"}`}>
                    {r ? PLATFORM_LABELS[r.status] : "等待检查"}
                  </span>
                </div>
                <p className="tool-description">{p.description}</p>
                <div className="platform-result">
                  <p>{r?.summary || "尚未测试"}</p>
                </div>
                <div className="tool-card-footer">
                  <span>
                    {r?.checkedAt
                      ? `${new Date(r.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 检查`
                      : "本次尚无结果"}
                  </span>
                  <div className="card-actions">
                    <button
                      className="service-test"
                      disabled={r?.status === "checking"}
                      onClick={() => void action(p.id)}
                    >
                      {r?.status === "checking" ? "测试中" : "单独测试"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setDetail(p.id);
                        setCopied(undefined);
                      }}
                    >
                      查看建议
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {result && platform && (
          <section
            id="platform-advice"
            className="platform-detail panel"
            aria-label={`${platform.name} 检查建议`}
          >
            <div className="section-heading">
              <div>
                <h2>
                  {platform.name} · {PLATFORM_LABELS[result.status]}
                </h2>
                <p>{result.summary}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setDetail(undefined)}
                aria-label="收起建议"
              >
                <X size={18} />
              </button>
            </div>
            <div className="platform-next">
              <div className="quick-icon blue">
                <Info size={22} />
              </div>
              <div>
                <strong>你可以这样做</strong>
                <p>
                  {result.suggestion || "等待本次检查完成，或点击重新检查。"}
                </p>
              </div>
            </div>
            <div className="platform-actions">
              <a
                className="secondary"
                href={platform.url}
                target="_blank"
                rel="noreferrer"
              >
                <Globe2 size={15} />
                打开平台
              </a>
              <button
                className="secondary"
                onClick={() => void action(platform.id)}
              >
                <RefreshCw size={15} />
                只检查这个平台
              </button>
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await api.copyPlatformResult(platform.id);
                    setCopied(`platform:${platform.id}`);
                  } catch {
                    onError("复制未完成，请选中下面的反馈内容手动复制。");
                  }
                }}
              >
                <Copy size={15} />
                {copied === `platform:${platform.id}`
                  ? "已复制，可发给 IT"
                  : "复制结果给 IT"}
              </button>
            </div>
            <details className="plain-details">
              <summary>检查详情与 IT 反馈内容</summary>
              <pre>{platformHelpText(scan!, result)}</pre>
            </details>
          </section>
        )}
      </details>
    );
  }
}

function ProviderCard({
  provider,
  endpoint,
  result: r,
  onCheck,
  onCopy,
  onDetails,
  copied,
}: {
  provider: ModelProvider;
  endpoint: ProviderEndpoint;
  result?: ProviderResult;
  onCheck: () => void;
  onCopy: () => void;
  onDetails: () => void;
  copied: boolean;
}) {
  const connection = providerConnectionView(r);
  return (
    <article
      className={`tool-card ${connection.tone === "amber" || connection.tone === "red" ? "needs-attention" : ""}`}
    >
      <div className="tool-card-head">
        <div className="platform-icon" style={{ background: provider.color }}>
          {provider.initials}
        </div>
        <div>
          <h3>{provider.name}</h3>
          <small>
            {provider.region} · {PROVIDER_KIND_LABELS[endpoint.kind]}
          </small>
        </div>
        <span className={`badge ${connection.tone}`}>
          {r?.status === "checking" ? (
            <Loader2 size={12} className="spin" />
          ) : connection.tone === "green" ? (
            <CheckCircle2 size={12} />
          ) : connection.tone === "amber" || connection.tone === "red" ? (
            <TriangleAlert size={12} />
          ) : null}
          {connection.label}
        </span>
      </div>
      <p className="tool-description mono">
        {endpoint.url.replace("https://", "")}
        {endpoint.probePath}
      </p>
      <div className="platform-result">
        <p>{connection.summary}</p>
        {connection.pathNote && <small>{connection.pathNote}</small>}
        {r && !["pending", "checking", "cancelled"].includes(r.status) && (
          <button className="text-button" onClick={onDetails}>
            网络详情 <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div className="tool-card-footer">
        <span>
          {r?.checkedAt
            ? `${new Date(r.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 检查`
            : r?.status === "checking"
              ? "通常只需几秒"
              : "本次尚无结果"}
        </span>
        <div className="card-actions">
          <button
            className="service-test"
            disabled={r?.status === "checking"}
            onClick={onCheck}
          >
            {r?.status === "checking" ? (
              <>
                <Loader2 size={12} className="spin" /> 测试中
              </>
            ) : (
              <>
                <RefreshCw size={12} /> 单独测试
              </>
            )}
          </button>
          <button className="text-button" onClick={onCopy} disabled={!r}>
            <Copy size={12} />
            {copied ? "已复制" : "复制结果给 IT"}
          </button>
          {provider.statusPage && (
            <a
              className="text-button"
              href={provider.statusPage}
              target="_blank"
              rel="noreferrer"
            >
              <Globe2 size={12} />
              官方状态页
            </a>
          )}
        </div>
      </div>
      {r?.status === "checking" && (
        <div className="service-progress" aria-live="polite">
          <div>
            <span>{r.progress?.label || "正在连接端点"}</span>
            <span>
              {r.progress?.completed || 0}/{r.progress?.total || 5}
            </span>
          </div>
          <progress
            max={r.progress?.total || 5}
            value={r.progress?.completed || 0}
            aria-label={`${provider.name}网络测试进度`}
          />
        </div>
      )}
    </article>
  );
}
