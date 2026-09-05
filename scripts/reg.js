let selectedUsername = null;

  async function loadOptions() {
    const loading = document.getElementById("nick-loading");
    const container = document.getElementById("nick-options");
    const btn = document.getElementById("btn-refresh");

    loading.style.display = "block";
    container.innerHTML = "";
    btn.disabled = true;
    selectedUsername = null;

    try {
      const resp = await fetch("/api/auth/username-options");
      if (!resp.ok) throw new Error("Сервер недоступен");
      const data = await resp.json();

      loading.style.display = "none";
      container.innerHTML = "";

      data.options.forEach((name, i) => {
        const div = document.createElement("div");
        div.className = "nick-option";
        div.dataset.name = name;
        div.innerHTML = `
          <input type="radio" name="nick" id="nick${i}" value="${name}">
          <label for="nick${i}" class="nick-label">${name}</label>
        `;
        div.addEventListener("click", () => selectNick(name, div));
        div.querySelector("input").addEventListener("change", () => selectNick(name, div));
        container.appendChild(div);
      });

    } catch (e) {
      loading.style.display = "none";
      showMessage("Не удалось загрузить варианты: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  function selectNick(name, el) {
    selectedUsername = name;
    document.querySelectorAll(".nick-option").forEach(d => d.classList.remove("selected"));
    el.classList.add("selected");
    el.querySelector("input[type=radio]").checked = true;
  }

  async function doRegister() {
    const btn = document.getElementById("btn-register");
    const password = document.getElementById("password").value;
    const password2 = document.getElementById("password2").value;

    if (!selectedUsername) {
      showMessage("Выбери никнейм из списка", "error"); return;
    }
    if (!password) {
      showMessage("Введи пароль", "error"); return;
    }
    if (password.length < 6) {
      showMessage("Пароль должен быть не короче 6 символов", "error"); return;
    }
    if (password !== password2) {
      showMessage("Пароли не совпадают", "error"); return;
    }

    btn.disabled = true;
    showMessage("Регистрируемся&#8230;", "loading");

    try {
      const resp = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: selectedUsername, password }),
      });

      const data = await resp.json();

      if (resp.ok) {
        showMessage("&#10003; " + data.message + " Добро пожаловать, " + data.username + "!", "success");
        btn.disabled = true;
        document.getElementById("btn-refresh").disabled = true;
        document.querySelectorAll("input").forEach(i => i.disabled = true);
      } else {
        showMessage(data.detail || "Ошибка регистрации", "error");
        btn.disabled = false;
      }
    } catch (e) {
      showMessage("Ошибка соединения: " + e.message, "error");
      btn.disabled = false;
    }
  }

  function showMessage(text, type) {
    const el = document.getElementById("message");
    el.innerHTML = text;
    el.className = type;
    el.style.display = "block";
  }

  // Загружаем варианты сразу при открытии страницы
  window.addEventListener("DOMContentLoaded", loadOptions);