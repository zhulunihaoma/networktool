/**
 * Bounded shell context for reporting, never for allow/deny decisions.
 * Quoted arguments and heredoc bodies are data unless a shell explicitly runs
 * them. Unknown programs' source code is deliberately not interpreted as shell.
 */
export interface CommandContext {
  name: string;
  args: string[];
  readPaths: string[];
  writePaths: string[];
  stdin: string;
}

interface Token {
  text: string;
  operator?: boolean;
  body?: string;
}

function tokenize(text: string): { tokens: Token[]; nested: string[] } {
  const tokens: Token[] = [];
  const nested: string[] = [];
  const documents: { token: Token; tabs: boolean }[] = [];
  let word = "",
    started = false,
    quote = "";
  let delimiter: boolean | undefined;
  const flush = () => {
    if (!started) return;
    const token: Token = { text: word };
    tokens.push(token);
    if (delimiter !== undefined) {
      documents.push({ token, tabs: delimiter });
      delimiter = undefined;
    }
    word = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") {
      const next = text[i + 1];
      if (next === "\n") {
        i++;
        continue;
      }
      if (next && (!quote || /[\"\\$`]/.test(next))) {
        word += next;
        started = true;
        i++;
        continue;
      }
    }
    // Substitution executes even inside a double-quoted echo argument.
    if (quote !== "'" && (text.startsWith("$(", i) || c === "`")) {
      const backtick = c === "`";
      const start = i + (backtick ? 1 : 2);
      let end = start,
        depth = 1,
        innerQuote = "";
      for (; end < text.length; end++) {
        const ch = text[end];
        if (ch === "\\") {
          end++;
          continue;
        }
        if (backtick) {
          if (ch === "`") break;
          continue;
        }
        if (innerQuote) {
          if (ch === innerQuote) innerQuote = "";
          continue;
        }
        if (ch === "'" || ch === '"') {
          innerQuote = ch;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")" && --depth === 0) break;
      }
      if (end < text.length) nested.push(text.slice(start, end));
      word += "$(dynamic)";
      started = true;
      i = end;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      started = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "#" && !started) {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "\n") {
      flush();
      tokens.push({ text: "\n", operator: true });
      for (const doc of documents.splice(0)) {
        const lines: string[] = [];
        let found = false;
        while (i + 1 < text.length) {
          const start = i + 1;
          const end = text.indexOf("\n", start);
          const line = text.slice(start, end < 0 ? text.length : end);
          i = end < 0 ? text.length : end;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.token.text) {
            found = true;
            break;
          }
          lines.push(line);
        }
        if (found) doc.token.body = lines.join("\n");
      }
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    const op = text.slice(i).match(/^(?:<<<|<<-|<<|>>|&&|\|\||[;|&()<>])/);
    if (op) {
      flush();
      tokens.push({ text: op[0], operator: true });
      if (op[0] === "<<" || op[0] === "<<-") delimiter = op[0] === "<<-";
      i += op[0].length - 1;
      continue;
    }
    word += c;
    started = true;
  }
  flush();
  return { tokens, nested };
}

const base = (name: string) => name.split(/[\\/]/).pop() ?? name;

/** Only forwarding wrappers with known argument shapes are unwrapped. */
function unwrap(words: string[]): string[] {
  let next = [...words];
  for (let pass = 0; pass < 12 && next.length; pass++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next[0])) {
      next.shift();
      continue;
    }
    const name = base(next[0]);
    if (
      !/^(?:sudo|doas|env|command|builtin|exec|nohup|setsid|time|nice|timeout|stdbuf)$/.test(
        name,
      )
    )
      break;
    next.shift();
    while (next[0]?.startsWith("-")) {
      const option = next.shift()!;
      if (option === "--") break;
      if (
        (name === "sudo" &&
          /^(?:-u|-g|-h|-C|-p|--user|--group|--host|--chdir|--prompt)$/.test(
            option,
          )) ||
        (name === "doas" && /^(?:-u|-C)$/.test(option)) ||
        (name === "env" && /^(?:-u|-C|--unset|--chdir)$/.test(option)) ||
        (name === "nice" && /^(?:-n|--adjustment)$/.test(option)) ||
        (name === "timeout" &&
          /^(?:-s|-k|--signal|--kill-after)$/.test(option)) ||
        (name === "exec" && option === "-a")
      )
        next.shift();
    }
    if (name === "timeout") next.shift();
  }
  return next;
}

export function commandContexts(command: string, depth = 0): CommandContext[] {
  if (depth >= 8 || !command) return [];
  const { tokens, nested } = tokenize(command);
  const contexts: CommandContext[] = [];
  let words: string[] = [],
    readPaths: string[] = [],
    writePaths: string[] = [],
    stdin = "";
  const flush = () => {
    const actual = unwrap(words);
    const name = base(actual[0] ?? "");
    const args = actual.slice(1);
    if (actual.length || readPaths.length || writePaths.length) {
      contexts.push({ name, args, readPaths, writePaths, stdin });
      if (/^(?:ba|da|z|k)?sh$/.test(name)) {
        const index = args.findIndex((arg) =>
          /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg),
        );
        if (index >= 0 && args[index + 1])
          contexts.push(...commandContexts(args[index + 1], depth + 1));
        else if (stdin) contexts.push(...commandContexts(stdin, depth + 1));
      } else if (name === "eval") {
        contexts.push(...commandContexts(args.join(" "), depth + 1));
      }
    }
    words = [];
    readPaths = [];
    writePaths = [];
    stdin = "";
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.operator) {
      words.push(token.text);
      continue;
    }
    if (/^(?:<|>|>>|<<|<<-|<<<)$/.test(token.text)) {
      const target = tokens[i + 1];
      if (!target || target.operator) continue;
      i++;
      // A file descriptor immediately before a redirection is not an argument.
      if (/^\d+$/.test(words.at(-1) ?? "")) words.pop();
      if (token.text.startsWith("<<"))
        stdin += target.body ?? (token.text === "<<<" ? target.text : "");
      else if (target.text !== "/dev/null")
        (token.text === "<" ? readPaths : writePaths).push(target.text);
      continue;
    }
    flush();
  }
  flush();
  for (const text of nested) contexts.push(...commandContexts(text, depth + 1));
  return contexts;
}
