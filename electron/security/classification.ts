import {
  DATA_LEVEL_LABELS,
  type DataLevel,
  type GuardFacts,
  type SecurityEvent,
} from "../../src/shared/security";
import type { GuardInput } from "./guard-protocol";
import { commandContexts, type CommandContext } from "./command-context";

/**
 * Data sensitivity derived from what the event already records.
 *
 * The chained log deliberately stores operation text, not file contents, so
 * this is a *path/verb* classifier, not a content scanner. It never reads
 * files and never leaves the machine; it only labels existing rows.
 */

export type { DataLevel };
export const LEVEL_LABELS = DATA_LEVEL_LABELS;

export interface ResourceClass {
  level: DataLevel;
  /** Hit rule ids, so the UI can say why rather than just assert a level. */
  hits: string[];
  kind?: string;
  /** Which signal decided it; "rule" means an existing guard rule already knew. */
  method: "rule" | "path" | "verb" | "facts" | "none";
}

const unique = (values: string[]) => [...new Set(values)];

const DB_CLIENT =
  /^(?:psql|mysql|mariadb|sqlite3?|sqlcmd|mongo|mongosh|redis-cli|clickhouse-client)$/;
const CLOUD_CLIENT =
  /^(?:kubectl|aws|gcloud|az|aliyun|tccli|hcloud|terraform|pulumi|helm)$/;
const NETWORK_CLIENT = /^(?:curl|wget|ssh|scp|rsync|rclone|sftp|ftp|nc|ncat)$/;
const FILE_READ =
  /^(?:cat|head|tail|less|more|grep|rg|awk|sed|cp|mv|ls|find|stat|du|wc|diff|strings|xxd|od|base64|source|\.)$/;
const FILE_WRITE = /^(?:tee|touch|mkdir|mv|cp|install|chmod|chown)$/;
const FILE_DELETE = /^(?:rm|rmdir|unlink|shred|truncate)$/;
const INTERPRETER = /^(?:bash|sh|zsh|dash|ksh|node|python3?|ruby|perl|php)$/;
const INFO_ONLY = /^(?:--help|-\?|--version|-version|-V)$/;

/** URL-looking request bodies and header values are not connection targets. */
function networkOperands({ name, args }: CommandContext): {
  urls: string[];
  paths: string[];
  operands: string[];
  flags: string[];
} {
  const urls: string[] = [],
    paths: string[] = [],
    operands: string[] = [],
    flags: string[] = [];
  const values =
    name === "curl"
      ? /^(?:-d|-F|-T|-H|-A|-e|-u|-U|-x|-o|-X|-r|--data(?:-ascii|-binary|-raw|-urlencode)?|--json|--form|--form-string|--upload-file|--header|--user-agent|--referer|--user|--proxy|--output|--request|--range|--url|--resolve|--connect-to|--max-time|--connect-timeout)$/
      : name === "wget"
        ? /^(?:-T|-U|-O|-o|-P|-i|-A|-R|-e|--timeout|--user-agent|--output-document|--output-file|--directory-prefix|--input-file|--accept|--reject|--execute|--post-data|--post-file|--body-data|--body-file|--method|--header|--user|--password)$/
        : /^(?:-P|-i|-o|-e|-l|-J|--port|--exclude|--include|--filter|--rsync-path)$/;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      operands.push(arg);
      if (/^https?:\/\//i.test(arg)) urls.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    let key = equal < 0 ? arg : arg.slice(0, equal);
    let value = equal < 0 ? undefined : arg.slice(equal + 1);
    if (name === "curl" && /^-[dFTH].+/.test(key)) {
      value = key.slice(2);
      key = key.slice(0, 2);
    }
    flags.push(key);
    if (name === "ssh" && key === "-p") {
      i++;
      continue;
    }
    if (!values.test(key)) continue;
    if (value === undefined) value = args[++i] ?? "";
    if (key === "--url") urls.push(value);
    if (
      (name === "curl" && /^(?:-T|--upload-file)$/.test(key)) ||
      /^(?:--post-file|--body-file)$/.test(key)
    )
      paths.push(value);
    else if (
      name === "curl" &&
      /^(?:-d|--data(?:-ascii|-binary|-urlencode)?|--json)$/.test(key) &&
      value.startsWith("@")
    )
      paths.push(value.slice(1));
    else if (name === "curl" && /^(?:-F|--form)$/.test(key)) {
      const file = value.match(/^[^=]+=[@<]([^;]+)/)?.[1];
      if (file) paths.push(file);
    }
  }
  return { urls, paths, operands, flags };
}

/** Skip search expressions, option values and inline source when finding paths. */
function fileOperands({ name, args }: CommandContext): string[] {
  const result: string[] = [];
  let pattern = /^(?:rg|grep|awk|sed)$/.test(name);
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) {
      if (
        /^(?:-e|--regexp|-f|--file)$/.test(arg) &&
        /^(?:rg|grep|awk|sed)$/.test(name)
      ) {
        if (arg === "-f" || arg === "--file") result.push(args[i + 1] ?? "");
        i++;
        pattern = false;
      } else if (
        /^(?:--regexp=|-e.)/.test(arg) &&
        /^(?:rg|grep|awk|sed)$/.test(name)
      )
        pattern = false;
      else if (
        /^(?:-g|--glob|--iglob|-t|--type|--type-not|--include|--exclude|-A|-B|-C|-m|--max-count|--lines|--bytes|--field-separator)$/.test(
          arg,
        ) ||
        (/^(?:head|tail)$/.test(name) && /^(?:-n|-c)$/.test(arg)) ||
        (name === "awk" && /^(?:-F|-v)$/.test(arg))
      )
        i++;
      continue;
    }
    if (pattern) {
      pattern = false;
      continue;
    }
    result.push(arg);
  }
  // Modes/owners are not files. This also keeps names such as "finance" in
  // `chown finance report.txt` from being labelled as business data.
  if (/^(?:chmod|chown)$/.test(name)) result.shift();
  return result.filter(Boolean);
}

function optionValues(args: string[], pattern: RegExp): string[] {
  return args.flatMap((arg, i) => {
    const equal = arg.indexOf("=");
    const key = equal < 0 ? arg : arg.slice(0, equal);
    return pattern.test(key)
      ? [equal < 0 ? (args[i + 1] ?? "") : arg.slice(equal + 1)]
      : [];
  });
}

function sqlText(context: CommandContext): string {
  const { name, args, stdin } = context;
  const queries = optionValues(
    args,
    /^(?:-c|-e|-Q|-q|--command|--execute|--query)$/,
  );
  if (/^sqlite3?$/.test(name)) {
    // SQLite: first positional argument is the database; subsequent ones are SQL.
    const positional = args.filter((arg) => !arg.startsWith("-"));
    queries.push(...positional.slice(1));
  }
  if (name === "redis-cli") {
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("-")) {
        if (
          /^(?:-h|-p|-a|-n|-u|--user|--pass|--askpass|--cert|--key|--cacert)$/.test(
            args[i],
          )
        )
          i++;
        continue;
      }
      queries.push(args[i]);
      break;
    }
  }
  return [...queries, stdin]
    .join("\n")
    .replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

const SQL_WRITE =
  /\b(?:insert|update|delete|alter|drop|truncate|grant|revoke|create|replace|merge|set|mset|del|hset|flushall|flushdb)\b/i;
const SQL_READ =
  /\b(?:select|describe|show|explain|pragma|get|mget|scan|keys|hget|hgetall)\b/i;
const SQL_DELETE = /\b(?:drop|delete|truncate|del|flushall|flushdb)\b/i;

/**
 * Classification decided at guard time, while the full input is still in hand.
 *
 * The chained log only stores this conclusion (`facts`), never the raw command,
 * so a later projection can label the event without re-guessing from a stunted
 * `operation` string. Kept free of file reads and network access.
 */
export function classifyInput(input: GuardInput, ruleId?: string): GuardFacts {
  const targets = [...(input.paths ?? []), ...(input.readPaths ?? [])];
  const urls = [...(input.urls ?? [])];
  const environments: string[] = [];
  const kinds: string[] = [];
  const hits: string[] = [];
  const verbs: string[] = [];
  let dbWrite = false,
    dbRead = false,
    upload = false;
  let level: DataLevel = "L1";
  const bump = (next: DataLevel, hit: string) => {
    if (LEVEL_ORDER.indexOf(next) > LEVEL_ORDER.indexOf(level)) level = next;
    if (!hits.includes(hit)) hits.push(hit);
  };

  if (targets.length) kinds.push("file");
  if (input.readPaths?.length) verbs.push("read");
  if (input.paths?.length) verbs.push("write");
  for (const context of commandContexts(input.command ?? "")) {
    const { name, args, readPaths, writePaths } = context;
    const network = NETWORK_CLIENT.test(name)
      ? networkOperands(context)
      : undefined;
    targets.push(...readPaths, ...writePaths);
    if (readPaths.length) {
      kinds.push("file");
      verbs.push("read");
    }
    if (writePaths.length) {
      kinds.push("file");
      verbs.push("write");
    }
    if (
      network
        ? network.flags.some((arg) => INFO_ONLY.test(arg))
        : (DB_CLIENT.test(name) || CLOUD_CLIENT.test(name)) &&
          args.some((arg) => INFO_ONLY.test(arg))
    )
      continue;
    if (INTERPRETER.test(name)) verbs.push("exec");
    if (
      FILE_READ.test(name) ||
      FILE_WRITE.test(name) ||
      FILE_DELETE.test(name)
    ) {
      // `cat <<EOF` reads supplied text, not a file mentioned in that text.
      const operands = fileOperands(context);
      if (operands.length || /^(?:rg|grep|ls|find|du)$/.test(name))
        kinds.push("file");
      targets.push(...operands);
      if (FILE_READ.test(name)) verbs.push("read");
      if (
        FILE_WRITE.test(name) ||
        (name === "sed" && args.some((arg) => /^-[a-z]*i/.test(arg)))
      )
        verbs.push("write");
      if (FILE_DELETE.test(name)) verbs.push("delete");
    }
    if (DB_CLIENT.test(name)) {
      kinds.push("db");
      verbs.push("exec");
      const sql = sqlText(context);
      if (SQL_READ.test(sql)) {
        dbRead = true;
        verbs.push("read");
      }
      if (SQL_WRITE.test(sql)) {
        dbWrite = true;
        verbs.push("write");
      }
      if (SQL_DELETE.test(sql)) verbs.push("delete");
      environments.push(
        ...optionValues(args, /^(?:-h|-H|-S|--host|--server|--uri|--url)$/),
        ...args.filter((arg) =>
          /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\//.test(arg),
        ),
      );
    }
    if (CLOUD_CLIENT.test(name)) {
      kinds.push("cloud");
      verbs.push("exec");
      const action =
        args[name === "aws" || name === "gcloud" || name === "az" ? 1 : 0] ??
        "";
      if (/^(?:get|list|describe|show|plan)(?:-|$)/.test(action))
        verbs.push("read");
      if (
        /^(?:create|apply|patch|update|set|edit|deploy|upgrade|install)(?:-|$)/.test(
          action,
        )
      )
        verbs.push("write");
      if (/^(?:delete|destroy|remove|rm)(?:-|$)/.test(action))
        verbs.push("delete");
      environments.push(
        ...optionValues(
          args,
          /^(?:-n|--namespace|--context|--cluster|--profile|--project)$/,
        ),
      );
    }
    if (network) {
      kinds.push("network");
      urls.push(...network.urls);
      if (network.paths.length) {
        kinds.push("file");
        verbs.push("read");
        targets.push(...network.paths);
      }
      if (name === "curl" || name === "wget") {
        const sendsBody = network.flags.some((flag) =>
          name === "curl"
            ? /^(?:-[dFT]|--(?:data(?:-ascii|-binary|-raw|-urlencode)?|json|form|form-string|upload-file))$/.test(
                flag,
              )
            : /^--(?:post-data|post-file|body-data|body-file)$/.test(flag),
        );
        if (sendsBody) {
          upload = true;
          verbs.push("upload");
        } else if (
          name === "wget" ||
          !args.some((arg) => /^(?:-I|--head)$/.test(arg))
        )
          verbs.push("download");
        else verbs.push("exec");
      } else {
        verbs.push("exec");
        // Direction is only claimed when the remote operand makes it explicit.
        if (/^(?:scp|rsync)$/.test(name)) {
          const operands = network.operands;
          const remote = (arg: string) => /^[^/\s]+:/.test(arg);
          if (remote(operands.at(-1) ?? "")) {
            upload = true;
            verbs.push("upload");
          } else if (remote(operands[0] ?? "")) verbs.push("download");
        }
      }
    }
  }
  if (urls.length) kinds.push("network");
  const text = targets.join(" ");
  if (targets.some((target) => SECRET_PATH.test(target))) {
    kinds.push("secret");
    bump("L4", "secret_path");
  }
  // Rule hits are stronger evidence than text heuristics.
  if (ruleId === "credential_read" || ruleId === "credential_write")
    bump("L4", ruleId);
  if (ruleId === "infra_destroy" || ruleId === "db_destroy") bump("L4", ruleId);
  if (ruleId === "cloud_delete") bump("L4", ruleId);
  if (ruleId === "prod_write") bump("L4", ruleId);
  if (ruleId === "protected_path_write") bump("L3", ruleId);
  if (ruleId === "obfuscated_exec") bump("L3", ruleId);

  const production = environments.some((value) => PROD_TARGET.test(value));
  if (production) bump("L3", "production_target");
  if (SENSITIVE_PATH.test(text)) bump("L3", "business_data");
  if (dbWrite) bump("L3", "db_write");
  if (dbRead && level === "L1") bump("L2", "db_read");
  if (upload) bump("L3", "outbound_upload");
  if (level === "L1" && kinds.length) bump("L2", "resource_touched");

  const hosts = unique(
    urls
      .map((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  ).slice(0, 10);
  return {
    classifierVersion: 2,
    level,
    kinds: unique(kinds),
    verbs: unique(verbs),
    ...(hosts.length ? { hosts } : {}),
    ...(production ? { env: "prod" as const } : {}),
    hits,
  };
}

/**
 * Credential-shaped paths, aligned with defaultPolicy().sensitivePaths.
 * Boundaries accept quotes, whitespace and shell punctuation so that
 * `cat .env > out` and `--file=.env` are both recognised.
 */
const SECRET_PATH =
  /(?:^|[\s"'`=/\\])(?:\.env(?:\.[\w-]+)?|[\w.-]+\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(?:\.json)?|auth\.json|\.ssh)(?=$|[\s"'`|&;:,)])/i;

/** Business data that is sensitive but usually not a credential. */
const SENSITIVE_PATH =
  /(?:客户|名单|合同|报价|财务|工资|薪酬)[^\s/\\]*|(?:^|[\s/\\])(?:salary|payroll|invoice|customers?|contracts?|pricing|finance|hr)(?:[._-][^\s/\\]*)?(?=$|[\s/\\])|\.(?:xlsx?|csv|sql)(?:$|\s)/i;

/** Production markers, matched as whole words so "product" does not count. */
const PROD_TARGET = /(?:^|[^a-z0-9])(?:prod|prd|production)(?:[^a-z0-9]|$)/i;

/**
 * Classify one event.
 * Rule hits outrank heuristics: if a guard rule already fired, that is stronger
 * evidence than pattern matching on the operation text.
 */
export function classifyResource(event: SecurityEvent): ResourceClass {
  // Events written by newer guards already carry the verdict taken while the
  // full input was available; prefer it over re-deriving from `operation`.
  if (event.facts)
    return {
      level: event.facts.level,
      hits: event.facts.hits,
      kind: event.facts.kinds[0],
      method: "facts",
    };
  // Old operation text may be truncated. Reuse the conservative parser and
  // never turn the free-form reason (which can quote examples) into a target.
  const operation = event.operation.replace(/^[\w_]+:\s*/, "");
  const isRead = /^(?:read|read_file|view)$/i.test(event.toolName);
  const derived = classifyInput(
    {
      tool: event.tool,
      ...(isRead ? { readPaths: [operation] } : { command: operation }),
    },
    event.ruleId,
  );
  const kind = derived.kinds[0];
  return {
    level: derived.level,
    hits: derived.hits,
    kind:
      (
        { db: "db_table", cloud: "cloud_resource", network: "url" } as Record<
          string,
          string
        >
      )[kind] ?? kind,
    method: event.ruleId
      ? "rule"
      : derived.hits.length
        ? "path"
        : kind
          ? "verb"
          : "none",
  };
}

/** Level ordering helper shared by the incident and UI layers. */
export const LEVEL_ORDER: DataLevel[] = ["L1", "L2", "L3", "L4"];
