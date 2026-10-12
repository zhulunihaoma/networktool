import assert from "node:assert/strict";
import test from "node:test";
import { convertSkill, convertOpenaiMetadata } from "../electron/core/skill-compatibility";
const skill = (meta: string, body = "Original body\n") => `---\n${meta}\n---\n${body}`;

test("all host extensions and line endings are preserved byte for byte", () => {
  const text = '\uFEFF---\r\nname: helper\r\ndescription: helper\r\ndisable-model-invocation: true\r\nallowed-tools: [Read, Bash]\r\ncontext: fork\r\ncustom-field: value\r\n---\r\n# Body\r\n';
  for (const target of ["opencode", "cursor", "codex", "claude", "copilot", "gemini", "roocode", "agents", "wiscode"]) {
    const output = convertSkill(text, "helper", target, false, true);
    assert.equal(output.text, text);
    assert.deepEqual(output.changes, []);
  }
  assert.match(convertSkill(text, "helper", "opencode", false).warnings.join("\n"), /被忽略/);
});
test("malformed or missing required metadata is rejected without synthesizing content", () => {
  for (const meta of ["name: helper\nname: other\ndescription: helper", "- helper", "name: helper", "description: &desc helper\nname: *desc", "name: helper\ndescription: helper\nmetadata:\n  count: 1", "description: helper", "name: other\ndescription: helper"]) {
    assert.throws(() => convertSkill(skill(meta), "helper", "opencode", false));
  }
  const optional = skill("description: helper");
  assert.equal(convertSkill(optional, "helper", "claude", true).text, optional);
});
test("foreign syntax is reported without rewriting or claiming runtime support", () => {
  const text = skill("name: helper\ndescription: helper", "$ARGUMENTS ${CLAUDE_SKILL_DIR}\n");
  const result = convertSkill(text, "helper", "opencode", false);
  assert.equal(result.text, text);
  assert.match(result.warnings.join("\n"), /运行兼容性未通过/);
  assert.throws(() => convertSkill(text, "helper", "iflow", false), /未核实/);
});
test("sidecar policies and dependencies remain in their original file", () => {
  const text = "# comment\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: docs\n";
  for (const target of ["opencode", "cursor", "codex", "claude"]) {
    const result = convertOpenaiMetadata(text, target, true);
    assert.equal(result.text, text);
    assert.deepEqual(result.changes, []);
    assert.equal(result.instructions, "");
    assert.match(result.warnings.join("\n"), /依赖/);
  }
});
test("unreadable foreign sidecar is preserved with warning, native errors block", () => {
  const text = "[broken";
  assert.equal(convertOpenaiMetadata(text, "opencode").text, text);
  assert.match(convertOpenaiMetadata(text, "opencode").warnings.join(""), /无法解析/);
  assert.throws(() => convertOpenaiMetadata(text, "codex"));
});
