interface MobilePageOk {
  id: string;
  token: string;
  uploadPath: string;
  error?: undefined;
}
interface MobilePageError {
  error: string;
  id?: undefined;
  token?: undefined;
  uploadPath?: undefined;
}

/**
 * Trang HTML tự chứa (inline CSS/JS) phục vụ cho điện thoại quét QR rồi upload
 * ảnh. Không phụ thuộc framework, không CORS vì cùng host backend.
 */
export function renderMobileUploadPage(
  opts: MobilePageOk | MobilePageError,
): string {
  if (opts.error) {
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>Upload ảnh</title>
<style>${baseCss}</style></head>
<body><div class="wrap"><div class="card error">
<div class="icon">⚠️</div>
<h1>Không thể mở phiên upload</h1>
<p>${escapeHtml(opts.error)}</p>
<p class="muted">Vui lòng tạo lại mã QR trên máy tính.</p>
</div></div></body></html>`;
  }

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>Upload ảnh lên báo đơn</title>
<style>${baseCss}</style></head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Tải ảnh lên báo đơn</h1>
    <p class="muted">Chụp ảnh hoặc chọn từ thư viện. Ảnh sẽ tự hiện trên máy tính.</p>

    <div class="btns">
      <label class="btn primary">
        <span>📷 Chụp ảnh</span>
        <input id="camera" type="file" accept="image/*" capture="environment" multiple hidden />
      </label>
      <label class="btn">
        <span>🖼️ Chọn từ thư viện</span>
        <input id="gallery" type="file" accept="image/*" multiple hidden />
      </label>
    </div>

    <div id="status" class="status"></div>
    <div id="grid" class="grid"></div>
  </div>
  <p class="footer muted">Hi Sweetie POS</p>
</div>

<script>
(function () {
  var UPLOAD_URL = ${JSON.stringify(opts.uploadPath)};
  var statusEl = document.getElementById('status');
  var gridEl = document.getElementById('grid');
  var totalOk = 0;

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function addThumb(src) {
    var d = document.createElement('div');
    d.className = 'thumb';
    var img = document.createElement('img');
    img.src = src;
    d.appendChild(img);
    gridEl.appendChild(d);
  }

  function upload(files) {
    if (!files || !files.length) return;
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
    setStatus('Đang tải ' + files.length + ' ảnh...', 'loading');

    fetch(UPLOAD_URL, { method: 'POST', body: fd })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        if (!res.ok) {
          var m = (res.body && (res.body.message || res.body.error)) || 'Tải ảnh thất bại';
          if (Array.isArray(m)) m = m.join(', ');
          setStatus(m, 'error');
          return;
        }
        var items = (res.body && res.body.items) || [];
        var errs = (res.body && res.body.errors) || [];
        items.forEach(function (it) { addThumb(it.url); });
        totalOk += items.length;
        if (errs.length === 0) {
          setStatus('✓ Đã tải ' + totalOk + ' ảnh. Có thể tiếp tục chụp/chọn thêm.', 'ok');
        } else {
          setStatus('Đã tải ' + totalOk + ' ảnh, ' + errs.length + ' ảnh lỗi.', 'error');
        }
      })
      .catch(function () { setStatus('Lỗi mạng, thử lại.', 'error'); });
  }

  document.getElementById('camera').addEventListener('change', function (e) {
    upload(e.target.files); e.target.value = '';
  });
  document.getElementById('gallery').addEventListener('change', function (e) {
    upload(e.target.files); e.target.value = '';
  });
})();
</script>
</body></html>`;
}

const baseCss = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;color:#111827}
.wrap{max-width:560px;margin:0 auto;padding:16px;min-height:100vh;display:flex;flex-direction:column}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.card.error{text-align:center}
.card .icon{font-size:40px;margin-bottom:8px}
h1{font-size:20px;margin:0 0 6px}
.muted{color:#6b7280;font-size:14px;margin:4px 0}
.btns{display:flex;flex-direction:column;gap:12px;margin:18px 0}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid #d1d5db;border-radius:12px;padding:16px;font-size:16px;font-weight:600;cursor:pointer;background:#fff;-webkit-tap-highlight-color:transparent}
.btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.btn:active{opacity:.85}
.status{min-height:22px;font-size:14px;margin:8px 0;text-align:center}
.status.loading{color:#2563eb}
.status.ok{color:#059669}
.status.error{color:#dc2626}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.thumb{aspect-ratio:1;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;background:#f9fafb}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.footer{text-align:center;margin-top:auto;padding-top:16px}
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
