import type { Evidence, Finding, Session } from "../../src/shared/types";
export function evaluate(session: Session): Finding[] {
  const findings: Finding[] = [];
  const es = session.evidence;
  const add = (
    ruleId: string,
    title: string,
    description: string,
    evidence: Evidence[],
    nextCheck: string,
    missing = ["目标应用实际代理、证书与请求上下文未获取。"],
    severity: Finding["severity"] = "warning",
  ) =>
    findings.push({
      id: `${session.id}-${ruleId}`,
      ruleId,
      version: 1,
      title,
      description,
      support: "limited",
      evidenceIds: evidence.map((e) => e.id),
      missing,
      nextCheck,
      severity,
    });
  const failed = (stage: Evidence["stage"]) =>
    es.filter((e) => e.stage === stage && e.status === "failed");
  const dns = failed("dns");
  if (dns.length && session.config.length)
    add(
      "R01",
      "诊断器的系统名称解析失败",
      "系统解析路径未返回可用地址；指定代理的远端解析结果应独立查看。",
      dns,
      "在目标终端检查 DNS 与域名拼写，然后重复诊断。",
      undefined,
      "error",
    );
  const direct = failed("tcp").filter(
    (e) => e.route === "direct" && e.code === "ETIMEDOUT",
  );
  const proxied = es.filter(
    (e) => e.stage === "tls" && e.route !== "direct" && e.status === "success",
  );
  if (direct.length && proxied.length)
    add(
      "R02",
      "直连与指定代理的探测路径存在差异",
      "同一目标的直连 TCP 超时，而指定代理的 TLS 已通过；尚不能确定目标客户端实际使用的路径。",
      [...direct, ...proxied],
      "在新的目标终端中显式指定该代理后重试，并记录应用结果。",
    );
  const proxyEndpoint = failed("tcp").filter((e) => e.route !== "direct");
  if (proxyEndpoint.length)
    add(
      "R03",
      "诊断器无法连接指定代理端点",
      "代理端口拒绝或连接失败；错误不等同于目标服务失败。",
      proxyEndpoint,
      "核对代理地址、端口和监听状态后重新探测。",
      undefined,
      "error",
    );
  const cert = failed("tls").filter((e) =>
    /CERT|SELF_SIGNED|ISSUER|VERIFY|ALTNAME/i.test(e.code || ""),
  );
  if (cert.length)
    add(
      "R04",
      "诊断器的 TLS 证书校验失败",
      "当前 Node 信任配置未通过证书验证；目标应用可能使用不同的证书库。",
      cert,
      "核对本机时间、证书链、主机名和企业根证书；保持证书验证开启。",
      undefined,
      "error",
    );
  const denied = es.filter(
    (e) => e.stage === "http" && [401, 403].includes(e.httpStatus || 0),
  );
  if (denied.length)
    add(
      "R05",
      "服务响应了诊断器的无认证请求",
      "本次请求收到 401 / 403，说明已到达应用层；不能据此判定用户令牌失效。",
      denied,
      "查看目标应用日志、权限和实际请求路径。",
    );
  const rate = es.filter((e) => e.httpStatus === 429);
  if (rate.length)
    add(
      "R06",
      "诊断器收到服务限流响应",
      "本次 HEAD 请求收到 HTTP 429。",
      rate,
      "参考 Retry-After 或稍后复测，避免连续请求。",
    );
  const tcp = es.filter((e) => e.stage === "tcp" && e.route === "direct");
  const v4 = tcp.find((e) => e.family === 4 && e.status === "success");
  const v6 = tcp.find((e) => e.family === 6 && e.status === "failed");
  if (v4 && v6)
    add(
      "R07",
      "诊断器观察到 IPv4 / IPv6 连接差异",
      "同一主机的 IPv4 TCP 建连成功而 IPv6 尝试失败；只覆盖所选两个候选地址。",
      [v4, v6],
      "在目标应用上下文复测地址族差异，先检查 IPv6 路由。",
    );
  const timeout = failed("tcp").filter((e) => e.code === "ETIMEDOUT");
  if (timeout.length && !proxied.length)
    add(
      "R08",
      "诊断器的 TCP 建连超时",
      "此次连接在预算内未完成；路由、过滤或远端服务均有可能。",
      timeout,
      "在相同网络下复测目标端口，并结合应用日志缩小范围。",
    );
  if (!findings.length) {
    const success = es.filter(
      (e) => e.stage === "http" && e.status === "success",
    );
    findings.push({
      id: `${session.id}-summary`,
      ruleId: "SUMMARY",
      version: 1,
      title: success.length
        ? "诊断器已收到目标 HTTP 响应"
        : "现有证据不足以定位原因",
      description: success.length
        ? "这证明诊断器此次路径到达了 HTTP 层；目标客户端仍需在原上下文复测。"
        : "没有规则取得足够支持。未执行、跳过或缺失的阶段不能视为通过。",
      support: success.length ? "limited" : "insufficient",
      evidenceIds: success.map((e) => e.id),
      missing: ["目标软件自身错误日志与受控复测结果。"],
      nextCheck: "复现目标软件的问题，并记录错误发生时刻与应用日志。",
      severity: "info",
    });
  }
  return findings;
}
