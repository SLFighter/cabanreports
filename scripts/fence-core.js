(function (root) {
    var W = 800, H = 450;
    var BASE = [58, 46, 36];
    var SPRAY_R = 10, SPRAY_A = 0.10;
    var BRUSH_LEN = 16;
    var BUCKET_R = 60, BUCKET_SPLATS = 2500;
  
    function blend(buf, x, y, rgb, a) {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      var i = (y * W + x) * 3;
      for (var k = 0; k < 3; k++) {
        buf[i + k] = Math.round(buf[i + k] * (1 - a) + rgb[k] * a);
      }
    }
  
    function hexToRgb(hex) {
      return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
  
    function stamp(buf, tool, rgb, x, y, angleDeg) {
      if (tool === 'm') {
        blend(buf, x, y, rgb, 1);
      } else if (tool === 'b') {
        var a = angleDeg * Math.PI / 180;
        var dx = Math.cos(a), dy = Math.sin(a);
        var px = -dy, py = dx;
        for (var t = -BRUSH_LEN / 2; t <= BRUSH_LEN / 2; t += 0.5) {
          for (var w = 0; w < 2; w++) {
            blend(buf, Math.round(x + dx * t + px * w * 0.7),
                       Math.round(y + dy * t + py * w * 0.7), rgb, 1);
          }
        }
      } else if (tool === 's') {
        for (var yy = -SPRAY_R; yy <= SPRAY_R; yy++) {
          for (var xx = -SPRAY_R; xx <= SPRAY_R; xx++) {
            var d = Math.sqrt(xx * xx + yy * yy);
            if (d > SPRAY_R) continue;
            blend(buf, x + xx, y + yy, rgb, SPRAY_A * (1 - 0.6 * d / SPRAY_R));
          }
        }
      }
    }
  
    function applyBatch(buf, tool, hex, pts) {
      var rgb = hexToRgb(hex);
      for (var i = 0; i < pts.length; i++) {
        stamp(buf, tool, rgb, pts[i][0], pts[i][1], pts[i][2] || 0);
      }
    }
  
    function mulberry32(a) {
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        var t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
  
    function bucket(buf, hex, cx, cy, seed) {
      var rgb = hexToRgb(hex), rnd = mulberry32(seed);
      var R = BUCKET_R, pad = 6;
      for (var y = -R - pad; y <= R + pad; y++) {
        for (var x = -R - pad; x <= R + pad; x++) {
          var d = Math.sqrt(x * x + y * y);
          if (d <= R - pad || (d <= R + pad && rnd() < (R + pad - d) / (2 * pad))) {
            blend(buf, cx + x, cy + y, rgb, 1);
          }
        }
      }
      for (var i = 0; i < BUCKET_SPLATS; i++) {
        var px = Math.floor(rnd() * W), py = Math.floor(rnd() * H);
        blend(buf, px, py, rgb, 1);
        if (rnd() < 0.15) {
          blend(buf, px + 1, py, rgb, 1);
          blend(buf, px, py + 1, rgb, 1);
          blend(buf, px + 1, py + 1, rgb, 1);
        }
      }
    }
  
    var api = { W: W, H: H, BASE: BASE, applyBatch: applyBatch, bucket: bucket };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.FenceCore = api;
  })(typeof window !== 'undefined' ? window : globalThis);