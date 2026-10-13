// КОММЕНТАРИИ И РЕАКЦИИ
'use strict';

(function () {
  // ---------- Определение страницы ----------
  // Берём только имя файла (например, "8.html"), т.к. API не принимает слэши в pageId
  const pageId = window.location.pathname.split('/').pop() || 'index.html';

  // ---------- Элементы ----------
  const likeBtn = document.getElementById('like-btn');
  const dislikeBtn = document.getElementById('dislike-btn');
  const likesCount = document.getElementById('likes-count');
  const dislikesCount = document.getElementById('dislikes-count');
  const commentForm = document.getElementById('comment-form');
  const commentsList = document.getElementById('comments-list');
  const commentInput = document.getElementById('comment');
  const loginPrompt = document.getElementById('comment-login-prompt');
  const anonymousCheckbox = document.getElementById('anonymous');
  const submitBtn = commentForm ? commentForm.querySelector('button[type="submit"]') : null;

  let currentUser = null; // { username, id } или null
  let myReaction = 0; // 0 | 1 | -1
  let replyTo = null; // { id, name }
  const replyBanner = document.getElementById('reply-banner');
  const smilePanel = document.getElementById('smile-panel');

  function escapeHtml(s) {
    const map = {
      '&': '&#' + 38 + ';',
      '<': '&#' + 60 + ';',
      '>': '&#' + 62 + ';',
      '"': '&#' + 34 + ';',
      "'": '&#' + 39 + ';',
    };
    return String(s).replace(/[&<>"']/g, (c) => map[c]);
  }

  let smiles = new Set();
  const MARKS = ['**', '__', '*', '~', '='];
  const TAGS = { '**': 'b', '__': 'u', '*': 'i', '~': 's' };
  const SMILE_RE = /:([A-Za-z0-9_-]+):/y;

  const isSp = (c) => c !== undefined && /\s/.test(c);
  const isEscaped = (s, i, len) => isSp(s[i - 1]) && isSp(s[i + len]);

  function matchSmile(s, i) {
    if (s[i] !== ':') return null;
    SMILE_RE.lastIndex = i;
    const m = SMILE_RE.exec(s);
    return m && smiles.has(m[1]) ? { name: m[1], len: m[0].length } : null;
  }

  function findClose(s, from, mark) {
    for (let j = from + 1; j < s.length; j++) {
      const sm = matchSmile(s, j);
      if (sm) { j += sm.len - 1; continue; }
      if (mark === '*' && s.startsWith('**', j)) { j++; continue; }
      if (s.startsWith(mark, j) && !isEscaped(s, j, mark.length)) return j;
    }
    return -1;
  }

  function render(s) {
    let out = '', buf = '';
    const flush = () => { out += escapeHtml(buf); buf = ''; };
    for (let i = 0; i < s.length;) {
      const sm = matchSmile(s, i);
      if (sm) {
        flush();
        out += '<img src="/media/smiles/' + sm.name + '.gif" class="emoji" alt=":' + sm.name + ':" title=":' + sm.name + ':">';
        i += sm.len;
        continue;
      }
      const mark = MARKS.find((m) => s.startsWith(m, i));
      if (mark && !isEscaped(s, i, mark.length)) {
        const j = findClose(s, i + mark.length - 1, mark);
        if (j > 0) {
          flush();
          const inner = s.slice(i + mark.length, j);
          out += mark === '='
            ? '<code>=' + escapeHtml(inner) + '=</code>'
            : '<' + TAGS[mark] + '>' + render(inner) + '</' + TAGS[mark] + '>';
          i = j + mark.length;
          continue;
        }
      }
      if (mark) { buf += mark; i += mark.length; } else { buf += s[i]; i++; }
    }
    flush();
    return out;
  }
  
  function setReply(c) {
    replyTo = c ? { id: c.id, name: c.display_name } : null;
    if (!replyBanner) return;
    replyBanner.style.display = c ? '' : 'none';
    replyBanner.innerHTML = '';
    if (!c) return;
    replyBanner.appendChild(document.createTextNode('Ответ для ' + c.display_name + ' '));
    const x = document.createElement('span');
    x.className = 'comment-delete';
    x.textContent = 'отменить';
    x.addEventListener('click', () => setReply(null));
    replyBanner.appendChild(x);
    commentInput.focus();
  }
  
  function buildComment(c) {
    const li = document.createElement('li');
    li.id = 'c' + c.id;
    let html = '';
    if (c.parent_id) {
      html += '<div class="reply-to">↪ ответ на <a href="#c' + c.parent_id + '">' +
        escapeHtml(c.parent_name || 'комментарий') + '</a></div>';
    }
    html += '<strong>' + escapeHtml(c.display_name) + '</strong>: ' + render(c.text);
    li.innerHTML = html;
    if (currentUser) {
      const rep = document.createElement('span');
      rep.className = 'comment-delete';
      rep.textContent = 'ответить';
      rep.addEventListener('click', () => setReply(c));
      li.appendChild(rep);
    }
    if (c.mine) {
      const del = document.createElement('span');
      del.className = 'comment-delete';
      del.textContent = 'удалить';
      del.addEventListener('click', () => deleteComment(c.id, li));
      li.appendChild(del);
    }
    return li;
  }
  
  async function loadSmiles() {
    try {
      const data = await (await fetch('/api/smiles')).json();
      smiles = new Set(data.smiles || []);
    } catch (e) { smiles = new Set(); }
    if (!smilePanel) return;
    smilePanel.innerHTML = '';
    for (const name of smiles) {
      const img = document.createElement('img');
      img.src = '/media/smiles/' + name + '.gif';
      img.className = 'emoji smile-pick';
      img.title = ':' + name + ':';
      img.addEventListener('click', () => insertAtCursor(':' + name + ':'));
      smilePanel.appendChild(img);
    }
  }
  
  function insertAtCursor(str) {
    const a = commentInput, s = a.selectionStart, e = a.selectionEnd;
    a.value = a.value.slice(0, s) + str + a.value.slice(e);
    a.selectionStart = a.selectionEnd = s + str.length;
    a.focus();
  }

  // ---------- Авторизация ----------
  async function checkAuth() {
    try {
      const resp = await fetch('/api/auth/me');
      const data = await resp.json();
      currentUser = data.username ? { username: data.username, id: data.id } : null;
    } catch (e) {
      currentUser = null;
    }
    updateFormState();
  }

  function updateFormState() {
    if (!commentForm) return;
    const loggedIn = Boolean(currentUser);
    if (loginPrompt) loginPrompt.style.display = loggedIn ? 'none' : '';
    if (commentInput) commentInput.style.display = loggedIn ? '' : 'none';
    // Скрываем/показываем весь <p> с чекбоксом
    const anonRow = anonymousCheckbox ? anonymousCheckbox.closest('p') : null;
    if (anonRow) anonRow.style.display = loggedIn ? '' : 'none';
    // Снимаем инлайн-стиль display:none с самого чекбокса (он задан в HTML)
    if (anonymousCheckbox) anonymousCheckbox.style.display = loggedIn ? '' : 'none';
    // Скрываем/показываем весь <p> с кнопкой
    const submitRow = submitBtn ? submitBtn.closest('p') : null;
    if (submitRow) submitRow.style.display = loggedIn ? '' : 'none';
    if (submitBtn) submitBtn.disabled = !loggedIn;
    if (smilePanel) smilePanel.style.display = loggedIn ? '' : 'none';
  }

  // ---------- Комментарии ----------
  async function loadComments() {
    if (!commentsList) return;
    try {
      const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/comments');
      const data = await resp.json();
      commentsList.innerHTML = '';
      for (const c of data.comments || []) {
        commentsList.appendChild(buildComment(c));
      }
    } catch (e) {
      // сервер недоступен — оставляем пустым
    }
  }

  async function deleteComment(id, li) {
    try {
      const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/comments/' + id, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(data.detail || 'Не удалось удалить комментарий');
        return;
      }
      li.remove();
    } catch (e) {
      alert('Сервер недоступен');
    }
  }

  async function submitComment(text, anonymous) {
    const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, anonymous: anonymous, parent_id: replyTo ? replyTo.id : null,}),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || 'Не удалось отправить комментарий');
    }
    return resp.json();
  }

  // ---------- Реакции ----------
  async function loadReactions() {
    if (!likesCount || !dislikesCount) return;
    try {
      const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/reactions');
      const data = await resp.json();
      likesCount.textContent = data.likes;
      dislikesCount.textContent = data.dislikes;
      myReaction = data.my || 0;
      updateReactionButtons();
    } catch (e) {
      // сервер недоступен
    }
  }

  // ---------- Главная: счётчики в списке статей ----------
  async function loadIndexCounters() {
    // На страницах постов счётчики обновляет loadReactions()
    if (likesCount || dislikesCount) return;
    const articles = document.querySelectorAll('main article');
    if (!articles.length) return;
    const jobs = [];
    for (const article of articles) {
      const link = article.querySelector('a[href*="posts/"]');
      if (!link) continue;
      const href = link.getAttribute('href');
      const m = href.match(/posts\/([A-Za-z0-9._-]+\.html)/);
      if (!m) continue;
      const postPageId = m[1];
      jobs.push(
        fetch('/api/pages/' + encodeURIComponent(postPageId) + '/reactions')
          .then((resp) => resp.json())
          .then((data) => {
            const footer = article.querySelector('footer');
            if (!footer) return;
            const p = footer.querySelector('p');
            if (!p) return;
            p.textContent = 'Лайки: ' + data.likes + ' | Дизлайки: ' + data.dislikes + ' | Комментарии: ' + (data.comments || 0);
          })
          .catch(function () { /* сервер недоступен — оставляем как есть */ })
      );
    }
    await Promise.all(jobs);
  }

  function updateReactionButtons() {
    if (!likeBtn || !dislikeBtn) return;
    likeBtn.style.fontWeight = myReaction === 1 ? 'bold' : 'normal';
    dislikeBtn.style.fontWeight = myReaction === -1 ? 'bold' : 'normal';
  }

  async function setReaction(value) {
    if (!currentUser) {
      alert('Сначала авторизуйтесь');
      return;
    }
    // Если кликнули на уже активную реакцию — снимаем (0)
    const next = myReaction === value ? 0 : value;
    try {
      const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        alert(data.detail || 'Не удалось поставить реакцию');
        return;
      }
      const data = await resp.json();
      likesCount.textContent = data.likes;
      dislikesCount.textContent = data.dislikes;
      myReaction = data.my || 0;
      updateReactionButtons();
    } catch (e) {
      alert('Сервер недоступен');
    }
  }

  // ---------- Инициализация ----------
  if (commentForm) {
    commentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentUser) {
        alert('Сначала авторизуйтесь');
        return;
      }
      const text = commentInput.value.trim();
      if (!text) {
        alert('Напиши что‑нибудь в комментарий.');
        return;
      }
      const anonymous = anonymousCheckbox ? anonymousCheckbox.checked : false;
      try {
        const { comment } = await submitComment(text, anonymous);
        commentsList.appendChild(buildComment(comment));
        commentInput.value = '';
        setReply(null);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  if (likeBtn) {
    likeBtn.addEventListener('click', () => setReaction(1));
  }
  if (dislikeBtn) {
    dislikeBtn.addEventListener('click', () => setReaction(-1));
  }
  
  checkAuth().then(loadSmiles).then(loadComments);
  loadReactions();
  loadIndexCounters();
})();