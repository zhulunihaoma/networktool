import {
  ipPathSummary,
  type IPPathReport,
  type IPv6RepairPlan,
} from "./shared/ip-path";

export default function NetworkPathDetails({
  report,
  recovery,
}: {
  report: IPPathReport;
  recovery?: IPv6RepairPlan;
}) {
  const plan = report.repair;
  return (
    <section className="ip-path-details" aria-label="IPv4 与 IPv6 路径对照">
      <strong>IPv4 / IPv6 与 VPN 路径</strong>
      <p>{ipPathSummary(report)}</p>
      <small>
        检测对象：{report.host}。请在出现问题的热点下检查，并保持 VPN 连接。
      </small>
      {report.attempts.length > 0 && (
        <div className="ip-path-table-wrap">
          <table>
            <caption>本次补充直连探测，不代表应用的代理或账号状态</caption>
            <thead>
              <tr>
                <th>协议</th>
                <th>路由接口</th>
                <th>TCP</th>
                <th>TLS</th>
                <th>响应</th>
              </tr>
            </thead>
            <tbody>
              {report.attempts.map((a, index) => (
                <tr key={index}>
                  <td>IPv{a.family}</td>
                  <td>{a.interface || "未取得"}</td>
                  <td>{a.tcp ? "已连接" : "未完成"}</td>
                  <td>{a.tls ? "已完成" : "未完成"}</td>
                  <td>
                    {a.httpStatus ? `HTTP ${a.httpStatus}` : a.code || "未取得"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        HTTP 401 / 403
        只说明服务作出了响应；是否能登录、连续回复和保持任务连接，需要在原工具中确认。
      </p>
      {plan && (
        <section className="ip-path-repair" aria-label="可恢复的 IPv6 修复方案">
          <strong>建议先验证：仅使用本地链路 IPv6</strong>
          <p>
            已记录网络服务“{plan.service.name}”的原 IPv6
            设置：自动。此设置会持续影响该服务连接的所有 Wi-Fi，可能影响需要公网
            IPv6 的服务。工具只提供命令，不自动修改系统。
          </p>
          <p>先保存恢复命令，再在本机终端单独执行修复命令：</p>
          <pre>
            <code>{plan.command}</code>
          </pre>
          <p>
            重新连接
            VPN，确认电脑仍连接故障热点，点击“处理后重新检查”，并在原工具连续测试消息。如果无改善或需要恢复原设置，执行：
          </p>
          <pre>
            <code>{plan.restoreCommand}</code>
          </pre>
          <small>
            修复命令和恢复命令分别执行，不要一起粘贴运行。管理员密码只在本机系统终端输入。
          </small>
        </section>
      )}
      {recovery && (
        <section
          className="ip-path-repair"
          aria-label="先前记录的 IPv6 恢复方案"
        >
          <strong>已检测到仅本地链路 IPv6 设置</strong>
          <p>同一排查窗口先前记录的原设置为自动。需要恢复时，在终端执行：</p>
          <pre>
            <code>{recovery.restoreCommand}</code>
          </pre>
          <small>
            关闭窗口后，此临时排查记录不会保留，请复制报告保存恢复方案。
          </small>
        </section>
      )}
      {!plan && !recovery && report.service?.method === "LinkLocal" && (
        <p>
          当前网络服务已经设置为仅本地链路
          IPv6；本次没有记录修改前的配置，不能推断原设置。
        </p>
      )}
      {!plan && report.attempts.some((a) => a.family === 6) && (
        <small>
          只有 IPv4 经隧道完成 TLS、已测 IPv6 经其他接口全部失败，且原 Wi-Fi
          设置可确认时，才提供此修复方案。
        </small>
      )}
    </section>
  );
}
