import test from "node:test";
import assert from "node:assert/strict";
import { TEXT_PREVIEW_SIZE, textPreviewPage } from "../src/shared/text-preview";

test("bounded display pages reconstruct the complete Unicode handoff without replacement characters", () => {
  const text = "甲".repeat(TEXT_PREVIEW_SIZE - 1) + "😀" + "乙".repeat(TEXT_PREVIEW_SIZE - 2) + "🧑‍💻" + "尾部";
  const pages = Array.from({ length: textPreviewPage(text, 0).pages }, (_, page) => textPreviewPage(text, page).text);
  assert.equal(pages.join(""), text);
  for (const page of pages) {
    assert.equal(Buffer.from(page).toString(), page);
    assert(page.length <= TEXT_PREVIEW_SIZE + 1);
  }
  assert.equal(textPreviewPage(text, Number.MAX_SAFE_INTEGER).text, pages.at(-1));
});
