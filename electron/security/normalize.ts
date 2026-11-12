/**
 * Command normalisation for the pre-execution guard.
 *
 * The guard matches text, and text is easy to disguise: `te""rraform`,
 * `t\erraform`, `T=terraform; $T destroy`, `bash -c "…"`, or a base64 payload
 * piped into a shell all mean the same thing to a shell but look different to a
 * regexp. This module rewrites those forms back into the shape the rules expect
 * so one rule keeps covering the same intent.
 *
 * It never executes anything and never touches the network. When the command
 * word itself cannot be resolved it reports `dynamic` instead of guessing, and
 * the guard refuses that rather than auditing a lie.
 */

export interface NormalizedCommand {
  /** Rewritten text, safe to run the existing pattern rules against. */
  text: string;
  /** Text differs from the input, i.e. some disguise was undone. */
  changed: boolean;
  /** What will run cannot be determined statically. */
  dynamic: boolean;
  /** Short machine tags explaining `dynamic`. */
  traces: string[];
}

const MAX_PASSES = 4;

/**
 * Wrappers that only forward to another command. Each pattern must consume its
 * own arguments; `timeout 30 npm test` keeps `npm test`, not `npm`.
 */
const WRAPPERS: RegExp[] = [
  /^(?:sudo|doas)\s+(?:-\S+\s+)*/,
  /^command\s+(?:-p\s+|--\s+)?/,
  /^builtin\s+/,
  /^nohup\s+(?:--\s+)?/,
  /^setsid\s+(?:-\S+\s+)*/,
  /^time\s+(?:-p\s+)?/,
  /^nice\s+(?:-n\s*-?\d+|-\d+|--adjustment=\S+)\s+/,
  /^stdbuf\s+(?:-\S+\s+)*/,
  /^timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/,
  /^xargs\s+(?:-\S+\s+)*/,
  /^env\s+(?:-\S+\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/,
];

const SHELL_NAME = "(?:bash|sh|zsh|dash|ksh)";
/** `bash -c '…'` / `sh -lc "…"` */
const SHELL_C = new RegExp(
  `${SHELL_NAME}\\s+(?:-[a-zA-Z]+\\s+)*-[a-zA-Z]*c[a-zA-Z]*\\s+(['"])([\\s\\S]*?)\\1`,
  "g",
);
/** `bash <<< "…"` / `sh <<EOF` is left alone: rules already see the text. */
const EVAL = /(?:^|[\s;&|(])eval\s+(?:(["'])([\s\S]*?)\1|([^\n;&|]+))/g;
const B64_DECODE =
  /(?:echo|printf)\s+(?:-n\s+)?(['"]?)([A-Za-z0-9+/=]{8,})\1\s*\|\s*base64\s+(?:-d|--decode|-D)\b/g;
/**
 * Assignment values stop at shell punctuation, otherwise `T=terraform;` would
 * expand to `terraform;` and inject an extra separator into the command.
 */
const ASSIGN =
  /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;

const decodeBase64 = (value: string): string | undefined => {
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    // Reject binary blobs: they are not a command we can read.
    if (!text || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
};

/** Undo one layer of shell wrapping. */
function unwrapOnce(text: string): { text: string; hit: boolean } {
  let hit = false;
  let next = text.replace(
    SHELL_C,
    (_full: string, _quote: string, inner: string) => {
      hit = true;
      return inner;
    },
  );
  next = next.replace(
    EVAL,
    (_full: string, _quote: string | undefined, quoted: string, bare: string) => {
      hit = true;
      return quoted ?? bare;
    },
  );
  return { text: next, hit };
}

/** Decode base64 payloads that are about to be executed. */
function expandBase64(text: string): { text: string; hit: boolean } {
  const decoded: string[] = [];
  const next = text.replace(
    B64_DECODE,
    (full: string, _q: string, payload: string) => {
      const value = decodeBase64(payload);
      if (value === undefined) return full;
      decoded.push(value);
      return value;
    },
  );
  return decoded.length
    ? { text: `${next}\n${decoded.join("\n")}`, hit: true }
    : { text, hit: false };
}

/** Expand variables assigned earlier in the same command line. */
function expandVariables(text: string): { text: string; changed: boolean } {
  const values = new Map<string, string>();
  for (const match of text.matchAll(ASSIGN)) {
    const [, name, raw] = match;
    if (!name || raw === undefined) continue;
    const value = raw.replace(/^["']|["']$/g, "");
    if (!values.has(name)) values.set(name, value);
  }
  if (!values.size) return { text, changed: false };
  let changed = false;
  let next = text;
  // Two passes cover `A=x; B=$A; $B destroy`.
  for (let pass = 0; pass < 2; pass++) {
    next = next.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (full: string, braced?: string, bare?: string) => {
        const value = values.get(braced ?? bare ?? "");
        if (value === undefined) return full;
        changed = true;
        return value;
      },
    );
  }
  return { text: next, changed };
}

/** Remove quoting that splits a single word, e.g. te""rraform or t\erraform. */
function collapseQuotes(text: string): { text: string; changed: boolean } {
  const next = text
    .replace(/\\([\s"'`\\$])/g, "$1")
    .replace(/''/g, "")
    .replace(/""/g, "");
  // `t\erraform` is one shell escape; `C:\tmp\a.txt` is a real path. Only strip
  // the backslash in tokens that are not path shaped.
  const unescaped = next.replace(/\S+/g, (token) => {
    if (/^[A-Za-z]:\\/.test(token) || (token.match(/\\/g)?.length ?? 0) > 1)
      return token;
    return token.replace(/([^:])\\([A-Za-z])/g, "$1$2");
  });
  return { text: unescaped, changed: unescaped !== text };
}

const SEPARATOR = /(\n|&&|\|\||;|\|(?!\|))/;

/** Leading wrappers carry no intent; strip them per command segment. */
function stripWrappers(text: string): { text: string; changed: boolean } {
  let changed = false;
  const next = text
    .split(SEPARATOR)
    .map((part) => {
      if (!part || SEPARATOR.test(part)) return part;
      let value = part.replace(/^\s+/, "");
      const indent = part.slice(0, part.length - value.length);
      for (let i = 0; i < MAX_PASSES; i++) {
        const wrapper = WRAPPERS.find((re) => re.test(value));
        if (!wrapper) break;
        value = value.replace(wrapper, "");
      }
      if (value !== part.replace(/^\s+/, "")) changed = true;
      return indent + value;
    })
    .join("");
  return { text: next, changed };
}

/**
 * A command word that is still dynamic after normalisation cannot be audited by
 * any static rule. Command substitution in *arguments* (`docker ps -q $(…)`) is
 * ordinary usage and deliberately not flagged.
 */
function findDynamic(text: string): string[] {
  const traces = new Set<string>();
  const parts = text.split(SEPARATOR);
  parts.forEach((segment, index) => {
    if (!segment || SEPARATOR.test(segment)) return;
    const command = segment.trim().replace(/^(?:[(){}!]\s*)+/, "");
    if (!command) return;
    const word = command.split(/\s+/)[0] ?? "";
    const unquoted = word.replace(/^["']/, "");
    if (unquoted.startsWith("$(") || unquoted.startsWith("`"))
      traces.add("command_substitution_exec");
    else if (/^\$\{?[A-Za-z_]/.test(unquoted)) traces.add("variable_command");
    // Data decoded or generated on the fly and piped straight into a shell:
    // only a human can say whether that payload is safe.
    if (
      index > 0 &&
      /^(?:ba|z|d|k)?sh$/.test(word) &&
      parts
        .slice(0, index)
        .join("")
        .match(/base64\s+(?:--decode|-d|-D)|xxd\s+-r|openssl\s+enc\s+-d/)
    )
      traces.add("stdin_script");
  });
  return [...traces];
}

export function normalizeCommand(command: string): NormalizedCommand {
  let text = command;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const wrapped = unwrapOnce(text);
    if (!wrapped.hit) break;
    text = wrapped.text;
  }
  text = expandBase64(text).text;
  text = expandVariables(text).text;
  text = collapseQuotes(text).text;
  text = stripWrappers(text).text;
  const traces = findDynamic(text);
  return {
    text,
    changed: text !== command,
    dynamic: traces.length > 0,
    traces,
  };
}
