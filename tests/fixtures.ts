import type { Evidence, Session } from "../src/shared/types";
export function evidence(
  stage: Evidence["stage"],
  status: Evidence["status"],
  props: Partial<Evidence> = {},
): Evidence {
  return {
    id: `${stage}-${Math.random()}`,
    time: Date.now(),
    stage,
    status,
    route: "direct",
    title: "fixture",
    detail: "controlled fixture",
    source: "test",
    executor: "diagnostic_probe",
    ...props,
  };
}
export function fixture(props: Partial<Session> = {}): Session {
  return {
    id: "01999000-0000-4000-8000-000000000000",
    name: "受控测试",
    target: "https://localhost/",
    host: "localhost",
    port: 443,
    status: "completed",
    started: Date.now(),
    duration: 60,
    deadline: Date.now() + 60000,
    scope: [],
    mode: "diagnose",
    phase: "fixture",
    evidence: [],
    findings: [],
    flows: [],
    config: [{ name: "test", value: "read", source: "fixture", state: "read" }],
    coverage: {
      platform: "test",
      collector: "fixture",
      tcp: true,
      processes: true,
      version: "test",
      limitations: [],
    },
    markers: [],
    dropped: 0,
    sequence: 0,
    ...props,
  };
}
