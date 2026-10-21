/** Incremental JSON/JSONL syntax validation. Large string values are streamed. */
export type JsonPath = (string | number)[];
export interface JsonObserver {
  object?(path: JsonPath, end: boolean): void;
  stringStart?(path: JsonPath): boolean;
  stringChunk?(path: JsonPath, text: string, end: boolean): void;
}
export class JsonStreamValidator {
  private stack: {
    kind: "object" | "array";
    state: string;
    path: JsonPath;
    key?: string;
    index: number;
  }[] = [];
  private string?: {
    key: boolean;
    escape: boolean;
    unicode: number;
    unicodeText: string;
    text: string;
    path: JsonPath;
    watch: boolean;
  };
  private token?: { word?: string; at: number; number?: string };
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private separator = false;
  values = 0;
  constructor(private observer?: JsonObserver) {}
  private valuePath(): JsonPath {
    const f = this.stack.at(-1);
    return f ? [...f.path, f.kind === "array" ? f.index : f.key || ""] : [];
  }
  private done() {
    const f = this.stack.at(-1);
    if (f) {
      f.state = "comma";
      if (f.kind === "array") f.index++;
    } else {
      this.values++;
      this.separator = true;
    }
  }
  private append(text: string) {
    const s = this.string!;
    if (s.key) {
      if (s.text.length < 4096) s.text += text;
    } else if (s.watch) {
      s.text += text;
      if (s.text.length >= 16384) {
        let end = s.text.length;
        if (/[\ud800-\udbff]/.test(s.text[end - 1])) end--;
        this.observer?.stringChunk?.(s.path, s.text.slice(0, end), false);
        s.text = s.text.slice(end);
      }
    }
  }
  private number(state: string, c: string): string | undefined {
    if (state === "minus")
      return c === "0" ? "zero" : /[1-9]/.test(c) ? "int" : undefined;
    if (state === "zero")
      return c === "." ? "dot" : /[eE]/.test(c) ? "exponent" : undefined;
    if (state === "int")
      return /[0-9]/.test(c)
        ? "int"
        : c === "."
          ? "dot"
          : /[eE]/.test(c)
            ? "exponent"
            : undefined;
    if (state === "dot") return /[0-9]/.test(c) ? "fraction" : undefined;
    if (state === "fraction")
      return /[0-9]/.test(c)
        ? "fraction"
        : /[eE]/.test(c)
          ? "exponent"
          : undefined;
    if (state === "exponent")
      return /[+-]/.test(c) ? "sign" : /[0-9]/.test(c) ? "exp-int" : undefined;
    if (state === "sign") return /[0-9]/.test(c) ? "exp-int" : undefined;
    if (state === "exp-int") return /[0-9]/.test(c) ? "exp-int" : undefined;
  }
  private finishToken() {
    if (!this.token) return;
    const t = this.token;
    if (
      t.word
        ? t.at !== t.word.length
        : !["zero", "int", "fraction", "exp-int"].includes(t.number || "")
    )
      throw new Error("来源 JSON 原始记录不完整。");
    this.token = undefined;
    this.done();
  }
  write(buffer: Uint8Array) {
    this.consume(this.decoder.decode(buffer, { stream: true }));
  }
  private consume(text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.string) {
        const s = this.string;
        if (s.unicode) {
          if (!/[a-fA-F0-9]/.test(c))
            throw new Error("来源 JSON Unicode 转义损坏。");
          s.unicodeText += c;
          if (!--s.unicode) {
            this.append(String.fromCharCode(parseInt(s.unicodeText, 16)));
            s.unicodeText = "";
          }
          continue;
        }
        if (s.escape) {
          s.escape = false;
          if (c === "u") s.unicode = 4;
          else if (!'"\\/bfnrt'.includes(c))
            throw new Error("来源 JSON 字符串转义损坏。");
          else
            this.append(
              (
                { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<
                  string,
                  string
                >
              )[c] || c,
            );
          continue;
        }
        if (c === "\\") {
          s.escape = true;
          continue;
        }
        if (c === '"') {
          if (s.key) this.stack.at(-1)!.key = s.text;
          else if (s.watch) this.observer?.stringChunk?.(s.path, s.text, true);
          this.string = undefined;
          if (s.key) this.stack.at(-1)!.state = "colon";
          else this.done();
          continue;
        }
        if (c.charCodeAt(0) < 32)
          throw new Error("来源 JSON 字符串包含未转义控制字符。");
        this.append(c);
        continue;
      }
      if (this.token) {
        const t = this.token;
        if (t.word && t.at < t.word.length) {
          if (c !== t.word[t.at++]) throw new Error("来源 JSON 字面值损坏。");
          continue;
        }
        if (t.number && /[0-9.eE+-]/.test(c)) {
          const next = this.number(t.number, c);
          if (!next) throw new Error("来源 JSON 数值损坏。");
          t.number = next;
          continue;
        }
        this.finishToken();
        i--;
        continue;
      }
      if (c === " " || c === "\n" || c === "\r" || c === "\t") {
        if (!this.stack.length) this.separator = false;
        continue;
      }
      if (!this.stack.length && this.separator)
        throw new Error("来源 JSON 多条记录之间缺少分隔符。");
      const f = this.stack.at(-1),
        state = f?.state || "value";
      if (f?.kind === "object" && (state === "key" || state === "key-or-end")) {
        if (c === '"') {
          this.string = {
            key: true,
            escape: false,
            unicode: 0,
            unicodeText: "",
            text: "",
            path: [],
            watch: false,
          };
          continue;
        }
        if (c === "}" && state === "key-or-end") {
          this.observer?.object?.(f.path, true);
          this.stack.pop();
          this.done();
          continue;
        }
        throw new Error("来源 JSON 对象键不完整。");
      }
      if (state === "colon") {
        if (c !== ":") throw new Error("来源 JSON 对象缺少冒号。");
        f!.state = "value";
        continue;
      }
      if (state === "comma") {
        if (c === ",") {
          f!.state = f!.kind === "object" ? "key" : "value";
          continue;
        }
        if (c === (f!.kind === "object" ? "}" : "]")) {
          if (f!.kind === "object") this.observer?.object?.(f!.path, true);
          this.stack.pop();
          this.done();
          continue;
        }
        throw new Error("来源 JSON 对象或数组缺少分隔符。");
      }
      if (f?.kind === "array" && state === "value-or-end" && c === "]") {
        this.stack.pop();
        this.done();
        continue;
      }
      if (c === "{") {
        const p = this.valuePath();
        this.observer?.object?.(p, false);
        this.stack.push({
          kind: "object",
          state: "key-or-end",
          path: p,
          index: 0,
        });
        continue;
      }
      if (c === "[") {
        this.stack.push({
          kind: "array",
          state: "value-or-end",
          path: this.valuePath(),
          index: 0,
        });
        continue;
      }
      if (c === '"') {
        const p = this.valuePath();
        this.string = {
          key: false,
          escape: false,
          unicode: 0,
          unicodeText: "",
          text: "",
          path: p,
          watch: !!this.observer?.stringStart?.(p),
        };
        continue;
      }
      if (c === "t" || c === "f" || c === "n") {
        this.token = {
          word: c === "t" ? "true" : c === "f" ? "false" : "null",
          at: 1,
        };
        continue;
      }
      if (c === "-" || /[0-9]/.test(c)) {
        this.token = {
          number: c === "-" ? "minus" : c === "0" ? "zero" : "int",
          at: 0,
        };
        continue;
      }
      throw new Error("来源 JSON 包含未知或损坏内容。");
    }
  }
  end() {
    this.consume(this.decoder.decode());
    this.finishToken();
    if (this.string || this.stack.length)
      throw new Error("来源 JSON 尾部尚未写完或记录损坏。");
  }
}
