import { useCallback, useEffect, useState } from "react";
import type {
  ForwardKind,
  ForwardSettings,
  ForwardStats,
  ForwardTarget,
  SecurityAPI,
} from "./shared/security";

type Props = {
  service: SecurityAPI;
  notify: (message: string, error?: boolean) => void;
};

const KIND_LABELS: Record<ForwardKind, string> = {
  http: "HTTPS 接口",
  udp: "Syslog UDP",
  tcp: "Syslog TCP",
  tls: "Syslog TLS",
};

const blankTarget = (kind: ForwardKind = "http"): ForwardTarget => ({
  id: crypto.randomUUID(),
  enabled: true,
  kind,
  ...(kind === "http"
    ? { url: "https://" }
    : { host: "", port: kind === "udp" ? 514 : 6514 }),
});

export default function SecurityForward({ service, notify }: Props) {
  const [settings, setSettings] = useState<ForwardSettings>({
    enabled: false,
    targets: [],
  });
  const [stats, setStats] = useState<ForwardStats>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [next, state] = await Promise.all([
        service.securityForwardSettings(),
        service.securityForwardStats(),
      ]);
      setSettings(next);
      setStats(state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  const editTarget = (id: string, patch: Partial<ForwardTarget>) =>
    setSettings((current) => ({
      ...current,
      targets: current.targets.map((t) =>
        t.id === id ? { ...t, ...patch } : t,
      ),
    }));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel security-box forward-panel">
      <div className="security-title">
        <div>
          <h2>日志外送</h2>
          <p>
            把本机记录的 AI 操作送到公司日志平台。外送在后台进行，不影响执行前的拦截速度。
          </p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await service.securitySaveForwardSettings(settings);
              await load();
              notify("外送设置已保存");
            })
          }
        >
          保存并启用
        </button>
      </div>

      <section className="forward-section">
        <label className="forward-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) =>
              setSettings((current) => ({
                ...current,
                enabled: e.target.checked,
              }))
            }
          />
          <span>
            <b>开启外送</b>
            <small>
              默认关闭。开启后只发送已记录的事件和分级结论，不发送命令原文。
            </small>
          </span>
        </label>
        <label className="forward-toggle">
          <input
            type="checkbox"
            checked={settings.includeIncidents === true}
            onChange={(e) =>
              setSettings((current) => ({
                ...current,
                includeIncidents: e.target.checked,
              }))
            }
          />
          <span>
            <b>同时发送合并后的事件链</b>
            <small>平台侧可以直接按事件处置，不用再自己合并。</small>
          </span>
        </label>
      </section>

      <section className="forward-section">
        <div className="security-title">
          <h3>接收目标</h3>
          <div className="forward-actions">
            <button
              className="secondary"
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  targets: [...current.targets, blankTarget()],
                }))
              }
            >
              添加目标
            </button>
          </div>
        </div>
        {!settings.targets.length && (
          <p className="hint">
            还没有接收目标。可以添加 HTTPS 接口、Syslog UDP/TCP/TLS，也可以先用下面的“导出
            NDJSON”把数据交给平台导入。
          </p>
        )}
        {settings.targets.map((target, index) => (
          <div className="forward-target" key={target.id}>
            <div className="forward-target-row">
              <span className="forward-index">{index + 1}</span>
              <select
                aria-label="外送方式"
                value={target.kind}
                onChange={(e) =>
                  editTarget(target.id, {
                    kind: e.target.value as ForwardKind,
                  })
                }
              >
                {Object.entries(KIND_LABELS).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="forward-inline">
                <input
                  type="checkbox"
                  checked={target.enabled !== false}
                  onChange={(e) =>
                    editTarget(target.id, { enabled: e.target.checked })
                  }
                />
                启用
              </label>
              <button
                className="secondary"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    targets: current.targets.filter((t) => t.id !== target.id),
                  }))
                }
              >
                移除
              </button>
            </div>
            {target.kind === "http" ? (
              <div className="forward-target-grid">
                <label className="security-field">
                  <span>接口地址</span>
                  <input
                    value={target.url ?? ""}
                    placeholder="https://siem.example.com/api/ai-events"
                    onChange={(e) => editTarget(target.id, { url: e.target.value })}
                  />
                </label>
                <label className="security-field">
                  <span>访问令牌（可选）</span>
                  <input
                    type="password"
                    value={target.token ?? ""}
                    placeholder="Bearer 令牌"
                    onChange={(e) =>
                      editTarget(target.id, { token: e.target.value })
                    }
                  />
                </label>
              </div>
            ) : (
              <div className="forward-target-grid">
                <label className="security-field">
                  <span>服务器地址</span>
                  <input
                    value={target.host ?? ""}
                    placeholder="siem.internal"
                    onChange={(e) =>
                      editTarget(target.id, { host: e.target.value })
                    }
                  />
                </label>
                <label className="security-field">
                  <span>端口</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={target.port ?? ""}
                    onChange={(e) =>
                      editTarget(target.id, { port: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="forward-section">
        <div className="security-title">
          <h3>发送情况</h3>
          <div className="forward-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await service.securityForwardNow();
                  await load();
                  notify(
                    result.error
                      ? `外送失败：${result.error}`
                      : result.sent
                        ? `已发送 ${result.sent} 条`
                        : "没有新的记录需要发送",
                    !!result.error,
                  );
                })
              }
            >
              立即发送
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const file = await service.securityForwardExport();
                  notify(`已导出 ${file.rows} 条到 ${file.path}`);
                })
              }
            >
              导出 NDJSON
            </button>
          </div>
        </div>
        <dl className="forward-stats">
          <div>
            <dt>已发送</dt>
            <dd>{stats?.sent ?? 0} 条</dd>
          </div>
          <div>
            <dt>待发送</dt>
            <dd>{stats?.pending ?? 0} 条</dd>
          </div>
          <div>
            <dt>最近发送</dt>
            <dd>
              {stats?.lastSentAt
                ? new Date(stats.lastSentAt).toLocaleString("zh-CN")
                : "尚未发送"}
            </dd>
          </div>
        </dl>
        {stats?.lastError && (
          <p className="forward-error" role="alert">
            最近一次外送失败：{stats.lastError}
          </p>
        )}
        {error && (
          <p className="forward-error" role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          断网或平台不可用时会保留待发送记录并自动重试；外送失败不会影响本机拦截和已有记录。
        </p>
      </section>
    </div>
  );
}
