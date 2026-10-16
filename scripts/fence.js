(function () {
    var C = FenceCore, W = C.W, H = C.H;
    var cv = document.getElementById('fence');
    var ctx = cv.getContext('2d');
    var statusEl = document.getElementById('fence-status');
    var colorEl = document.getElementById('fence-color');
    var angleEl = document.getElementById('fence-angle');
    var bucketBtn = document.getElementById('fence-bucket');
  
    var img = ctx.createImageData(W, H);
    var buf = new Uint8Array(W * H * 3);
    var needDraw = true;
    var cid = Math.random().toString(36).slice(2, 12);
  
    var tool = 's', angle = 0, canDraw = false, drawing = false;
    var last = null, queue = [], holdTimer = null, flushing = false;
    var bucketLeft = 0;
  
    // ---------- звук ----------
    var actx = null;
    function unlockAudio() {
      if (!actx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) actx = new AC();
      }
      if (actx && actx.state === 'suspended') actx.resume();
    }
    document.addEventListener('pointerdown', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
  
    function playSplash() {
      if (!actx || actx.state !== 'running') return;
      var t0 = actx.currentTime, dur = 0.7;
  
      var nb = actx.createBuffer(1, Math.floor(actx.sampleRate * dur), actx.sampleRate);
      var data = nb.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      var noise = actx.createBufferSource();
      noise.buffer = nb;
      var bp = actx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(4000, t0);
      bp.frequency.exponentialRampToValueAtTime(300, t0 + dur);
      var ng = actx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.5, t0 + 0.03);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(bp); bp.connect(ng); ng.connect(actx.destination);
      noise.start(t0);
  
      var osc = actx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.35);
      var og = actx.createGain();
      og.gain.setValueAtTime(0.5, t0);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      osc.connect(og); og.connect(actx.destination);
      osc.start(t0); osc.stop(t0 + 0.45);
    }
  
    // ---------- отрисовка и синхронизация ----------
    function render() {
      if (needDraw) {
        var d = img.data;
        for (var i = 0, j = 0; i < buf.length; i += 3, j += 4) {
          d[j] = buf[i]; d[j + 1] = buf[i + 1]; d[j + 2] = buf[i + 2]; d[j + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        needDraw = false;
      }
      requestAnimationFrame(render);
    }
  
    function loadCanvas() {
      return fetch('/api/fence/canvas', { cache: 'no-store' })
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { buf.set(new Uint8Array(ab)); needDraw = true; });
    }
  
    function connectEvents() {
      var es = new EventSource('/api/fence/events');
      es.onmessage = function (e) {
        var m = JSON.parse(e.data);
        if (m.cid === cid) return;
        if (m.k === 'bucket') {
          C.bucket(buf, m.c, m.x, m.y, m.seed);
          playSplash();
        } else {
          C.applyBatch(buf, m.t, m.c, m.pts);
        }
        needDraw = true;
      };
      es.onerror = function () { setTimeout(loadCanvas, 1500); };
    }
  
    // ---------- рисование ----------
    function pos(e) {
      var r = cv.getBoundingClientRect();
      return [
        Math.max(0, Math.min(W - 1, Math.floor((e.clientX - r.left) * W / r.width))),
        Math.max(0, Math.min(H - 1, Math.floor((e.clientY - r.top) * H / r.height)))
      ];
    }
  
    function addPoint(x, y) {
      var item = { t: tool, c: colorEl.value, x: x, y: y, a: angle };
      queue.push(item);
      C.applyBatch(buf, item.t, item.c, [[x, y, angle]]);
      needDraw = true;
    }
  
    function lineTo(x, y) {
      if (!last) { addPoint(x, y); last = [x, y]; return; }
      var dx = x - last[0], dy = y - last[1];
      var dist = Math.max(Math.abs(dx), Math.abs(dy));
      var step = tool === 's' ? 3 : 1;
      var n = Math.max(1, Math.floor(dist / step));
      for (var i = 1; i <= n; i++) {
        addPoint(Math.round(last[0] + dx * i / n), Math.round(last[1] + dy * i / n));
      }
      last = [x, y];
    }
  
    function flush() {
      if (flushing || !queue.length) return;
      var first = queue[0], n = 0;
      while (n < queue.length && n < 400 && queue[n].t === first.t && queue[n].c === first.c) n++;
      var items = queue.splice(0, n);
      flushing = true;
      fetch('/api/fence/stroke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: cid, t: first.t, c: first.c,
          pts: items.map(function (i) { return [i.x, i.y, i.a]; })
        })
      }).then(function (r) {
        if (r.status === 401) {
          canDraw = false;
          statusEl.textContent = 'Сессия устарела, нужно войти заново';
        }
      }).catch(function () {}).then(function () {
        flushing = false;
        flush();
      });
    }
    setInterval(flush, 80);
  
    function stop() { drawing = false; last = null; clearInterval(holdTimer); }
  
    cv.addEventListener('pointerdown', function (e) {
      if (!canDraw || e.button !== 0) return;
      if (tool === 'k') {
        var q = pos(e);
        pourBucket(q[0], q[1]);
        return;
      }
      cv.setPointerCapture(e.pointerId);
      drawing = true; last = null;
      var p = pos(e);
      lineTo(p[0], p[1]);
      if (tool === 's') {
        clearInterval(holdTimer);
        holdTimer = setInterval(function () { if (last) addPoint(last[0], last[1]); }, 40);
      }
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e);
      lineTo(p[0], p[1]);
    });
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
  
    cv.addEventListener('wheel', function (e) {
      if (tool !== 'b') return;
      e.preventDefault();
      angle = (angle + (e.deltaY > 0 ? 15 : -15) + 360) % 360;
      angleEl.textContent = 'Угол: ' + angle + '°';
    }, { passive: false });
  
    document.querySelectorAll('#fence-tools button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        tool = btn.dataset.tool;
        stop();
        document.querySelectorAll('#fence-tools button').forEach(function (b) {
          b.classList.toggle('on', b === btn);
        });
        angleEl.textContent = tool === 'b' ? 'Угол: ' + angle + '°' : '';
      });
    });
  
    // ---------- ведро ----------
    function updateBucketBtn() {
      bucketBtn.textContent = bucketLeft > 0
        ? 'Ведро (' + Math.floor(bucketLeft / 60) + ':' + String(bucketLeft % 60).padStart(2, '0') + ')'
        : 'Ведро краски';
    }
    setInterval(function () {
      if (bucketLeft > 0) { bucketLeft--; updateBucketBtn(); }
    }, 1000);
  
    function syncBucket() {
      fetch('/api/fence/bucket').then(function (r) { return r.json(); })
        .then(function (j) { bucketLeft = j.left || 0; updateBucketBtn(); });
    }
  
    function pourBucket(x, y) {
      if (bucketLeft > 0) { statusEl.textContent = 'Уже бежим в лемана про за новым ведром'; return; }
      var seed = Math.floor(Math.random() * 4294967296);
      var color = colorEl.value;
      fetch('/api/fence/bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: cid, c: color, x: x, y: y, seed: seed })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (res) {
        if (res.ok) {
          C.bucket(buf, color, x, y, seed);
          needDraw = true;
          playSplash();
          bucketLeft = res.j.left;
        } else if (res.j.left) {
          bucketLeft = res.j.left;
        }
        updateBucketBtn();
      });
    }
  
    // ---------- старт ----------
    fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (me) {
      canDraw = Boolean(me && me.username);
      statusEl.textContent = '';
      if (canDraw) {
        statusEl.textContent = '';
        syncBucket();
      } else {
        statusEl.appendChild(document.createTextNode('Смотреть можно всем, портить только после '));
        var a = document.createElement('a');
        a.href = 'login.html';
        a.textContent = 'входа';
        statusEl.appendChild(a);
        statusEl.appendChild(document.createTextNode('.'));
      }
    });
  
    loadCanvas().then(function () { connectEvents(); render(); });
  })();