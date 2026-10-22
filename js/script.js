/* ============================================================
   CETAK ADMINISTRASI GURU — script.js (v3.0)
   ============================================================
   Fitur:
   - Auth (login/register/logout)
   - Identitas per user (localStorage)
   - Daftar RPP + filter + kuota harian
   - Unduh & Proses: unduh per batch + mail merge langsung + ZIP final
   - Manajemen user (admin)
   - Import Drive (admin)
   - Log unduhan (admin)
   ============================================================ */

/* ============ KONFIGURASI ============ */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxmxd967YOIkxUzxfM1GEz8X_jayZQxSCHgqVAHBOtQchqkjr8fWtYOZY5DqzDE1c-WcA/exec';
const LS_LIST          = 'rpp_list_v1';
const LS_IDENT_PREFIX  = 'adm_ident_';
const LS_SESSION       = 'adm_session_v1';

/* ============ STATE ============ */
let listData          = [];
let selectedIds       = new Set();
let session           = null;
let drivePreviewData  = null;
let quotaInfo         = null;

/* ============ HELPERS ============ */
const logEl = document.getElementById('log');
function log(msg) {
  const ts = new Date().toLocaleTimeString('id-ID');
  logEl.textContent += `\n[${ts}] ${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}
const setStatus = s => document.getElementById('status').textContent = s;
const esc       = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sanitize  = s => String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').trim();

function identKey() {
  return LS_IDENT_PREFIX + (session && session.ID ? session.ID : 'guest');
}
function buildRegex(ph) {
  const chars = ph.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(chars.join('(?:<[^>]+>)*'), 'g');
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function base64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function extractLinkId(link) {
  if (!link) return '';
  const s = String(link).trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s) && !s.includes('/')) return s;
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m) return m[1];
  m = s.match(/\/d\/([a-zA-Z0-9_-]+)/); if (m) return m[1];
  return s;
}

/* ============ API (POST) ============ */
async function apiPost(payload) {
  let res;
  try {
    res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(payload) });
  } catch (netErr) {
    throw new Error('Tidak bisa menghubungi server. Cek koneksi.');
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    console.error('Respons bukan JSON:', text.substring(0, 400));
    throw new Error('Server tidak merespons JSON. Kemungkinan deploy GAS salah atau "Who has access" bukan "Anyone".');
  }
  if (!json.ok) throw new Error(json.error || 'Request gagal');
  return json;
}

/* ============ SESSION ============ */
function loadSession() {
  try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); }
  catch { session = null; }
  return session;
}
function saveSession(s) {
  session = s;
  localStorage.setItem(LS_SESSION, JSON.stringify(s));
}
function clearSession() {
  session = null;
  localStorage.removeItem(LS_SESSION);
}

/* ============ VERIFIKASI STATUS ============ */
async function verifyActiveUser() {
  if (!session) return false;
  try {
    const json = await apiPost({ action: 'getUser', id: session.ID });
    if (!json.user) throw new Error('User tidak ditemukan');
    const status = String(json.user.Status || '').toLowerCase();
    if (status !== 'aktif') {
      clearSession();
      const msg = status === 'pending'
        ? 'Akun Anda masih menunggu persetujuan admin.'
        : 'Akun Anda telah dinonaktifkan oleh admin.';
      alert(msg + '\nSilakan hubungi admin atau login dengan akun lain.');
      location.reload();
      return false;
    }
    saveSession(json.user);
    applySession();
    return true;
  } catch (e) {
    const msg = String(e.message || '').toLowerCase();
    if (msg.includes('tidak ditemukan')) {
      clearSession();
      alert('Akun tidak ditemukan di server.\nSilakan login kembali.');
      location.reload();
      return false;
    }
    log('⚠ Verifikasi server gagal (mode offline): ' + e.message);
    return true;
  }
}

/* ============ LOGIN / LOGOUT / REGISTER ============ */
const loginOverlay    = document.getElementById('loginOverlay');
const registerOverlay = document.getElementById('registerOverlay');
const loginError      = document.getElementById('loginError');
const regError        = document.getElementById('regError');
const btnLogin        = document.getElementById('btnLogin');
const btnRegister     = document.getElementById('btnRegister');
const loginUserEl     = document.getElementById('loginUser');
const loginPassEl     = document.getElementById('loginPass');

function showLogin()     { loginOverlay.classList.add('show'); }
function hideLogin()     { loginOverlay.classList.remove('show'); }
function showRegister()  { loginOverlay.classList.remove('show'); registerOverlay.classList.add('show'); }
function hideRegister()  { registerOverlay.classList.remove('show'); loginOverlay.classList.add('show'); }

document.getElementById('linkToRegister').addEventListener('click', e => { e.preventDefault(); showRegister(); });
document.getElementById('linkBackToLogin').addEventListener('click', e => { e.preventDefault(); hideRegister(); });

async function doLogin() {
  const username = loginUserEl.value.trim();
  const password = loginPassEl.value;
  loginError.textContent = '';
  if (!username || !password) {
    loginError.textContent = 'Username dan password wajib diisi.';
    return;
  }
  btnLogin.disabled = true;
  btnLogin.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memeriksa...';
  try {
    const json = await apiPost({ action: 'login', username, password });
    if (!json.user) throw new Error('Respons login tidak valid.');
    if (String(json.user.Status).toLowerCase() !== 'aktif') {
      const st = String(json.user.Status).toLowerCase();
      throw new Error(st === 'pending'
        ? 'Akun masih menunggu persetujuan admin.'
        : 'Akun tidak aktif. Hubungi admin.');
    }
    saveSession(json.user);
    loginPassEl.value = '';
    hideLogin();
    applySession();
    log(`✓ Login berhasil: ${json.user.Username} (${json.user.JenisUser})`);
    startApp();
  } catch (e) {
    loginError.textContent = e.message;
    log('❌ Login gagal: ' + e.message);
  } finally {
    btnLogin.disabled = false;
    btnLogin.innerHTML = '<i class="fas fa-sign-in-alt"></i> Masuk';
  }
}

async function doRegister() {
  const u  = document.getElementById('regUsername').value.trim();
  const p  = document.getElementById('regPassword').value;
  const p2 = document.getElementById('regPassword2').value;
  const uk = document.getElementById('regUnitKerja').value.trim();
  const jg = document.getElementById('regJenisGuru').value;
  const pl = document.getElementById('regPelajaran').value;
  const kl = document.getElementById('regKelas').value;

  regError.textContent = '';
  if (u.length < 3) { regError.textContent = 'Username minimal 3 karakter.'; return; }
  if (p.length < 6) { regError.textContent = 'Password minimal 6 karakter.'; return; }
  if (p !== p2)     { regError.textContent = 'Konfirmasi password tidak cocok.'; return; }
  if (!uk)          { regError.textContent = 'Unit Kerja wajib diisi.'; return; }

  btnRegister.disabled = true;
  btnRegister.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim...';
  try {
    await apiPost({
      action: 'register',
      username: u, password: p,
      unitKerja: uk, jenisGuru: jg, pelajaran: pl, kelas: kl
    });
    alert('✅ Pengajuan terkirim!\n\nAkun Anda akan aktif setelah disetujui admin.');
    hideRegister();
    ['regUsername','regPassword','regPassword2','regUnitKerja'].forEach(id => document.getElementById(id).value = '');
    loginUserEl.value = u;
    loginPassEl.focus();
    log('✓ Pengajuan akun: ' + u);
  } catch (e) {
    regError.textContent = e.message;
    log('❌ Registrasi gagal: ' + e.message);
  } finally {
    btnRegister.disabled = false;
    btnRegister.innerHTML = '<i class="fas fa-paper-plane"></i> Kirim Pengajuan';
  }
}

function doLogout() {
  if (!confirm('Yakin ingin logout?\n\nIdentitas Anda tetap tersimpan di browser ini dan akan muncul lagi saat login berikutnya.')) return;
  clearSession();
  log('User logout.');
  location.reload();
}

btnLogin.addEventListener('click', doLogin);
btnRegister.addEventListener('click', doRegister);
loginPassEl.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
loginUserEl.addEventListener('keydown', e => { if (e.key === 'Enter') loginPassEl.focus(); });
document.getElementById('btnLogout').addEventListener('click', doLogout);

/* ============ APPLY SESSION ============ */
function applySession() {
  if (!session) return;
  const isAdmin = String(session.JenisUser).toLowerCase() === 'admin';
  document.body.classList.toggle('is-admin', isAdmin);

  document.getElementById('userAvatar').textContent = (session.Username || '?').slice(0, 2);
  document.getElementById('userName').textContent = session.Username || '—';
  document.getElementById('userRole').textContent =
    isAdmin ? 'Administrator' : (session.JenisGuru || 'Pelanggan');

  loadIdentitas();
  updateIdentitasRingkas();

  const fSekolah = document.getElementById('fSekolah');
  if (session.UnitKerja && !fSekolah.value) {
    fSekolah.value = session.UnitKerja;
    saveIdentitas();
  }
}

/* ============ NAVIGASI ============ */
const pageTitles = {
  dashboard:   { title: 'Dashboard',      subtitle: 'Selamat datang! Sistem Cetak Administrasi Guru' },
  identitas:   { title: 'Identitas',      subtitle: 'Data sekolah, guru, dan tanda tangan laporan' },
  server:      { title: 'Ambil Paket',    subtitle: 'Unduh & proses template Dokumen otomatis' },
  users:       { title: 'Manajemen User', subtitle: 'Terima pengajuan & kelola status user (admin)' },
  importdrive: { title: 'Import Drive',   subtitle: 'Sinkronisasi file dari folder Google Drive' },
  logunduh:    { title: 'Log Unduhan',    subtitle: 'Riwayat permintaan unduhan semua user (admin)' },
  log:         { title: 'Log Aktivitas',  subtitle: 'Riwayat proses aplikasi (sesi ini)' },
};

function navigateTo(page) {
  document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (!target) return;
  target.classList.add('active');
  document.querySelectorAll('.sidebar-menu a[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
  const info = pageTitles[page] || pageTitles.dashboard;
  document.getElementById('pageTitle').textContent = info.title;
  document.getElementById('pageSubtitle').textContent = info.subtitle;
  if (window.innerWidth <= 768) document.body.classList.add('sidebar-hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const isAdmin = session && String(session.JenisUser).toLowerCase() === 'admin';
  if (page === 'users' && isAdmin)       loadAndRenderUsers();
  if (page === 'importdrive' && isAdmin) loadDriveConfig();
  if (page === 'logunduh' && isAdmin)    loadLogUnduh();
}

document.querySelectorAll('[data-page]').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); navigateTo(el.dataset.page); });
});

/* ============ SIDEBAR TOGGLE ============ */
document.getElementById('hamburgerBtn').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-hidden');
});
document.getElementById('sidebarOverlay').addEventListener('click', () => {
  document.body.classList.add('sidebar-hidden');
});
if (window.innerWidth <= 768) document.body.classList.add('sidebar-hidden');

/* ============ IDENTITAS (per user) ============ */
const IDENT_FIELDS = ['fSekolah','fTahunAjaran','fKS','fNIPKS','fGuru','fNIPGuru','fTempat','fTanggal'];
const REQUIRED_FIELDS = {
  fSekolah:     'Nama Sekolah',
  fTahunAjaran: 'Tahun Ajaran',
  fKS:          'Nama Kepala Sekolah',
  fNIPKS:       'NIP Kepala Sekolah',
  fGuru:        'Nama Guru',
  fNIPGuru:     'NIP Guru',
  fTempat:      'Tempat TTD Laporan'
};

function loadIdentitas() {
  try {
    const s = JSON.parse(localStorage.getItem(identKey()) || '{}');
    IDENT_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = s[id] || '';
    });
  } catch (e) {}
}
function saveIdentitas() {
  if (!session) return;
  const s = {};
  IDENT_FIELDS.forEach(id => s[id] = document.getElementById(id).value);
  localStorage.setItem(identKey(), JSON.stringify(s));
  updateIdentitasRingkas();
}
IDENT_FIELDS.forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', saveIdentitas);
});

function getReplacements() {
  const tglRaw = document.getElementById('fTanggal').value.trim();
  const tgl = tglRaw || '....................';
  const tempat = document.getElementById('fTempat').value;
  return {
    '[NamaSekolah]':    document.getElementById('fSekolah').value,
    '[TahunAjaran]':    document.getElementById('fTahunAjaran').value,
    '[NamaGuru]':       document.getElementById('fGuru').value,
    '[NamaKS]':         document.getElementById('fKS').value,
    '[NIPGuru]':        document.getElementById('fNIPGuru').value,
    '[NIPKS]':          document.getElementById('fNIPKS').value,
    '[TempatTTD]':      tempat,
    '[Tempat]':         tempat,
    '[TanggalLaporan]': tgl,
    '[Tanggal]':        tgl
  };
}

function checkIdentitas() {
  const missing = Object.entries(REQUIRED_FIELDS)
    .filter(([id]) => !document.getElementById(id).value.trim());
  if (missing.length) {
    navigateTo('identitas');
    setTimeout(() => {
      alert('Lengkapi dulu identitas berikut:\n- ' +
        missing.map(([, label]) => label).join('\n- '));
    }, 250);
    return false;
  }
  return true;
}

function updateIdentitasRingkas() {
  const s = JSON.parse(localStorage.getItem(identKey()) || '{}');
  const el = document.getElementById('identitasRingkas');
  if (!el) return;
  const empty = IDENT_FIELDS.every(id => !s[id]);
  if (empty) {
    el.innerHTML = '<li><span class="label">Belum ada data</span>' +
      '<a href="#" data-page="identitas" class="action-link">Isi →</a></li>';
    el.querySelectorAll('[data-page]').forEach(a =>
      a.addEventListener('click', e => { e.preventDefault(); navigateTo(a.dataset.page); }));
    return;
  }
  const tgl = s.fTanggal ? s.fTanggal : '....................';
  el.innerHTML = `
    <li><span class="label">Sekolah</span><span class="value">${esc(s.fSekolah || '—')}</span></li>
    <li><span class="label">Tahun Ajaran</span><span class="value">${esc(s.fTahunAjaran || '—')}</span></li>
    <li><span class="label">Kepala Sekolah</span><span class="value">${esc(s.fKS || '—')}</span></li>
    <li><span class="label">NIP KS</span><span class="value">${esc(s.fNIPKS || '—')}</span></li>
    <li><span class="label">Guru</span><span class="value">${esc(s.fGuru || '—')}</span></li>
    <li><span class="label">NIP Guru</span><span class="value">${esc(s.fNIPGuru || '—')}</span></li>
    <li><span class="label">Tempat TTD</span><span class="value">${esc(s.fTempat || '—')}</span></li>
    <li><span class="label">Tanggal Laporan</span><span class="value">${esc(tgl)}</span></li>
  `;
}

/* ============ DASHBOARD STATS ============ */
function updateDashboardStats() {
  document.getElementById('statTotal').textContent = listData.length;
  document.getElementById('statSelected').textContent = selectedIds.size;
  const kelas = new Set(listData.map(r => r.kelas).filter(Boolean));
  const mapel = new Set(listData.map(r => r.mapel).filter(Boolean));
  document.getElementById('statKelas').textContent = kelas.size;
  document.getElementById('statMapel').textContent = mapel.size;
}

/* ============ FETCH LIST RPP ============ */
async function fetchList() {
  setStatus('Memuat daftar...');
  const res = await fetch(GAS_URL + '?action=list');
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    console.error('Respons list bukan JSON:', text.substring(0, 400));
    throw new Error('Server tidak merespons JSON. Cek deploy GAS.');
  }
  if (!json.ok) throw new Error(json.error || 'Gagal fetch list');
  localStorage.setItem(LS_LIST, JSON.stringify({ ts: Date.now(), data: json.data }));
  return json.data;
}

/* ============ FILTER & TABEL ============ */
function populateFilter(sel, values) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">— semua —</option>' +
    values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = cur;
}
function refreshFilters() {
  const uniq = k => [...new Set(listData.map(r => r[k]).filter(Boolean))].sort();
  populateFilter(document.getElementById('filterKelas'), uniq('kelas'));
  populateFilter(document.getElementById('filterSemester'), uniq('semester'));
  populateFilter(document.getElementById('filterMapel'), uniq('mapel'));
}
function getFilteredRows() {
  const k = document.getElementById('filterKelas').value;
  const s = document.getElementById('filterSemester').value;
  const m = document.getElementById('filterMapel').value;
  return listData.filter(r =>
    (!k || String(r.kelas) === k) &&
    (!s || String(r.semester) === s) &&
    (!m || String(r.mapel) === m)
  );
}

function renderTable() {
  const rows = getFilteredRows();
  const tbody = document.getElementById('tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Tidak ada RPP yang cocok.</td></tr>';
    updateZipButton(); updateCheckAll(); updateDashboardStats(); return;
  }
  tbody.innerHTML = rows.map(r => {
    const id = String(r.id_adm);
    const checked = selectedIds.has(id) ? 'checked' : '';
    return `<tr>
      <td><input type="checkbox" class="rowChk" data-id="${esc(id)}" ${checked}></td>
      <td><span class="badge">${esc(r.id_adm)}</span></td>
      <td>${esc(r.nama_adm)}</td>
      <td>${esc(r.kelas)}</td>
      <td>${esc(r.semester)}</td>
      <td>${esc(r.mapel)}</td>
      <td>${esc(r.bab)}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.rowChk').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.id;
      if (chk.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateZipButton(); updateCheckAll(); updateDashboardStats();
    });
  });
  updateZipButton(); updateCheckAll(); updateDashboardStats();
}

function updateZipButton() {
  const btn = document.getElementById('btnDownloadZip');
  const n = selectedIds.size;
  btn.disabled = n === 0;
  btn.innerHTML = n === 0
    ? '<i class="fas fa-magic"></i> Unduh &amp; Proses'
    : `<i class="fas fa-magic"></i> Unduh &amp; Proses (${n} File)`;
}
function updateCheckAll() {
  const rows = getFilteredRows();
  const all = rows.length > 0 && rows.every(r => selectedIds.has(String(r.id_adm)));
  document.getElementById('checkAll').checked = all;
}

/* ============ PROGRESS HELPER ============ */
function setProgress(pct, label) {
  const bar  = document.getElementById('progressBar');
  const info = document.getElementById('progressInfo');
  bar.style.width = pct + '%';
  if (info) {
    info.style.display = 'block';
    info.textContent = pct + '%' + (label ? ' — ' + label : '');
  }
}
function hideProgress() {
  const prog = document.getElementById('progress');
  const bar  = document.getElementById('progressBar');
  const info = document.getElementById('progressInfo');
  setTimeout(() => {
    prog.classList.remove('show');
    bar.style.width = '0%';
    if (info) { info.style.display = 'none'; info.textContent = ''; }
  }, 600);
}

/* ============ MAIL MERGE — DOCX ============ */
async function editDocxArrayBuffer(buf, replacements) {
  const zip = await JSZip.loadAsync(buf);
  const targets = Object.keys(zip.files).filter(n =>
    n === 'word/document.xml' ||
    n.startsWith('word/header') ||
    n.startsWith('word/footer')
  );
  for (const path of targets) {
    let xml = await zip.file(path).async('string');
    for (const [key, val] of Object.entries(replacements)) {
      xml = xml.replace(buildRegex(key), esc(val));
    }
    zip.file(path, xml);
  }
  return await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

/* ============ MAIL MERGE — XLSX ============ */
async function editXlsxArrayBuffer(buf, replacements) {
  const zip = await JSZip.loadAsync(buf);
  const targets = Object.keys(zip.files).filter(n =>
    n === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );
  for (const path of targets) {
    let xml = await zip.file(path).async('string');
    for (const [key, val] of Object.entries(replacements)) {
      xml = xml.replace(buildRegex(key), esc(val));
    }
    zip.file(path, xml);
  }
  return await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

/* ============================================================
   UNDUH & PROSES — chunking + mail merge + ZIP final
   ============================================================ */
async function handleDownloadZip() {
  const visibleIds = new Set(getFilteredRows().map(r => String(r.id_adm)));
  const rows = listData.filter(r =>
    selectedIds.has(String(r.id_adm)) && visibleIds.has(String(r.id_adm))
  );
  if (!rows.length) { alert('Pilih minimal 1 file dari baris yang tampil.'); return; }

  if (!checkIdentitas()) {
    log('⚠ Proses dibatalkan: identitas belum lengkap.');
    return;
  }

  setStatus('Memverifikasi akun...');
  const active = await verifyActiveUser();
  if (!active) { setStatus(''); return; }
  setStatus(`${listData.length} RPP tersedia`);

  try {
    const check = await apiPost({
      action: 'checkQuota',
      userId: session.ID,
      fileCount: rows.length
    });
    if (!check.allowed) {
      alert(check.reason);
      log('⚠ Unduhan ditolak: ' + check.reason);
      return;
    }
  } catch (e) {
    alert('Gagal cek kuota: ' + e.message);
    return;
  }

  const btn = document.getElementById('btnDownloadZip');
  const prog = document.getElementById('progress');
  btn.disabled = true;
  prog.classList.add('show');
  setProgress(2, 'Memulai...');

  const t0 = performance.now();
  log(`\n=== Unduh & Proses: ${rows.length} file ===`);

  const ids = rows.map(r => extractLinkId(r.link)).filter(Boolean);
  if (!ids.length) {
    alert('Tidak ada link file yang valid.');
    btn.disabled = false;
    hideProgress();
    return;
  }

  const repl = getReplacements();
  const CHUNK = 60;
  const batches = [];
  for (let i = 0; i < ids.length; i += CHUNK) batches.push(ids.slice(i, i + CHUNK));
  log(`→ ${ids.length} file, ${batches.length} batch (maks ${CHUNK}/batch)`);

  const outZip = new JSZip();
  const usedNames = new Set();
  const allErrors = [];
  let totalSuccess = 0, totalFailed = 0, failedBatches = 0;

  for (let b = 0; b < batches.length; b++) {
    const batchIds = batches[b];
    const batchStartPct = 5 + (b / batches.length) * 75;
    setProgress(Math.round(batchStartPct), `Mengunduh batch ${b + 1}/${batches.length}...`);
    log(`  Batch ${b + 1}/${batches.length} (${batchIds.length} file)...`);

    let batchZipBytes = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3 && !batchZipBytes; attempt++) {
      try {
        const json = await apiPost({
          action: 'zip',
          ids: batchIds,
          userId: session.ID,
          username: session.Username
        });
        if (json.errors && json.errors.length) json.errors.forEach(e => allErrors.push(e));
        if (!json.data) throw new Error('Respons tanpa data');
        batchZipBytes = base64ToUint8(json.data);
      } catch (e) {
        lastErr = e.message;
        if (attempt < 3) {
          log(`  ⚠ Attempt ${attempt} gagal: ${e.message} — retry ${attempt + 1}/3...`);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    if (!batchZipBytes) {
      failedBatches++;
      log(`  ❌ Batch ${b + 1} GAGAL setelah 3x: ${lastErr}`);
      continue;
    }

    let batchZip = null;
    let fileNames = [];
    try {
      batchZip = await JSZip.loadAsync(batchZipBytes);
      fileNames = Object.keys(batchZip.files)
        .filter(n => !batchZip.files[n].dir && /\.(docx|xlsx)$/i.test(n));
    } catch (e) {
      log(`  ❌ Batch ${b + 1} corrupt: ${e.message}`);
      failedBatches++;
      continue;
    }

    for (let j = 0; j < fileNames.length; j++) {
      const path = fileNames[j];
      const entry = batchZip.files[path];
      try {
        const buf = await entry.async('arraybuffer');
        const lower = path.toLowerCase();
        let blob;
        if (lower.endsWith('.xlsx')) {
          try {
            blob = await editXlsxArrayBuffer(buf, repl);
          } catch (err) {
            log(`   ⚠ ${path}: XLSX merge gagal, pakai asli — ${err.message}`);
            blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
          }
        } else {
          blob = await editDocxArrayBuffer(buf, repl);
        }

        const ext = lower.endsWith('.xlsx') ? '.xlsx' : '.docx';
        const baseName = sanitize(path.replace(/^.*\//, '').replace(/\.(docx|xlsx)$/i, '')) || 'file';
        let finalName = baseName + ext;
        let n = 2;
        while (usedNames.has(finalName)) {
          finalName = baseName + '_' + n + ext;
          n++;
        }
        usedNames.add(finalName);
        outZip.file(finalName, blob);
        totalSuccess++;
      } catch (e) {
        log(`   ❌ ${path}: ${e.message}`);
        totalFailed++;
      }

      const fileProgress = (j + 1) / fileNames.length;
      const pct = Math.round(batchStartPct + fileProgress * (75 / batches.length));
      setProgress(pct, `Proses ${j + 1}/${fileNames.length} (batch ${b + 1}/${batches.length})`);
    }

    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  if (totalSuccess === 0) {
    alert('Tidak ada file berhasil diproses. Cek Log Aktivitas.');
    log('❌ Semua file gagal diproses.');
    btn.disabled = false;
    hideProgress();
    return;
  }

  setProgress(85, `Membungkus ${totalSuccess} file...`);
  log(`\n📦 Membungkus ${totalSuccess} file...`);
  let finalBlob;
  try {
    finalBlob = await outZip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  } catch (e) {
    alert('Gagal membuat ZIP final: ' + e.message);
    log('❌ Gagal ZIP final: ' + e.message);
    btn.disabled = false;
    hideProgress();
    return;
  }

  setProgress(100, 'Selesai');

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const guru = sanitize(repl['[NamaGuru]'] || 'Guru');
  const outName = `ADM-Guru-${guru}-${stamp}.zip`;

  downloadBlob(finalBlob, outName);

  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  log(`✅ Selesai dalam ${dt}s`);
  log(`   Sukses: ${totalSuccess}, Gagal: ${totalFailed}, Batch gagal: ${failedBatches}`);
  log(`   File: ${outName} (${(finalBlob.size / 1024 / 1024).toFixed(2)} MB)`);

  if (allErrors.length) {
    log(`⚠ ${allErrors.length} file gagal dari server:`);
    allErrors.forEach(e => log(`  - ${e.id}: ${e.error}`));
  }
  if (failedBatches > 0 || totalFailed > 0) {
    alert(`Selesai dengan peringatan:\n• ${failedBatches} batch gagal\n• ${totalFailed} file gagal di-merge\n\nCek Log Aktivitas untuk detail.`);
  }

  fetchQuotaInfo();
  btn.disabled = false;
  hideProgress();
}

/* ============ KUOTA ============ */
async function fetchQuotaInfo() {
  if (!session) return;
  try {
    const json = await apiPost({ action: 'getQuota', userId: session.ID });
    quotaInfo = json;
    renderQuotaBadge();
  } catch (e) {
    log('⚠ Gagal muat info kuota: ' + e.message);
  }
}

function renderQuotaBadge() {
  const el = document.getElementById('quotaBadge');
  if (!el) return;
  if (!quotaInfo || !quotaInfo.user || !quotaInfo.global) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const u = quotaInfo.user;
  const g = quotaInfo.global;
  const habis = (u.remaining <= 0) || (g.remaining <= 0);
  el.classList.toggle('danger', habis);
  el.innerHTML = `
    <div>
      <i class="fas fa-tachometer-alt" style="color:${habis ? '#c62828' : '#1976d2'};"></i>
      <strong>Kuota Anda hari ini:</strong> ${u.used} / ${u.limit} file
      (sisa <strong>${u.remaining}</strong>)
      &nbsp;·&nbsp;
      <small>Sistem: ${g.used} / ${g.limit} (sisa ${g.remaining})</small>
    </div>
    <div><small>Reset: besok 00:00 WIB</small></div>
  `;
}

/* ============ MANAJEMEN USER (ADMIN) ============ */
async function loadAndRenderUsers() {
  if (!session || String(session.JenisUser).toLowerCase() !== 'admin') return;
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML = '<tr><td colspan="10" class="empty">Memuat...</td></tr>';
  try {
    const json = await apiPost({ action: 'listUsers', adminId: session.ID });
    const users = json.data || [];
    renderUsers(users);
    updatePendingBadge(users);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">❌ ${esc(e.message)}</td></tr>`;
    log('❌ Gagal load users: ' + e.message);
  }
}

function updatePendingBadge(users) {
  const badge = document.getElementById('pendingBadge');
  if (!badge) return;
  const n = (users || []).filter(u => String(u.Status).toLowerCase() === 'pending').length;
  if (n > 0) { badge.textContent = n; badge.style.display = ''; }
  else badge.style.display = 'none';
}

async function refreshPendingBadge() {
  if (!session || String(session.JenisUser).toLowerCase() !== 'admin') return;
  try {
    const json = await apiPost({ action: 'listUsers', adminId: session.ID });
    updatePendingBadge(json.data || []);
  } catch (e) { /* silent */ }
}

function renderUsers(users) {
  const tbody = document.getElementById('usersTbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Tidak ada user.</td></tr>';
    return;
  }
  const order = { 'pending': 0, 'aktif': 1, 'tidak aktif': 2 };
  users.sort((a, b) => {
    const sa = order[String(a.Status).toLowerCase()] ?? 9;
    const sb = order[String(b.Status).toLowerCase()] ?? 9;
    return sa - sb;
  });

  const myId = String(session.ID);
  const today = new Date().toISOString().slice(0, 10);

  tbody.innerHTML = users.map(u => {
    const status = String(u.Status).toLowerCase();
    const isSelf = String(u.ID) === myId;
    const isAdmin = String(u.JenisUser).toLowerCase() === 'admin';
    const statusClass = status === 'pending' ? 'pending' : status === 'aktif' ? 'aktif' : 'nonaktif';

    const usage = (u.TanggalUnduh === today) ? (Number(u.UnduhHariIni) || 0) : 0;
    const usageBadge = usage > 0
      ? `<span class="badge" style="background:#fff3e0;color:#e65100;">${usage} file</span>`
      : '<span style="color:#9aa9b9;">—</span>';

    let actions = '';
    if (isSelf) {
      actions = '<button class="secondary small" disabled><i class="fas fa-lock"></i> Anda</button>';
    } else if (status === 'pending') {
      actions = `
        <button class="green small" data-toggle="${esc(u.ID)}" data-status="aktif"><i class="fas fa-check"></i> Terima</button>
        <button class="danger small" data-toggle="${esc(u.ID)}" data-status="tidak aktif"><i class="fas fa-times"></i> Tolak</button>
      `;
    } else if (status === 'aktif') {
      actions = `<button class="danger small" data-toggle="${esc(u.ID)}" data-status="tidak aktif"><i class="fas fa-user-slash"></i> Nonaktifkan</button>`;
    } else {
      actions = `<button class="green small" data-toggle="${esc(u.ID)}" data-status="aktif"><i class="fas fa-user-check"></i> Aktifkan</button>`;
    }

    return `<tr>
      <td><span class="badge">${esc(u.ID)}</span></td>
      <td><b>${esc(u.Username)}</b>${isSelf ? ' <small style="color:#4fc3f7;">(Anda)</small>' : ''}</td>
      <td><span class="badge role-${isAdmin ? 'admin' : 'pelanggan'}">${esc(u.JenisUser)}</span></td>
      <td>${esc(u.UnitKerja || '—')}</td>
      <td>${esc(u.JenisGuru || '—')}</td>
      <td>${esc(u.Pelajaran || '—')}</td>
      <td>${esc(u.Kelas || '—')}</td>
      <td>${usageBadge}</td>
      <td><span class="badge status-${statusClass}">${esc(u.Status)}</span></td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleUserStatus(btn.dataset.toggle, btn.dataset.status, btn));
  });
}

async function toggleUserStatus(id, status, btn) {
  const label = status === 'aktif' ? 'mengaktifkan / menerima' : 'menonaktifkan / menolak';
  if (!confirm(`Yakin ${label} user ini?`)) return;
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  try {
    await apiPost({ action: 'setUserStatus', adminId: session.ID, id, status });
    log(`✓ User ${id} → ${status}`);
    await loadAndRenderUsers();
  } catch (e) {
    alert('Gagal: ' + e.message);
    log('❌ Gagal ubah status: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

document.getElementById('btnRefreshUsers').addEventListener('click', loadAndRenderUsers);

/* ============ MODAL TAMBAH USER ============ */
const userModal = document.getElementById('userModal');
document.getElementById('btnAddUser').addEventListener('click', () => userModal.classList.add('show'));
document.getElementById('btnCancelAddUser').addEventListener('click', () => userModal.classList.remove('show'));
document.getElementById('btnSaveUser').addEventListener('click', async () => {
  const payload = {
    action: 'saveUser',
    adminId: session.ID,
    username: document.getElementById('newUsername').value.trim(),
    password: document.getElementById('newPassword').value,
    jenisUser: document.getElementById('newJenisUser').value,
    unitKerja: document.getElementById('newUnitKerja').value.trim(),
    jenisGuru: document.getElementById('newJenisGuru').value,
    pelajaran: document.getElementById('newPelajaran').value,
    kelas: document.getElementById('newKelas').value
  };
  if (!payload.username || !payload.password) { alert('Username dan password wajib diisi.'); return; }
  const btn = document.getElementById('btnSaveUser');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan...';
  try {
    await apiPost(payload);
    userModal.classList.remove('show');
    ['newUsername','newPassword','newUnitKerja'].forEach(id => document.getElementById(id).value = '');
    log('✓ User baru ditambahkan: ' + payload.username);
    await loadAndRenderUsers();
  } catch (e) {
    alert('Gagal: ' + e.message);
    log('❌ Gagal tambah user: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Simpan';
  }
});

/* ============ IMPORT DRIVE ============ */
async function loadDriveConfig() {
  if (!session) return;
  try {
    const json = await apiPost({ action: 'getDriveConfig', adminId: session.ID });
    document.getElementById('driveUrl').value = json.url || '';
  } catch (e) {
    log('⚠ Gagal muat konfigurasi Drive: ' + e.message);
  }
}

document.getElementById('btnSaveDriveUrl')?.addEventListener('click', async () => {
  const url = document.getElementById('driveUrl').value.trim();
  try {
    await apiPost({ action: 'saveDriveConfig', adminId: session.ID, url });
    log(`✓ URL folder Drive disimpan oleh ${session.Username}`);
    alert(url ? '✅ URL folder disimpan.' : '✅ URL dikosongkan — kembali ke default.');
  } catch (e) {
    alert('Gagal: ' + e.message);
    log('❌ Simpan URL gagal: ' + e.message);
  }
});

document.getElementById('btnScanDrive')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnScanDrive');
  const info = document.getElementById('drivePreviewInfo');
  const wrap = document.getElementById('drivePreviewWrap');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
  info.innerHTML = '⏳ Membaca folder Drive... (10–30 detik untuk ~500 file)';
  wrap.style.display = 'none';
  document.getElementById('btnApplyDrive').disabled = true;
  try {
    const json = await apiPost({ action: 'scanDrive', adminId: session.ID });
    drivePreviewData = json.data || [];
    renderDrivePreview(drivePreviewData);
    document.getElementById('btnApplyDrive').disabled = drivePreviewData.length === 0;
    log(`✓ Scan selesai: ${drivePreviewData.length} file`);
  } catch (e) {
    info.innerHTML = '❌ ' + esc(e.message);
    log('❌ Scan gagal: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search"></i> Scan';
  }
});

function renderDrivePreview(rows) {
  const info = document.getElementById('drivePreviewInfo');
  const wrap = document.getElementById('drivePreviewWrap');
  if (!rows.length) {
    info.innerHTML = '⚠ Tidak ada file ditemukan. Cek struktur folder: Kelas 1–6, berisi .docx/.xlsx.';
    wrap.style.display = 'none';
    return;
  }
  const byKelas = {}, bySem = {};
  let nDocx = 0, nXlsx = 0;
  rows.forEach(r => {
    byKelas[r.kelas] = (byKelas[r.kelas] || 0) + 1;
    bySem[r.semester] = (bySem[r.semester] || 0) + 1;
    if (/\.xlsx$/i.test(r.nama_adm)) nXlsx++; else nDocx++;
  });
  const sumKelas = Object.keys(byKelas).sort().map(k => `K${k}: ${byKelas[k]}`).join(' · ');
  const sumSem = Object.keys(bySem).sort().map(k => k === '-' ? `Tanpa Semester: ${bySem[k]}` : `S${k}: ${bySem[k]}`).join(' · ');
  info.innerHTML = `
    ✅ <b>${rows.length} file ditemukan</b> (DOCX: ${nDocx}, XLSX: ${nXlsx})<br>
    <small style="color:#4a5a6e;">Per Kelas: ${sumKelas}</small><br>
    <small style="color:#4a5a6e;">Per Semester: ${sumSem}</small>
  `;
  wrap.style.display = 'block';
  const tbody = document.getElementById('drivePreviewTbody');
  const maxPreview = 200;
  const shown = rows.slice(0, maxPreview);
  tbody.innerHTML = shown.map((r, i) => {
    const isX = /\.xlsx$/i.test(r.nama_adm);
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(r.nama_adm)}</td>
      <td>${esc(r.kelas)}</td>
      <td>${r.semester === '-' ? '—' : 'S' + esc(r.semester)}</td>
      <td>${esc(r.mapel)}</td>
      <td><span class="badge type-${isX ? 'xlsx' : 'docx'}">${isX ? 'XLSX' : 'DOCX'}</span></td>
    </tr>`;
  }).join('') + (rows.length > maxPreview
    ? `<tr><td colspan="6" class="empty">... dan ${rows.length - maxPreview} file lainnya</td></tr>` : '');
}

document.getElementById('btnApplyDrive')?.addEventListener('click', async () => {
  if (!drivePreviewData || !drivePreviewData.length) return;
  if (!confirm(`Yakin? ${drivePreviewData.length} file akan ditulis ke sheet "data".\nSemua baris lama akan dihapus.`)) return;
  const btn = document.getElementById('btnApplyDrive');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menerapkan...';
  try {
    const json = await apiPost({ action: 'applyDrive', adminId: session.ID });
    alert(`✅ Selesai! ${json.total} file ditulis ke sheet "data".`);
    log(`✓ Apply selesai: ${json.total} baris oleh ${session.Username}`);
    drivePreviewData = null;
    listData = await fetchList();
    refreshFilters();
    selectedIds.clear();
    listData.forEach(r => selectedIds.add(String(r.id_adm)));
    renderTable();
    setStatus(`${listData.length} RPP tersedia`);
  } catch (e) {
    alert('Gagal: ' + e.message);
    log('❌ Apply gagal: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-check"></i> Terapkan ke Sheet';
  }
});

/* ============ LOG UNDUHAN (ADMIN) ============ */
async function loadLogUnduh() {
  if (!session || String(session.JenisUser).toLowerCase() !== 'admin') return;
  const limit = Number(document.getElementById('logUnduhLimit').value) || 100;
  const tbody = document.getElementById('logUnduhTbody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty">Memuat...</td></tr>';
  try {
    const json = await apiPost({ action: 'getLogUnduh', adminId: session.ID, limit });
    const rows = json.data || [];
    const stats = json.stats || {};
    renderLogUnduh(rows, stats);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">❌ ${esc(e.message)}</td></tr>`;
    log('❌ Gagal load log unduh: ' + e.message);
  }
}

function renderLogUnduh(rows, stats) {
  document.getElementById('logSumToday').textContent     = stats.todayFiles      ?? 0;
  document.getElementById('logSumRejected').textContent  = stats.todayRejected   ?? 0;
  document.getElementById('logSumRemaining').textContent = stats.globalRemaining ?? 0;

  const tbody = document.getElementById('logUnduhTbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Belum ada riwayat unduhan.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const status = String(r.status || '').toLowerCase();
    let statusBadge;
    if (status === 'sukses')             statusBadge = '<span class="badge status-aktif">Sukses</span>';
    else if (status === 'ditolak_limit') statusBadge = '<span class="badge status-nonaktif">Ditolak</span>';
    else if (status === 'gagal')         statusBadge = '<span class="badge status-pending">Gagal</span>';
    else                                  statusBadge = `<span class="badge">${esc(r.status)}</span>`;

    return `<tr>
      <td style="font-size:11px;">${esc(r.timestamp || '')}</td>
      <td><b>${esc(r.username || '—')}</b><br><small style="color:#7a8a9e;">${esc(r.userId || '')}</small></td>
      <td><b>${esc(r.jumlahFile || 0)}</b></td>
      <td>${esc(r.batchCount || 0)}</td>
      <td>${statusBadge}</td>
      <td style="font-size:12px; color:#4a5a6e;">${esc(r.keterangan || '')}</td>
    </tr>`;
  }).join('');
}

document.getElementById('btnRefreshLogUnduh')?.addEventListener('click', loadLogUnduh);
document.getElementById('logUnduhLimit')?.addEventListener('change', loadLogUnduh);

/* ============ TOGGLE PASSWORD ============ */
document.querySelectorAll('.toggle-pass').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const show = target.type === 'password';
    target.type = show ? 'text' : 'password';
    const icon = btn.querySelector('i');
    icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
    btn.title = show ? 'Sembunyikan password' : 'Lihat password';
  });
});

/* ============ INIT / BOOT ============ */
async function startApp() {
  try {
    listData = await fetchList();
    refreshFilters();
    listData.forEach(r => selectedIds.add(String(r.id_adm)));
    renderTable();
    setStatus(`${listData.length} RPP tersedia`);
    log(`✓ ${listData.length} baris dimuat.`);
  } catch (e) {
    setStatus('Gagal memuat');
    log('❌ ' + e.message);
    document.getElementById('tbody').innerHTML =
      '<tr><td colspan="7" class="empty">Gagal memuat. Klik "Sinkron Data".</td></tr>';
  }
  if (session && String(session.JenisUser).toLowerCase() === 'admin') {
    refreshPendingBadge();
  }
  fetchQuotaInfo();
}

async function boot() {
  const saved = loadSession();
  if (saved && String(saved.Status || '').toLowerCase() === 'aktif') {
    applySession();
    hideLogin();
    startApp();
  } else {
    clearSession();
    showLogin();
  }
}

/* ============ EVENT BINDINGS ============ */
document.getElementById('btnSync').addEventListener('click', async () => {
  try {
    listData = await fetchList();
    refreshFilters();
    selectedIds.clear();
    listData.forEach(r => selectedIds.add(String(r.id_adm)));
    renderTable();
    setStatus(`${listData.length} RPP tersedia`);
    log(`✓ Sinkron: ${listData.length} baris`);
  } catch (e) { log('❌ ' + e.message); }
});

document.getElementById('btnAll').addEventListener('click', () => {
  selectedIds.clear();
  getFilteredRows().forEach(r => selectedIds.add(String(r.id_adm)));
  renderTable();
});

document.getElementById('btnNone').addEventListener('click', () => {
  selectedIds.clear();
  renderTable();
});

document.getElementById('checkAll').addEventListener('change', e => {
  getFilteredRows().forEach(r => {
    if (e.target.checked) selectedIds.add(String(r.id_adm));
    else selectedIds.delete(String(r.id_adm));
  });
  renderTable();
});

document.getElementById('btnDownloadZip').addEventListener('click', handleDownloadZip);

['filterKelas','filterSemester','filterMapel'].forEach(id =>
  document.getElementById(id).addEventListener('change', () => {
    selectedIds.clear();
    getFilteredRows().forEach(r => selectedIds.add(String(r.id_adm)));
    renderTable();
  })
);

document.getElementById('btnClearLog').addEventListener('click', () => {
  logEl.textContent = 'Log dibersihkan.';
  log('Log dibersihkan.');
});

/* ============ BOOT ============ */
boot();