// ЛАЙКИ / ДИЗЛАЙКИ
const likeBtn = document.getElementById('like-btn');
const dislikeBtn = document.getElementById('dislike-btn');
const likesCount = document.getElementById('likes-count');
const dislikesCount = document.getElementById('dislikes-count');
const commentForm = document.getElementById('comment-form');
const commentsList = document.getElementById('comments-list');

let liked = false;
let disliked = false;

if (likeBtn && dislikeBtn) {
  likeBtn.addEventListener('click', () => {
    let likes = Number(likesCount.textContent);
    let dislikes = Number(dislikesCount.textContent);

    if (!liked && !disliked) {
      likes++;
      liked = true;
    } else if (!liked && disliked) {
      likes++;
      dislikes--;
      liked = true;
      disliked = false;
    } else {
      likes--;
      liked = false;
    }

    likesCount.textContent = likes;
    dislikesCount.textContent = dislikes;
  });

  dislikeBtn.addEventListener('click', () => {
    let likes = Number(likesCount.textContent);
    let dislikes = Number(dislikesCount.textContent);

    if (!disliked && !liked) {
      dislikes++;
      disliked = true;
    } else if (!disliked && liked) {
      dislikes++;
      likes--;
      disliked = true;
      liked = false;
    } else {
      dislikes--;
      disliked = false;
    }

    likesCount.textContent = likes;
    dislikesCount.textContent = dislikes;
  });
}

if (commentForm && commentsList) {
    commentForm.addEventListener('submit', (event) => {
      event.preventDefault(); // не даём странице перезагрузиться [web:141][web:154]
  
      const nicknameInput = commentForm.elements.nickname;
      const commentInput = commentForm.elements.comment;
  
      const nickname = nicknameInput.value.trim() || 'Аноним';
      const text = commentInput.value.trim();
  
      if (!text) {
        alert('Напиши что‑нибудь в комментарий.');
        return;
      }
  
      const li = document.createElement('li');
      li.textContent = nickname + ': ' + text;
      commentsList.appendChild(li);
  
      commentInput.value = '';
    });
  }