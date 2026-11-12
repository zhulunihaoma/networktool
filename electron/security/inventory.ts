import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type {
  InventoryDiff,
  InventoryItem,
  SecurityTool,
} from "../../src/shared/security";
import {
  parseJsonc,
  readConfig,
  redactConfig,
  safeUrl,
  tomlSections,
} from "./config-read";

export async function collectInventory(home: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  const add = (
    tool: SecurityTool,
    kind: InventoryItem["kind"],
    name: string,
    target: string,
    source: string,
  ) =>
    items.push({
      id: `${tool}:${source}:${kind}:${name}`,
      tool,
      kind,
      name,
      target,
      source,
    });
  const jsonFile = async (tool: SecurityTool, source: string) => {
    const text = await readConfig(home, source);
    if (text === undefined) return;
    let root: any;
    try {
      root = parseJsonc(text);
    } catch {
      throw new Error(`${source} 解析失败，未更新基线。`);
    }
    add(
      tool,
      "config",
      source,
      createHash("sha256").update(text).digest("hex").slice(0, 16),
      source,
    );
    const servers = root.mcpServers ?? root.mcp ?? {};
    for (const [name, server] of Object.entries(servers)) {
      const clean = redactConfig(server) as any;
      const target =
        clean?.url ??
        clean?.serverUrl ??
        JSON.stringify({
          command: clean?.command,
          args: clean?.args,
          type: clean?.type,
        });
      add(tool, "mcp", name, String(target), source);
    }
    for (const [index, plugin] of (Array.isArray(root.plugin)
      ? root.plugin
      : []
    ).entries())
      add(
        tool,
        "plugin",
        `plugin-${index}`,
        JSON.stringify(redactConfig(plugin)),
        source,
      );
    const visit = (v: any, prefix: string, depth: number) => {
      if (!v || typeof v !== "object" || depth > 8) return;
      for (const [key, value] of Object.entries(v)) {
        if (
          /^(baseURL|base_url|endpoint)$/.test(key) &&
          typeof value === "string"
        )
          add(tool, "endpoint", `${prefix}${key}`, safeUrl(value), source);
        else if (value && typeof value === "object")
          visit(value, `${prefix}${key}.`, depth + 1);
      }
    };
    visit(root, "", 0);
  };
  const codexSource = ".codex/config.toml";
  const codex = await readConfig(home, codexSource);
  if (codex !== undefined) {
    add(
      "codex",
      "config",
      codexSource,
      createHash("sha256").update(codex).digest("hex").slice(0, 16),
      codexSource,
    );
    for (const section of tomlSections(codex)) {
      if (
        !section.name.startsWith("mcp_servers.") ||
        /\.env$/.test(section.name)
      )
        continue;
      const clean = redactConfig(section.values);
      add(
        "codex",
        "mcp",
        section.name.slice(12).replace(/^"|"$/g, ""),
        clean.url ??
          JSON.stringify({ command: clean.command, args: clean.args }),
        codexSource,
      );
    }
  }
  await jsonFile("claude", ".claude/settings.json");
  await jsonFile("claude", ".claude.json");
  await jsonFile("opencode", ".config/opencode/opencode.json");
  await jsonFile("opencode", ".config/opencode/opencode.jsonc");
  await jsonFile("zcode", ".zcode/v2/config.json");
  await jsonFile("zcode", ".zcode/cli/config.json");
  const source = ".dsh/profiles/desktop/cordis.patch.yml";
  const yaml = await readConfig(home, source);
  if (yaml !== undefined) {
    let rows: any;
    try {
      rows = parseYaml(yaml, {
        customTags: [
          { tag: "tag:yaml.org,2002:js", resolve: (v: string) => v },
        ],
      });
    } catch {
      throw new Error(`${source} 解析失败，未更新基线。`);
    }
    add(
      "dsh",
      "config",
      source,
      createHash("sha256").update(yaml).digest("hex").slice(0, 16),
      source,
    );
    const walk = (rows: any[]) => {
      for (const row of rows) {
        if (Array.isArray(row?.insert)) walk(row.insert);
        if (row?.config?.url || row?.config?.baseURL)
          add(
            "dsh",
            /mcp/.test(row.name) ? "mcp" : "endpoint",
            row.id ?? row.name,
            safeUrl(row.config.url ?? row.config.baseURL),
            source,
          );
      }
    };
    if (Array.isArray(rows)) walk(rows);
  }
  return items;
}
export function diffInventory(
  baseline: InventoryItem[] | undefined,
  current: InventoryItem[],
  baselineAt?: number,
): InventoryDiff {
  const previous = new Map((baseline ?? []).map((i) => [i.id, i]));
  const now = new Map(current.map((i) => [i.id, i]));
  return {
    baselineAt,
    checkedAt: Date.now(),
    added: current.filter((i) => !previous.has(i.id)),
    removed: (baseline ?? []).filter((i) => !now.has(i.id)),
    changed: current.filter(
      (i) => previous.has(i.id) && previous.get(i.id)!.target !== i.target,
    ),
    total: current.length,
  };
}
