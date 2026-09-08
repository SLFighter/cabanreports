'use strict';
// Единый источник шапки сайта.
// Правки шапки и навигации делаются ТОЛЬКО здесь, затем запускается
// `npm run build:header` (scripts/build-header.js) — он перегенерирует
// шапку во всех html-файлах (index.html, posts/*.html, pages/*.html).

// Пункты навигации. href — от корня сайта. id используется, чтобы пометить
// активный пункт страницы (он рендерится обычным текстом, а не ссылкой).
const NAV_ITEMS = [
  { id: 'home',    href: 'index.html',                  text: 'На главную' },
  { id: 'archive', href: 'pages/underConstruction.html', text: 'Архив' },
  { id: 'author',  href: 'pages/aboutAuthor.html',       text: 'Пара слов об авторе' },
  { id: 'uc',      href: 'pages/underConstruction.html', text: 'Under construction...' },
];

// Логотип и слоган
const LOGO = [
  '  ░█▀▀░█▀█░█▀▄░█▀█░█▀█░░░█▀▄░█▀▀░█▀█░█▀█░█▀▄░▀█▀░█▀▀',
  '  ░█░░░█▀█░█▀▄░█▀█░█░█░░░█▀▄░█▀▀░█▀▀░█░█░█▀▄░░█░░▀▀█',
  '  ░▀▀▀░▀░▀░▀▀░░▀░▀░▀░▀░░░▀░▀░▀▀▀░▀░░░▀▀▀░▀░▀░░▀░░▀▀▀',
].join('\n');
const TAGLINE = 'личный блог | МАХимально уютно | Telegramмам - нет | HTML - будет жить';

// Шапка для конкретной страницы.
// prefix — относительный путь от страницы до корня сайта ('' или '../').
// activeIds — какие пункты навигации на этой странице являются текущими
// (рендерятся простым текстом вместо ссылки).
function renderHeader(prefix, activeIds) {
  var active = new Set(activeIds || []);
  var auth = '<div class="top-auth"><a href="' + prefix + 'pages/login.html">Вход</a> &middot; ' +
    '<a href="' + prefix + 'pages/register.html">Регистрация</a></div>';
  var nav = NAV_ITEMS.map(function (item) {
    if (active.has(item.id)) {
      return '<span class="nav-here">' + item.text + '</span>';
    }
    return '<a href="' + prefix + item.href + '">' + item.text + '</a>';
  }).join('\n');

  return [
    '<header>',
    '  ' + auth,
    '  <pre style="font-family: monospace; line-height: 1.2;">',
    LOGO,
    '  </pre>',
    '  <p>' + TAGLINE + '</p>',
    '  <nav>',
    nav,
    '  </nav>',
    '</header>',
  ].join('\n');
}

module.exports = { NAV_ITEMS, renderHeader };
