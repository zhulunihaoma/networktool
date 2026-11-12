import { useEffect, useRef, useState } from "react";
import { History, Search } from "lucide-react";
import {
  RULE_TITLES,
  TOOL_NAMES,
  type RetroHit,
  type RetroScanReport,
  type SecurityAPI,
  type SecurityProgress,
  type SecurityTool,
} from "./shared/security";

/**
 * 回溯扫描（“查杀”）：只读扫描本机已记录的 AI 工具会话，
 * 找出历史会话里的可疑线索（读密钥、管道执行、强推等）。
 * 历史命中独立展示，不参与当前风险评分。
 */
const RETRO_REVIEW: Record<string, string> = {
  credential_read: "核对是否读取了真实凭据及是否外发；仅出现路径不等于泄露。确认凭据泄露后轮换相关密钥。",
  plaintext_secret: "核对是否为有效密钥；若曾暴露真实密钥，应撤销或轮换，并清理共享副本。",
  remote_exec: "核对脚本来源、是否实际执行及执行结果；未经授权的改动需要进一步排查。",
  destructive: "核对文件和远端分支状态；如有误删或覆盖，检查备份与恢复记录。",
  privilege: "核对管理员操作或权限变更是否经过授权，以及当前文件权限是否仍然过宽。",
  dns_exfil: "核对目的地址、实际发送内容及请求结果；仅命中地址规则不能认定数据已外泄。",
};
const RETRO_STEPS = [
  "Codex 会话记录",
  "Claude Code 会话记录",
  "ZCode 会话记录",
  "OpenCode 会话记录",
  "WisCode 会话记录",
  "DeepSeek Harness 会话记录",
];

export default function SecurityRetro({
  service,
  report,
  busy,
  notify,
  onError,
  onDone,
}: {
  service: SecurityAPI;
  report?: RetroScanReport;
  busy: boolean;
  notify: (text: string) => void;
  onError: (text: string) => void;
  /** Refresh overview after the scan so score/findings update. */
  onDone: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<SecurityProgress>();
  const [running, setRunning] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(
    () =>
      service.onSecurityProgress((p) => {
        if (p.kind === "retro") setProgress(p);
      }),
    [service],
  );
  const hits = report?.hits ?? [];
  const grouped = hits.reduce<Record<string, RetroHit[]>>((acc, hit) => {
    (acc[hit.tool] ??= []).push(hit);
    return acc;
  }, {});
  const run = async () => {
    setRunning(true);
    setProgress(undefined);
    try {
      const result = await service.securityRetroScan();
      await onDone();
      notify(
        `回溯扫描完成：读取 ${result.scannedFiles} 个会话文件${
          result.sources.length ? `（${result.sources.join("、")}）` : ""
        }，发现 ${result.hits.length} 条历史线索，不计入当前问题或扣分${result.truncated ? "；会话较多，仅扫描了最近的一部分" : ""}。`,
      );
    } catch (e) {
      errorRef.current(String(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <div className="panel security-box retro-scan-header">
        <div className="security-title">
          <div>
            <h2>
              <History size={18} /> 回溯扫描
            </h2>
            <p>
              只读扫描本机已保存的 AI 工具会话，复核读取密钥、下载即执行、强制推送等历史线索。
              仅检查可识别的命令载荷与疑似明文密钥，未识别的会话格式不代表安全。不启动任何 AI 工具，不上传任何内容。
            </p>
          </div>
          <button className="primary" disabled={busy || running} onClick={run}>
            <Search size={15} />
            {running ? "扫描中…" : report ? "重新扫描" : "开始扫描"}
          </button>
        </div>
        {report && !running && (
          <p className="hint">
            上次扫描：{new Date(report.at).toLocaleString("zh-CN")} · 读取{" "}
            {report.scannedFiles} 个会话文件 · 用时 {Math.max(1, Math.round(report.durationMs / 1000))} 秒
            {report.truncated && " · 会话较多，只扫描了最近的一部分"}
          </p>
        )}
        {running && progress && (
          <ol className="checkup-steps">
            {RETRO_STEPS.map((text, i) => (
              <li
                key={text}
                className={
                  i < progress.step ? "done" : i === progress.step ? "doing" : ""
                }
              >
                {text}
                {i < progress.step ? " ✓" : i === progress.step ? " …" : ""}
              </li>
            ))}
          </ol>
        )}
      </div>
      {hits.length > 0 ? (
        <div className="panel security-box">
          <div className="security-title">
            <div>
              <h3>历史线索（{hits.length}）</h3>
              <p className="hint">
                这些是文本规则命中的历史线索，不代表操作执行成功、已造成损害或当前仍有风险。
                现在开启防护无法撤销历史操作；无需为这些记录重复开启防护，也无需通过“暂不处理”恢复分数。
              </p>
            </div>
          </div>
          {Object.entries(grouped).map(([tool, list]) => (
            <div className="retro-group" key={tool}>
              <h4>
                {TOOL_NAMES[tool as SecurityTool] ?? tool}
                <span>{list.length} 条</span>
              </h4>
              <ul className="retro-hits">
                {list.map((hit) => (
                  <li key={hit.id} className={`hit hit-${hit.level}`}>
                    <span className={`badge level-${hit.level}`}>
                      {hit.level === "high" ? "高" : hit.level === "medium" ? "中" : "低"}
                    </span>
                    <span className="hit-evidence">{hit.evidence}</span>
                    <small>
                      {hit.ruleId === "plaintext_secret" ? "疑似明文密钥" : RULE_TITLES[hit.ruleId] ?? hit.ruleId}
                      {hit.project ? ` · ${hit.project}` : ""}
                    </small>
                    <p className="hint">复核建议：{RETRO_REVIEW[hit.ruleId] ?? "核对原会话、执行结果与当前状态，确认是否存在实际影响。"}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}

        </div>
      ) : (
        !running && (
          <div className="panel security-box finding-empty">
            {report ? (
              <>
                <b>上次扫描未发现历史线索</b>
                <p>
                  已读取 {report.scannedFiles} 个会话文件。新会话产生后可再次扫描；
                  也可以在概览里点“立即体检”检查当前配置。
                </p>
              </>
            ) : (
              <>
                <b>还没有扫描过</b>
                <p>
                  点上方“开始扫描”，检查本机 AI 工具过去会话里的可疑线索。
                  扫描只读取会话记录，不会启动任何 AI 工具。
                </p>
              </>
            )}
          </div>
        )
      )}
    </>
  );
}
