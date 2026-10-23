// chunk-src.mjs — serialize lib sources as JSON chunks for verbatim retyping into cordis_define
// 用法：
//   node tools/chunk-src.mjs            重新生成 .chunks/host.txt + .chunks/client.txt
//   node tools/chunk-src.mjs --verify   只校验磁盘上的 chunk 是否与当前源码一致（不写盘，退出码反映结果）
// --verify 被 npm test / npm run check 调用，避免出现「源码已改、chunk 还是旧版」的静默漂移
// （v0.5.8 前 .chunks/host.txt 就曾比 lib/host.js 落后约 26%，按 README 方式 B 粘贴会装到旧宿主）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.chunks');
const verifyOnly = process.argv.slice(2).includes('--verify');

const targets = [
  ['host', 'lib/host.js'],
  ['client', 'lib/client.js'],
];

function framesOf(json) {
  const size = 1500;
  const lines = [];
  for (let i = 0; i < json.length; i += size) lines.push(json.slice(i, i + size));
  return lines.join('\n') + '\n';
}

if (!verifyOnly) mkdirSync(outDir, { recursive: true });

let ok = true;
for (const [key, rel] of targets) {
  const src = readFileSync(join(root, rel), 'utf8');
  const json = JSON.stringify(src);
  const expected = framesOf(json);
  if (verifyOnly) {
    let actual = null;
    try { actual = readFileSync(join(outDir, `${key}.txt`), 'utf8') } catch (err) { actual = null }
    if (actual === null) {
      ok = false;
      console.error(`${key}: MISSING .chunks/${key}.txt — run: node tools/chunk-src.mjs`);
    } else if (actual !== expected) {
      ok = false;
      console.error(`${key}: STALE .chunks/${key}.txt (disk ${actual.length} chars, expected ${expected.length}) — run: node tools/chunk-src.mjs`);
    } else {
      console.log(`${key}: up to date (${json.length} chars)`);
    }
    continue;
  }
  writeFileSync(join(outDir, `${key}.txt`), expected, 'utf8');
  const total = expected.split('\n').filter(Boolean).reduce((n, l) => n + l.length, 0);
  if (total !== json.length) {
    ok = false;
    console.error(`${key}: LENGTH MISMATCH ${total} vs ${json.length}`);
  } else {
    console.log(`${key}: ${json.length} chars, ${expected.split('\n').filter(Boolean).length} chunks`);
  }
}
if (ok) console.log(verifyOnly ? 'chunks OK' : 'OK');
process.exitCode = ok ? 0 : 1;
