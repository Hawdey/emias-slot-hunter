// scripts/build.js — склейка userscript без зависимостей
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ORDER = [
  'core/util.js', 'core/errors.js', 'core/filters.js', 'core/session.js',
  'core/api.js', 'core/discover.js', 'core/targets.js', 'core/runner.js', 'core/index.js',
  'userscript/ui-state.js', 'userscript/ui-dom.js',
];

// Из header.js берём только сами строки метаданных (// ==UserScript== / // @…
// / // ==/UserScript==) — первая строка файла - служебный комментарий про
// сам header.js, а не часть метаданных, и раньше он же попадал в dist
// ПЕРЕД // ==UserScript==, из-за чего Tampermonkey мог не опознать шапку.
const header = fs.readFileSync(path.join(ROOT, 'userscript/header.js'), 'utf8')
  .split(/\r?\n/).filter((l) => l.startsWith('// ==') || l.startsWith('// @')).join('\n');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const parts = ORDER.map((f) => `/* ---- ${f} ---- */\n${read(f)}`);

const bundle = `${header}\n\n/*\n${read('LICENSE')}*/\n\n(function () {\n'use strict';\n${parts.join('\n')}\n})();\n`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/emias-slot-hunter.user.js'), bundle);
console.log('собрано:', path.join(ROOT, 'dist/emias-slot-hunter.user.js'), Buffer.byteLength(bundle), 'байт');
