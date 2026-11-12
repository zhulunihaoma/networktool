// Symptom-first index of the network problems users most often report with
// agent tools (Codex, Claude Code, ZCode, WisCode, OpenCode, Cursor, …).
// Each entry includes manual checks and a way to verify recovery.
// Reading these instructions never starts a probe or changes configuration.
export interface CommonNetworkIssue {
  id: string;
  symptom: string;
  classification: string;
  explanation: string;
  step: string;
  checks: readonly string[];
  expected: string;
  unresolved: string;
}

export const COMMON_NETWORK_ISSUES: readonly CommonNetworkIssue[] = [
  {
    id: "cli-proxy-env",
    symptom: "浏览器能打开，CLI 工具却连不上",
    classification: "CLI 代理配置作用域",
    explanation:
      "浏览器、桌面应用和终端可能使用不同的代理。Codex CLI、Claude Code、OpenCode 等工具的代理支持也可能不同。",
    step: "代理与 VPN 入口",
    checks: [
      "确认原工具实际使用的 API 域名或中转地址，再在本页查看对应服务的网络详情。",
      "在启动工具的终端核对 HTTPS_PROXY、HTTP_PROXY、ALL_PROXY、NO_PROXY 及工具自身的代理设置；确认端口与代理客户端一致。",
      "按该工具支持的方式设置代理后，新开终端或重启工具，用同一条请求复测。",
    ],
    expected: "原工具能完成原来的请求；浏览器能打开页面只能作为对照。",
    unresolved:
      "打开顺序排查，比较系统网络、直连与代理路径，并记录原工具的错误信息。",
  },
  {
    id: "cert-divergence",
    symptom: "工具报 certificate verify failed / 自签证书错误，浏览器却正常",
    classification: "证书信任分歧",
    explanation:
      "系统、浏览器和工具运行时可能使用不同的证书信任库；系统时间、企业代理证书或服务端证书异常都可能导致 TLS 失败。",
    step: "安全连接与平台响应",
    checks: [
      "核对系统日期、时间和时区，查看网络详情中 TLS 阶段的具体错误。",
      "若使用公司代理，向管理员确认是否需要企业根证书，并按原工具的官方方式配置受信任证书。",
      "重启原工具后重试，保持证书校验开启，不使用跳过 TLS 校验作为修复。",
    ],
    expected:
      "TLS 连接通过，原工具不再出现 certificate verify failed 或自签证书错误。",
    unresolved: "将证书错误、目标域名和发生时间交给管理员核对证书链。",
  },
  {
    id: "http-429",
    symptom: "请求返回 429，或提示限速 / 配额不足",
    classification: "服务限流（HTTP 429）",
    explanation:
      "HTTP 429 表示请求受到限流，也可能伴随配额或风控提示。需要结合原工具的响应内容判断，无凭据探测无法确认账户额度。",
    step: "安全连接与平台响应",
    checks: [
      "在原工具查看完整错误，区分请求频率限制与额度、余额或套餐限制。",
      "减少并发与自动重试；若响应给出 Retry-After，按提示等待后再试。",
      "在对应服务控制台核对账户额度和模型限额；使用中转时也核对中转侧限制。",
    ],
    expected: "等待或处理额度后，原工具中的单次请求能正常完成。",
    unresolved:
      "保留脱敏后的错误类型、请求 ID 和时间，向服务提供方确认限制原因。",
  },
  {
    id: "proxy-407",
    symptom: "公司网络返回 407 Proxy Authentication Required",
    classification: "代理需要凭据",
    explanation:
      "HTTP 407 表示代理要求认证。收到代理响应不代表代理已能连接目标服务。",
    step: "代理与 VPN 入口",
    checks: [
      "确认配置的代理主机与端口属于当前公司网络，核对账户是否过期。",
      "按公司要求在原工具或受管代理客户端完成认证；确认原工具支持相应认证方式。",
      "认证后在原工具重试，请勿把代理密码填写到网络检查或反馈报告里。",
    ],
    expected: "原工具不再收到 407，并能访问目标服务。",
    unresolved:
      "向管理员提供代理地址、工具名称和 407 错误，确认认证方式是否兼容。",
  },
  {
    id: "reconnecting",
    symptom: "入口能打开，但对话中一直 Reconnecting、流式输出中断",
    classification: "持续会话未验证",
    explanation:
      "单次入口检查不能验证长连接或流式会话。网络切换、代理超时与服务响应异常都需要结合中断时刻核对。",
    step: "持续使用与重连观察",
    checks: [
      "先在原工具复现，记录中断时间、任务持续时长及错误信息。",
      "打开顺序排查，完成检查后使用“观察重连（60 秒）”，在原工具重试，并在中断时标记时刻。",
      "核对中断前后是否切换 Wi-Fi、VPN 或代理节点；保持同一路径再次运行原任务。",
    ],
    expected: "原工具能持续完成原任务，且在原先发生中断的时段内保持正常。",
    unresolved:
      "结合观察记录与原工具日志继续定位；采样中的连接数量不能单独证明会话稳定。",
  },
  {
    id: "dns-hijack",
    symptom: "域名解析失败，或解析到异常地址",
    classification: "DNS 与本机域名映射",
    explanation:
      "ENOTFOUND、NXDOMAIN 或解析超时需要先核对域名和解析器。0.0.0.0、127.x 等结果也可能来自 hosts、安全软件或有意配置的本机映射，不能直接认定被劫持。",
    step: "域名解析",
    checks: [
      "确认原工具的服务域名拼写正确，未把模型名或多余路径填入主机地址。",
      "在顺序排查的“域名解析”中查看结果，区分域名不存在、解析超时与异常地址。",
      "核对 hosts、VPN 的 DNS 与安全软件拦截记录；公司网络先请管理员确认，再调整解析设置。",
    ],
    expected:
      "域名能按预期解析，且原工具请求成功；只看到解析地址不代表服务已经可用。",
    unresolved: "提供域名、解析错误和当前网络环境，请管理员核对解析策略。",
  },
  {
    id: "connection-timeout",
    symptom: "连接超时、连接被拒绝，或所有服务都失败",
    classification: "基础网络与代理端口",
    explanation:
      "ETIMEDOUT、ECONNREFUSED 或连接重置可能发生在本机网络、代理或目标服务，需要先确认失败范围。",
    step: "基础网络、代理与 VPN 入口",
    checks: [
      "确认电脑已联网，若网络需要网页登录，先完成认证；对照其他常用网站是否可用。",
      "若配置了本地代理，确认代理客户端正在运行、监听端口与工具配置一致。",
      "查看对应服务的“网络详情”，比较各条路径；只在允许的网络环境中更换网络对照复测。",
    ],
    expected: "对应路径收到服务响应，且原工具原来的请求能完成。",
    unresolved: "打开顺序排查，先处理基础网络或代理入口提示，再检查目标服务。",
  },
  {
    id: "auth-access",
    symptom: "网络已连通，工具仍报 401 / 403 / 451",
    classification: "认证、权限与访问限制",
    explanation:
      "无凭据检查收到 401 可以说明路径已通；原工具中的认证、模型权限及访问限制需要单独确认。",
    step: "安全连接与平台响应",
    checks: [
      "先区分错误来自本页的无凭据检查，还是原工具实际请求；本页不会验证密钥有效性。",
      "原工具返回 401 时，核对当前登录账户或 API Key 是否有效，以及服务地址与凭据是否匹配。",
      "返回 403 / 451 时，查看响应来源与具体提示，核对模型权限、组织权限及服务访问策略；中转也可能返回这些状态。",
    ],
    expected: "原工具获得预期响应；本页的绿色连通状态不能代替账户与模型验证。",
    unresolved:
      "向服务提供方提交脱敏后的状态码、错误内容与请求 ID，不附带完整密钥。",
  },
  {
    id: "service-error",
    symptom: "返回 500 / 502 / 503 / 504，服务暂时不可用",
    classification: "服务或网关异常",
    explanation:
      "HTTP 5xx 可能来自目标服务、中转或代理网关，单次失败无法判断整个服务是否故障。",
    step: "安全连接与平台响应",
    checks: [
      "核对原工具实际请求的是官方服务还是中转，记录状态码、发生时间和请求 ID。",
      "暂停连续重试，稍后用单个请求复测；查看对应服务的官方状态说明。",
      "若仅中转路径失败，向中转维护方核对上游连接与超时记录。",
    ],
    expected: "同一服务的请求恢复正常，原工具任务能完成。",
    unresolved:
      "携带脱敏错误联系服务或网关维护方，避免仅凭本次结果判断全球故障。",
  },
  {
    id: "slow-response",
    symptom: "能连接，但响应很慢或偶发卡住",
    classification: "路径延迟与请求耗时",
    explanation:
      "连接耗时与模型生成耗时不同；代理绕行、网络波动、服务排队及任务大小都需要分别核对。",
    step: "安全连接与平台响应、持续使用与重连观察",
    checks: [
      "查看网络详情，确认延迟出现在 DNS、连接或 TLS 阶段，还是原工具等待模型响应时。",
      "保持同一模型和网络，先用短请求复测，减少并发，记录首次响应与任务完成时间。",
      "在顺序排查中查看路径对比及 IPv4 / IPv6 证据；按检测建议处理后再复测。",
    ],
    expected: "原工具的短请求与原任务都能在可接受时间内完成。",
    unresolved:
      "记录网络路径、模型、请求规模与时间，结合原工具日志核对，避免仅凭入口延迟推断模型速度。",
  },
];
