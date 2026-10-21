import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  X,
} from "lucide-react";
import {
  UPDATE_SOURCES,
  UPDATE_SOURCE_IDS,
  type AppUpdateAPI,
  type AppUpdateState,
  type UpdatePreference,
} from "./shared/app-update";
import { version as projectVersion } from "../package.json";

const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const platformLabel = (platform: string) =>
  platform
    .replace("darwin", "macOS")
    .replace("win32", "Windows")
    .replace("linux", "Linux")
    .replace("-", " · ");

export default function AppUpdates({
  api,
  demo,
}: {
  api: AppUpdateAPI;
  demo: boolean;
}) {
  const [state, setState] = useState<AppUpdateState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let alive = true,
      receivedEvent = false;
    setState(undefined);
    setError("");
    setLoadFailed(false);
    const fail = (message: string) => {
      if (!alive || receivedEvent) return;
      setLoadFailed(true);
      setError(message);
    };
    const connected = (value: AppUpdateState) => {
      if (!alive) return;
      setLoadFailed(false);
      setError("");
      setState(value);
    };
    if (
      ![
        api.appUpdate,
        api.onAppUpdate,
        api.setAppUpdateSource,
        api.checkAppUpdate,
        api.downloadAppUpdate,
        api.cancelAppUpdate,
        api.revealAppUpdate,
        api.openAppReleasePage,
      ].every((fn) => typeof fn === "function")
    ) {
      fail("更新服务尚未加载，请关闭并重新启动桌面应用。");
      return;
    }
    const timeout = setTimeout(
      () => fail("连接更新服务超时，请重新启动桌面应用。"),
      5000,
    );
    const unsubscribe = api.onAppUpdate((value) => {
      receivedEvent = true;
      clearTimeout(timeout);
      connected(value);
    });
    void api.appUpdate().then(
      (value) => {
        clearTimeout(timeout);
        if (!receivedEvent) connected(value);
      },
      (cause) => {
        clearTimeout(timeout);
        fail("无法连接更新服务，请关闭并重新启动桌面应用。");
      },
    );
    return () => {
      alive = false;
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [api]);
  const action = async (fn: () => Promise<AppUpdateState | void>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const result = await fn();
      if (result) setState(result);
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : String(cause)).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const active =
    state && ["checking", "downloading", "verifying"].includes(state.status);
  const canDownload =
    state?.release?.fileName &&
    ["available", "cancelled", "error"].includes(state.status);
  const progress = state?.total
    ? Math.min(100, (state.received / state.total) * 100)
    : 0;
  return (
    <section
      className="panel settings-panel app-updates"
      aria-labelledby="app-updates-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="app-updates-title">
            <Download size={19} /> 应用更新
          </h2>
          <p>Gitee 与 GitHub 双源下载，安装前由你确认。</p>
        </div>
        <span className="app-update-version">
          {state
            ? `v${state.currentVersion} · ${platformLabel(state.platform)}`
            : loadFailed
              ? `v${projectVersion} · 更新服务未连接`
              : "读取版本中…"}
          {demo && " · 演示"}
        </span>
      </div>
      <div className="setting-row">
        <div>
          <h3>下载源</h3>
          <p>
            {(state?.preference ?? "auto") === "auto"
              ? "比较两边版本，优先从 Gitee 下载；失败后切换 GitHub。"
              : "仅使用所选站点；如连接失败，可切回自动。"}
          </p>
        </div>
        <select
          aria-label="应用更新下载源"
          disabled={!state || pending || active}
          value={state?.preference ?? "auto"}
          onChange={(event) =>
            void action(() =>
              api.setAppUpdateSource(event.target.value as UpdatePreference),
            )
          }
        >
          <option value="auto">自动 · Gitee 优先</option>
          <option value="gitee">Gitee</option>
          <option value="github">GitHub</option>
        </select>
      </div>
      <div className="app-update-body">
        <div
          className={`app-update-summary ${state?.status === "error" ? "failed" : ""}`}
          role="status"
          aria-live="polite"
        >
          {state?.status === "ready" && <CheckCircle2 size={18} />}
          <div>
            <strong>
              {state?.message ||
                (loadFailed ? "更新服务未连接" : "正在读取更新状态…")}
            </strong>
            {state?.checkedAt && (
              <small>
                上次检查：{new Date(state.checkedAt).toLocaleString("zh-CN")}
              </small>
            )}
          </div>
        </div>
        {error && (
          <p className="notice amber" role="alert">
            {error}
          </p>
        )}
        {state?.sources.length ? (
          <div className="app-update-sources" aria-label="更新源状态">
            {state.sources.map((source) => (
              <div
                key={source.source}
                className={source.status === "error" ? "failed" : ""}
              >
                <strong>{UPDATE_SOURCES[source.source].label}</strong>
                <span>{source.message}</span>
              </div>
            ))}
          </div>
        ) : null}
        {state?.release && (
          <div className="app-update-release">
            <strong>发布版本 v{state.release.version}</strong>
            <span>
              {new Date(state.release.publishedAt).toLocaleDateString("zh-CN")}
              {state.release.size ? ` · ${sizeLabel(state.release.size)}` : ""}
            </span>
            {state.release.notes && (
              <details>
                <summary>查看更新说明</summary>
                <p>{state.release.notes}</p>
              </details>
            )}
          </div>
        )}
        {state &&
          ["downloading", "verifying", "ready"].includes(state.status) && (
            <div className="app-update-progress">
              <div>
                <span>
                  {state.activeSource
                    ? UPDATE_SOURCES[state.activeSource].label
                    : ""}{" "}
                  · {sizeLabel(state.received)} / {sizeLabel(state.total)}
                </span>
                <strong>{Math.floor(progress)}%</strong>
              </div>
              <progress
                aria-label="安装包下载进度"
                max={100}
                value={progress}
              />
            </div>
          )}
        {state?.attempts.length ? (
          <ul className="app-update-attempts" aria-label="下载切换记录">
            {state.attempts.map((attempt, index) => (
              <li key={index}>
                {UPDATE_SOURCES[attempt.source].label}：{attempt.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="app-update-actions">
          {loadFailed && !state && (
            <button
              className="secondary"
              onClick={() => window.location.reload()}
            >
              <RefreshCw size={15} />
              重新加载界面
            </button>
          )}
          <button
            className="secondary"
            disabled={!state || pending || active || demo}
            onClick={() => void action(() => api.checkAppUpdate())}
          >
            <RefreshCw
              size={15}
              className={state?.status === "checking" ? "spin" : undefined}
            />
            {state?.status === "checking" ? "检查中…" : "检查更新"}
          </button>
          {canDownload && (
            <button
              className="primary"
              disabled={pending || active || demo}
              onClick={() => void action(() => api.downloadAppUpdate())}
            >
              <Download size={15} />
              {state?.attempts.length ? "重试下载" : "下载新版本"}
            </button>
          )}
          {active && (
            <button
              className="secondary"
              onClick={() => {
                void api
                  .cancelAppUpdate()
                  .catch((cause) => setError(String(cause)));
              }}
            >
              <X size={15} />
              取消{state?.status === "checking" ? "检查" : "下载"}
            </button>
          )}
          {state?.status === "ready" && (
            <button
              className="primary"
              disabled={pending}
              onClick={() => void action(() => api.revealAppUpdate())}
            >
              <FolderOpen size={15} />
              打开下载位置
            </button>
          )}
        </div>
        {state?.status === "ready" && (
          <p className="app-update-help">
            {state.platform.startsWith("win32")
              ? "保存工作后，关闭应用并运行下载的安装程序。"
              : state.platform.startsWith("darwin")
                ? "保存工作后，退出应用，打开下载包并将新版本替换到应用程序目录。"
                : "保存工作后，退出应用并使用下载的安装包更新。"}
          </p>
        )}
        <div className="app-update-links">
          {UPDATE_SOURCE_IDS.map((source) => (
            <button
              className="app-update-link"
              key={source}
              disabled={
                demo || pending || typeof api.openAppReleasePage !== "function"
              }
              onClick={() => void action(() => api.openAppReleasePage(source))}
            >
              <ExternalLink size={13} />
              {UPDATE_SOURCES[source].label} 发行版
            </button>
          ))}
        </div>
        {demo && (
          <p className="app-update-help">
            浏览器演示不连接更新源或下载文件，请使用桌面本地模式。
          </p>
        )}
      </div>
    </section>
  );
}
