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
  }

  // ---------- Комментарии ----------
  async function loadComments() {
    if (!commentsList) return;
    try {
      const resp = await fetch('/api/pages/' + encodeURIComponent(pageId) + '/comments');
      const data = await resp.json();
      commentsList.innerHTML = '';
      for (const c of data.comments || []) {
        const li = document.createElement('li');
        li.innerHTML = '<strong>' + escapeHtml(c.display_name) + '</strong>: ' + escapeHtml(c.text);
        if (c.mine) {
          const del = document.createElement('span');
          del.className = 'comment-delete';
          del.textContent = 'удалить';
          del.addEventListener('click', function () { deleteComment(c.id, li); });
          li.appendChild(del);
        }
        commentsList.appendChild(li);
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
      body: JSON.stringify({ text: text, anonymous: anonymous }),
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
            p.textContent = 'Лайки: ' + data.likes + ' | Дизлайки: ' + data.dislikes;
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
        const li = document.createElement('li');
        li.innerHTML = '<strong>' + escapeHtml(comment.display_name) + '</strong>: ' + escapeHtml(comment.text);
        if (comment.mine) {
          const del = document.createElement('span');
          del.className = 'comment-delete';
          del.textContent = 'удалить';
          del.addEventListener('click', function () { deleteComment(comment.id, li); });
          li.appendChild(del);
        }
        commentsList.appendChild(li);
        commentInput.value = '';
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

  checkAuth();
  loadComments();
  loadReactions();
  loadIndexCounters();
})();