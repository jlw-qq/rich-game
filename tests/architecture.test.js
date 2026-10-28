/**
 * 分层约束测试：data / logic 层不得依赖表现层或浏览器 API。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** 递归列出目录下所有 .js 文件 */
function listJs(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listJs(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

/** 去掉注释，避免注释里的字样造成误报 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RULES = [
  { name: '引用表现层', pattern: /from\s+['"][^'"]*\/view\// },
  { name: '使用 window', pattern: /\bwindow\b/ },
  { name: '使用 document', pattern: /\bdocument\b/ },
  { name: '使用 canvas', pattern: /\bcanvas\b/i },
  { name: '使用 Math.random（需改用 rng）', pattern: /Math\.random/ },
];

/** 检查某一层，返回违规列表 */
function findViolations(layer) {
  return listJs(join(SRC, layer)).flatMap((file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    return RULES.filter((r) => r.pattern.test(code)).map(
      (r) => `${relative(SRC, file)}: ${r.name}`,
    );
  });
}

describe('分层约束', () => {
  it.each(['logic', 'data'])('%s 层不依赖表现层与浏览器 API', (layer) => {
    expect(findViolations(layer)).toEqual([]);
  });

  it('data 层不依赖 logic 层', () => {
    const bad = listJs(join(SRC, 'data')).filter((f) =>
      /from\s+['"][^'"]*\/logic\//.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(bad.map((f) => relative(SRC, f))).toEqual([]);
  });
});
