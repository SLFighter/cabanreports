'use strict';
// Перегенерирует шапку во всех html-файлах (index.html, posts/*.html, pages/*.html).
// Макет шапки живёт в scripts/header.js — правки делаются только там.
// Шапка в html обёрнута маркерами <!-- header:start --> и <!-- header:end -->;
// при первом запуске скрипт сам заменяет существующий <header>...</header> и ставит маркеры.
// Запуск: node scripts/build-header.js  (или npm run build:header)

const fs = require('fs');
const path = require('path');
const { renderHeader } = require('./header');

const ROOT = path.join(__dirname, '..');

// Файлы, для которых активный пункт помечаем (id из NAV_ITEMS).
// Постам активный пункт не назначается.
const ACTIVE_BY_PAGE = {
  'index.html': ['home'],
  'pages/aboutAuthor.html': ['author'],
  'pages/archive.html': ['archive'],
  'pages/underConstruction.html': ['uc'], // обе записи ведут на underConstruction.html
  'pages/login.html': [],
  'pages/register.html': [],
};

// Относительный путь от страницы до корня сайта
function prefixFor(relFile) {
  return relFile.includes('/') ? '../' : '';
}

function processFile(relFile) {
  const full = path.join(ROOT, relFile);
  let html = fs.readFileSync(full, 'utf8');
  const prefix = prefixFor(relFile);
  const active = ACTIVE_BY_PAGE[relFile] || [];
  const header = renderHeader(prefix, active);
  const wrapped = '<!-- header:start -->\n' + header + '\n<!-- header:end -->';

  // Маркеры уже стоят — заменяем блок между ними
  const re = /<!-- header:start -->[\s\S]*?<!-- header:end -->/;
  if (re.test(html)) {
    html = html.replace(re, wrapped);
  } else {
    // Первый прогон: заменяем существующий <header>...</header> (первый в body)
    const hre = /([ \t]*)<header>[\s\S]*?<\/header>/;
    if (!hre.test(html)) {
      console.warn('WARN: ' + relFile + ' — не найден ни маркер, ни <header>; пропущен');
      return false;
    }
    html = html.replace(hre, wrapped);
  }
  fs.writeFileSync(full, html, 'utf8');
  return true;
}

function walk(dir, ext, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const files = [path.join(ROOT, 'index.html')]
  .concat(walk(path.join(ROOT, 'pages'), '.html', []))
  .concat(walk(path.join(ROOT, 'posts'), '.html', []));

let ok = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (processFile(rel)) ok++;
}
console.log('Шапка обновлена в ' + ok + '/' + files.length + ' файлах.');
