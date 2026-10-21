import { transferAttachments } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import { LocalHandoffHistory, nativeEntries, type HistoryRow } from "./local-handoff-history";
import { ClaudeHistory } from "./claude-history";
import { CodexHistory } from "./codex-history";
import { connectCodexAppServer } from "./codex-app-server";

export class WisCodeHistory extends LocalHandoffHistory {
  private claude: ClaudeHistory[];
  private codex: CodexHistory;
  private nativeHome: string;
  private engines = new Map<string, { engine: ClaudeHistory | CodexHistory; id: string }>();
  constructor(home = os.homedir()) {
    super("WisCode");
    this.claude = ["claude", "claude-agents"].map(name => new ClaudeHistory(path.join(home, ".wiscode", name, "projects"), 5000));
    const nativeHome = this.nativeHome = path.join(home, ".wiscode/codex-agents");
    this.codex = new CodexHistory(path.join(nativeHome, "sessions"), { client: () => connectCodexAppServer(nativeHome) });
  }
  async rows(): Promise<HistoryRow[]> {
    this.engines.clear();
    const rows = new Map<string, HistoryRow>();
    // Separate source identities: WisCode's managed profiles must not pollute native Codex / Claude tabs.
    for (const engine of this.claude) for (const task of await engine.list()) {
      const id = `claude:${task.id}`;
      const previous = rows.get(id);
      if (previous && previous.task.updated > task.updated) continue;
      rows.set(id, { task: { ...task, id }, engine: "Claude" }); this.engines.set(id, { engine, id: task.id });
    }
    if (!(await nativeEntries(this.nativeHome)).some(e => e.isFile() && /^state_\d+\.sqlite$/.test(e.name))) return [...rows.values()];
    let page = await this.codex.browse();
    for (;;) {
      for (const task of page.tasks) {
        const id = `codex:${task.id}`;
        rows.set(id, { task: { ...task, id }, engine: "Codex" }); this.engines.set(id, { engine: this.codex, id: task.id });
      }
      if (rows.size > 5000) throw new Error("WisCode 会话数量超出扫描预算。");
      if (!page.nextCursor) break;
      page = await this.codex.browse({ cursor: page.nextCursor });
    }
    return [...rows.values()];
  }
  protected async read(row: HistoryRow) {
    const selected = this.engines.get(row.task.id);
    if (!selected) throw new Error("WisCode 会话索引已失效，请刷新。");
    const value = await selected.engine.importSession(selected.id);
    if (!value.messageCount) throw new Error("所选 WisCode 会话没有可读取的可见正文。");
    return transferAttachments(value, { ...value, source: this.source, id: row.task.id, title: row.task.title, warnings: [`来源为 WisCode 独立的 ${row.engine} 引擎历史，不是原生客户端聊天。`, ...value.warnings] });
  }
}
