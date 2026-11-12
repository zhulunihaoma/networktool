// Test-only preload: keep top-level fixtures that existing acceptance scripts
// normally delete. Nested deletes retain their original semantics.
import fs from 'node:fs/promises';
import path from 'node:path';
const base = process.env.NETWORK_LENS_EVIDENCE_DIR;
if (base) {
  const directories = new Set();
  const mkdtemp = fs.mkdtemp.bind(fs);
  const rm = fs.rm.bind(fs);
  fs.mkdtemp = async (...args) => {
    const result = await mkdtemp(...args);
    directories.add(path.resolve(String(result)));
    await fs.appendFile(path.join(base, 'retained-directories.jsonl'), JSON.stringify({ directory: String(result) }) + '\n');
    return result;
  };
  fs.rm = async (target, options) => {
    if (directories.has(path.resolve(String(target))) && options?.recursive) {
      await fs.appendFile(path.join(base, 'retained-directories.jsonl'), JSON.stringify({ retained: String(target) }) + '\n');
      return;
    }
    return rm(target, options);
  };
}
