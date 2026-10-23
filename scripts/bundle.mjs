import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

export const MODULES = [
  'src/history.js',
  'src/intent.js',
  'src/composer.js',
  'src/prompt.js',
  'src/locale.js',
  'src/clipboard.js',
  'src/retry.js',
  'src/history-client.js',
  'src/retry-client.js',
  'src/component-controller.js',
  'src/client.js',
];

/** 哪些源文件声明了 react 依赖：拼接后整段共享同一个 const，不能各声明一次。 */
const REACT_IMPORT = /^import \* as React from 'react';\r?\n/m;

/**
 * 把 ESM 源码压成模块加载器工厂体：
 * react 是宿主共享的静态模块，改写为工厂入参 require；相对 import 去掉（模块间靠拼接顺序共享作用域）；
 * export 前缀去掉，改为工厂返回值。
 * @param {string} source - 单个源文件内容
 * @returns {string}
 */
function flatten(source) {
  return source
    .replace(REACT_IMPORT, '')
    .replace(/^export\s+\{[^}]*\}\s+from\s+'\.[^']*';\r?\n/gm, '')
    .replace(/^import\s+[^;]*?from\s+'\.[^']*';\r?\n/gm, '')
    .replace(/^export\s+(?=(?:const|function|class|let|var)\s)/gm, '');
}

/**
 * 生成浏览器侧模块加载器包装。
 * 构建脚本与测试共用同一份逻辑，避免测试跑的是旧产物。
 * @returns {{code: string, names: string[], pkg: object}}
 */
export async function buildClientBundle() {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const sources = [];
  for (const file of MODULES) sources.push({ file, source: await readFile(new URL(file, root), 'utf8') });

  const names = [];
  for (const { source } of sources) {
    for (const match of source.matchAll(/^export\s+(?:const|function|class)\s+(\w+)/gm)) names.push(match[1]);
  }

  // react 是宿主共享的静态模块：整段只声明一次，放在模块体最前面
  const usesReact = sources.some(({ source }) => REACT_IMPORT.test(source));
  const body =
    (usesReact ? "const React = require('react');\n" : '') + sources.map(({ source }) => flatten(source)).join('\n');
  if (/^\s*import\s/m.test(body)) throw new Error('构建失败：仍残留 import 语句');
  if (/^\s*export\s/m.test(body)) throw new Error('构建失败：仍残留 export 语句');

  const code =
    'window.__ModuleLoader__.load({id:' +
    JSON.stringify(pkg.name) +
    ',factory:(require)=>{\n' +
    body +
    '\nreturn {' +
    names.join(',') +
    '};\n}});\n';
  return { code, names, pkg };
}
