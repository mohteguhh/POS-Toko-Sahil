/* ==========================================================================
   KASIRKILAT POS LOGIC - FULL FEATURES & BATCH OPTIMIZATIONS
   ========================================================================== */

// Helper aman untuk parsing JSON dari LocalStorage agar aplikasi tidak crash jika data lokal corrupt
function safeJsonParse(key, fallback) {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed !== null && parsed !== undefined ? parsed : fallback;
  } catch (err) {
    console.warn(`Gagal parse data lokal "${key}", menggunakan nilai awal (fallback):`, err);
    return fallback;
  }
}

// --- State Aplikasi ---
let products = [];
let shifts = [];
let activeShift = null; // null jika tidak ada shift aktif
let customers = [];
let salesList = safeJsonParse('kasir_sales_list', []);
let salesDeliveries = safeJsonParse('kasir_sales_deliveries', []);
let salesReturns = safeJsonParse('kasir_sales_returns', []);
let loyaltySettings = safeJsonParse('kasir_loyalty_settings', {
  rewardMode: 'voucher', // 'voucher' (default) atau 'points'
  pointsPerRp: 50000,
  rpPerPoint: 100,
  voucherTarget: 'all', // 'all' (semua pelanggan) atau 'selected' (hanya member khusus)
  voucherRpValue: 10000, // 1 voucher = Rp 10.000
  voucherMonthlyQuota: 2 // 2 voucher / bulan
});

// Pastikan nilai default lengkap jika di-load dari versi lama
if (!loyaltySettings.rewardMode) loyaltySettings.rewardMode = 'voucher';
if (typeof loyaltySettings.voucherTarget === 'undefined') loyaltySettings.voucherTarget = 'all';
if (typeof loyaltySettings.voucherRpValue === 'undefined') loyaltySettings.voucherRpValue = 10000;
if (typeof loyaltySettings.voucherMonthlyQuota === 'undefined') loyaltySettings.voucherMonthlyQuota = 2;

let currentCustomerVoucherFilter = 'all'; // 'all' | 'used' | 'unused'

// Helper: dapatkan kode bulan kalender aktif saat ini (contoh: "2026-10")
function getCurrentMonthKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Helper: cek apakah seorang pelanggan berhak mendapatkan kuota voucher
function isCustomerEligibleForVoucher(customer) {
  if (!customer) return false;
  if (loyaltySettings.voucherTarget === 'all') return true;
  // Jika 'selected', hanya jika isVoucherEligible bernilai true (default true bila belum diset)
  return customer.isVoucherEligible !== false;
}

// Helper: hitung data voucher bulanan pelanggan (kuota, used, remaining)
function getCustomerMonthlyVoucherStats(customer, monthKey = getCurrentMonthKey()) {
  if (!customer || !isCustomerEligibleForVoucher(customer)) {
    return { quota: 0, used: 0, remaining: 0, eligible: false };
  }
  const quota = parseInt(loyaltySettings.voucherMonthlyQuota) || 0;
  const usageObj = (customer.voucherUsage && customer.voucherUsage[monthKey]) || { used: 0, transactions: [] };
  const used = parseInt(usageObj.used) || 0;
  const remaining = Math.max(0, quota - used);
  return { quota, used, remaining, eligible: true };
}

// --- Helper Gambar Offline (Flicker-Free) & Lightbox Perbesar Gambar ---
function handleImageError(img) {
  img.onerror = null; // Mencegah loop tak terbatas
  img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="%23cbd5e1" stroke-width="2"><rect width="100" height="100" fill="%23f8fafc"/><circle cx="50" cy="45" r="15"/><path d="M20,80 C20,60 80,60 80,80"/></svg>';
  img.style.cursor = 'default';
  img.onclick = null;
}

// Buka dialog lightbox perbesar gambar produk
function openProductImageLightbox(src, name = 'Gambar Produk') {
  if (!src || src.includes('data:image/svg+xml')) return;
  const modal = document.getElementById('product-image-lightbox-modal');
  const img = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');
  if (modal && img) {
    img.src = src;
    if (caption) caption.textContent = name;
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

// Tutup dialog lightbox perbesar gambar
function closeProductImageLightbox(event) {
  const modal = document.getElementById('product-image-lightbox-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function escapeJsQuotes(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
let cart = safeJsonParse('kasir_active_cart', []);
let lastTransactionChange = null;
let heldCarts = safeJsonParse('kasir_held_carts', []);
let transactions = []; // Riwayat transaksi lokal untuk analisis
let categories = ['All'];
let activeTab = 'pos'; // Default active tab
let activeCategory = 'All';

// State Pencarian POS
let filteredProducts = [];
let selectedFloatIndex = -1;
let selectedCartIndex = -1;

// State Pencarian Kulak
let kulakFilteredProducts = [];
let selectedKulakFloatIndex = -1;

// State Kamera Scanner
let html5QrcodeScanner = null;

// State Pemilihan Tombol Cetak Nota
let selectedReceiptButtonIndex = 0; // 0 = Cetak Nota, 1 = Kirim WA, 2 = Tutup
let currentActiveReceiptTx = null;
let currentActiveReceiptItems = [];

// State Cetak Label Harga Massal (Terpilih)
let selectedProductIds = new Set();
let lastScannedProductId = null; // ID produk terakhir di-scan barcode

// State Seleksi Massal Transaksi
let selectedTransactionIds = new Set();
// Mencegah transaksi yang baru dihapus ditarik kembali oleh snapshot RTDB (dipersist ke localStorage)
let recentlyDeletedTxIds = new Set(safeJsonParse('kasir_deleted_tx_ids', []));
function saveDeletedTxIdsLocally() {
  try {
    const arr = Array.from(recentlyDeletedTxIds);
    // Simpan maksimal 1000 ID terakhir agar localStorage tidak membengkak
    const trimmed = arr.slice(-1000);
    localStorage.setItem('kasir_deleted_tx_ids', JSON.stringify(trimmed));
  } catch(e) {}
}

// State Kasir & Multi-user (Fitur Baru)
let cashiers = safeJsonParse('kasir_cashiers', ['Kasir Utama', 'Kasir Shift 2', 'Kasir Shift 3']);
let activeCashier = localStorage.getItem('kasir_active_cashier') || 'Kasir Utama';

// Identitas Terminal POS / Nomor Komputer Kasir (untuk toko multi-komputer)
let isMultiPosEnabled = safeJsonParse('kasir_multi_pos_enabled', false);
let posTerminalName = localStorage.getItem('kasir_pos_terminal_name') || 'Kasir 1';

// Master Jam Operasional Shift Toko (Ditentukan oleh Owner)
let masterShiftSchedule = safeJsonParse('kasir_master_shift_schedule', {
  shift1: { name: 'Shift 1 (Pagi)', start: '07:00', end: '15:00' },
  shift2: { name: 'Shift 2 (Siang)', start: '15:00', end: '21:00' },
  shift3: { name: 'Shift 3 (Malam)', start: '21:00', end: '07:00' }
});

// --- MANAJEMEN LOGIN KARYAWAN & HAK AKSES ROLE (OWNER VS KASIR) ---
let isStaffLoginEnabled = safeJsonParse('kasir_staff_login_enabled', false);
let ownerPin = localStorage.getItem('kasir_owner_pin') || '1234';
let currentUserRole = localStorage.getItem('kasir_current_user_role') || 'owner'; // 'owner' atau 'staff'

// Master data akun karyawan beserta PIN dan izin tab masing-masing
let staffAccounts = safeJsonParse('kasir_staff_accounts', [
  {
    name: 'Kasir Utama',
    pin: '1111',
    permissions: {
      pos: true,
      transactions: true,
      products: false,
      kulak: false,
      customers: true,
      analytics: false,
      settings: false,
      opname: false,
      expenses: false,
      deleteTx: false,
      editPrice: false
    }
  },
  {
    name: 'Kasir Shift 2',
    pin: '2222',
    permissions: {
      pos: true,
      transactions: true,
      products: false,
      kulak: false,
      customers: true,
      analytics: false,
      settings: false,
      opname: false,
      expenses: false,
      deleteTx: false,
      editPrice: false
    }
  }
]);

// State Baru: Biaya Operasional & Kas Kecil, Stock Opname, Paket Bundling
let expenses = safeJsonParse('kasir_expenses', []);
let stockOpnames = safeJsonParse('kasir_stock_opnames', []);
let bundles = safeJsonParse('kasir_bundles', []);
let currentProductSubTab = 'catalog';

// --- LOGIKA FIREBASE REALTIME DATABASE ---
// Konfigurasi Firebase (hardcoded sebagai fallback permanen)
const DEFAULT_FB_CONFIG = {
  apiKey: "AIzaSyBFfdE-KIy6zg2BL0EyNjUKAB6xqkoKMpI",
  authDomain: "database-aplikasi-toko-sahil.firebaseapp.com",
  projectId: "database-aplikasi-toko-sahil",
  storageBucket: "database-aplikasi-toko-sahil.firebasestorage.app",
  messagingSenderId: "513609035060",
  appId: "1:513609035060:web:ec2afe8d5b6e4d14224961",
  measurementId: "G-H53BH3Y6DJ",
  databaseURL: "https://database-aplikasi-toko-sahil-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Database URL Realtime Database (hardcoded + override dari config)
const RTDB_URL = DEFAULT_FB_CONFIG.databaseURL;

// Pakai config dari localStorage jika ada, fallback ke hardcoded.
// Jika config lama di localStorage masih mengarah ke database lama (db-toko-sahil), migrasikan ke database baru secara otomatis.
let storedFbConfig = null;
try {
  storedFbConfig = JSON.parse(localStorage.getItem('kasir_firebase_config'));
} catch (e) {}

let fbConfig = storedFbConfig || DEFAULT_FB_CONFIG;
if (!fbConfig || fbConfig.projectId === 'db-toko-sahil' || !fbConfig.databaseURL) {
  fbConfig = { ...DEFAULT_FB_CONFIG };
}
// Simpan ke localStorage supaya form Settings ikut terisi
localStorage.setItem('kasir_firebase_config', JSON.stringify(fbConfig));

let firebaseDb = null;
let fbUnsubscribes = [];

let currentLicenseKey = localStorage.getItem('kasir_license_key') || '';
let currentLicenseData = null;
const ADMIN_WA_NUMBER = '6281559555594'; // Nomor WA Admin untuk konfirmasi pembayaran Rp 100.000/bln

// Helper Multi-Tenant: Memisahkan folder database per toko agar data tidak bentrok
function getStorePath(subPath = '') {
  const safeStoreKey = (currentLicenseKey || 'DEFAULT').replace(/[.#$\[\]\/]/g, '_');
  return subPath ? `stores/${safeStoreKey}/${subPath}` : `stores/${safeStoreKey}`;
}

async function initFirebase() {
  if (fbConfig) {
    const keyMap = {
      'fb-api-key': fbConfig.apiKey,
      'fb-auth-domain': fbConfig.authDomain,
      'fb-project-id': fbConfig.projectId,
      'fb-storage-bucket': fbConfig.storageBucket,
      'fb-messaging-sender-id': fbConfig.messagingSenderId,
      'fb-app-id': fbConfig.appId,
      'fb-database-url': fbConfig.databaseURL || RTDB_URL
    };
    Object.keys(keyMap).forEach(id => {
      const el = document.getElementById(id);
      if (el && keyMap[id]) el.value = keyMap[id];
    });
  }

  const licInput = document.getElementById('cloud-license-key');
  if (licInput) licInput.value = currentLicenseKey;

  if (typeof firebase === 'undefined') {
    console.warn('SDK Firebase tidak terdeteksi.');
    return false;
  }

  if (!fbConfig || !fbConfig.projectId || !fbConfig.apiKey) {
    console.log('Firebase belum dikonfigurasi.');
    return false;
  }

  try {
    if (firebase.apps.length > 0) {
      try { await firebase.app().delete(); } catch(e) {}
    }

    const databaseURL = fbConfig.databaseURL || RTDB_URL;
    firebase.initializeApp({ ...fbConfig, databaseURL });
    firebaseDb = firebase.database();

    console.log('✅ Firebase Realtime Database berhasil diinisialisasi.');

    // CEK VALIDITAS LISENSI LANGGANAN BULANAN (Rp 50.000 / Bulan)
    const isLicenseValid = await checkSubscriptionLicense();
    if (!isLicenseValid) {
      // Lisensi kedaluwarsa: Blokir operasi cloud, TETAPI tetap tampilkan panel
      // agar pengguna bisa melihat status lisensi, input nama toko / kode lisensi,
      // dan melihat tagihan pembayaran.
      console.warn('⛔ Masa langganan cloud telah habis. Panel tetap terbuka untuk input lisensi & tagihan.');
      if (fbUnsubscribes && fbUnsubscribes.length > 0) {
        fbUnsubscribes.forEach(unsub => unsub());
        fbUnsubscribes = [];
      }
      firebaseDb = null;

      // TETAP biarkan checkbox dan panel terbuka (jangan disable/sembunyikan)
      // supaya pengguna bisa input nama toko & melihat info tagihan
      const panel = document.getElementById('firebase-settings-panel');
      if (panel) panel.style.display = 'block';

      updateSyncStatus('offline', 'Mode Offline');
      const syncEl = document.getElementById('sync-status');
      if (syncEl) syncEl.title = 'Aplikasi Berjalan dalam Mode Offline (Data Tersimpan Lokal)';
      // Jangan paksa popup modal tagihan secara otomatis saat refresh/buka aplikasi
      // agar tidak mengganggu transaksi kasir offline & input pengguna
      return false;
    }

    setupDatabaseListeners();
    updateSyncStatus('online', 'Database Terhubung');
    return true;
  } catch (err) {
    console.error('Error inisialisasi Firebase:', err);
    updateSyncStatus('offline', 'Mode Offline');
    return false;
  }
}

// Pemeriksaan status lisensi ke Firebase Realtime Database
async function checkSubscriptionLicense() {
  if (!firebaseDb) return false;
  
  if (!currentLicenseKey || currentLicenseKey.trim() === '' || currentLicenseKey === 'DEFAULT') {
    updateSyncStatus('offline', 'Mode Offline');
    updateLicenseUI({ status: 'not_set', expired_at: null });
    return false;
  }

  const licenseRef = firebaseDb.ref('licenses/' + currentLicenseKey);
  try {
    const snapshot = await licenseRef.once('value');
    let lic = snapshot.val();
    
    // Keamanan: Client TIDAK boleh mengaktifkan lisensi gratis sendiri!
    // Lisensi harus sudah dibuat / disetujui oleh Developer di Firebase Console
    if (!lic) {
      console.warn('⛔ Kode lisensi toko tidak terdaftar di sistem.');
      updateSyncStatus('offline', 'Mode Offline');
      currentLicenseData = { status: 'unregistered', expired_at: null };
      updateLicenseUI(currentLicenseData);
      return false;
    }
    
    currentLicenseData = lic;
    updateLicenseUI(lic);

    // Cek status dan tanggal expired
    const expDate = new Date(lic.expired_at);
    const now = new Date();
    const isExpired = now.getTime() > expDate.getTime() || lic.status === 'expired' || lic.status === 'suspended';

    return !isExpired;
  } catch (e) {
    console.warn('Gagal memverifikasi lisensi cloud:', e.message);
    // Jika ada error jaringan atau security rule menolak, jangan izinkan akses cloud
    return false;
  }
}

function updateLicenseUI(lic) {
  const badge = document.getElementById('license-badge');
  const info = document.getElementById('license-expired-info');
  if (!lic) return;

  if (lic.status === 'not_set') {
    if (badge) {
      badge.textContent = 'Belum Diatur';
      badge.style.background = '#64748b';
    }
    if (info) {
      info.innerHTML = `Silakan masukkan Kode Lisensi Toko Anda lalu klik <b>Simpan Lisensi</b>.`;
    }
    return;
  }

  if (lic.status === 'unregistered') {
    if (badge) {
      badge.textContent = 'Tidak Terdaftar';
      badge.style.background = '#ef4444';
    }
    if (info) {
      info.innerHTML = `Kode lisensi tidak valid atau belum terdaftar di sistem.`;
    }
    return;
  }

  if (!lic.expired_at) return;

  const expDate = new Date(lic.expired_at);
  const now = new Date();
  const diffDays = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  const options = { day: 'numeric', month: 'long', year: 'numeric' };
  const expStr = expDate.toLocaleDateString('id-ID', options);

  if (diffDays <= 0) {
    if (badge) {
      badge.textContent = 'Mode Offline';
      badge.style.background = '#64748b';
    }
    if (info) {
      info.innerHTML = `Masa aktif cloud berakhir pada ${expStr}. Aplikasi beralih ke <b>Mode Offline</b> (Data tetap aman di komputer).`;
    }
  } else if (diffDays <= 3) {
    if (badge) {
      badge.textContent = `${diffDays} Hari Lagi`;
      badge.style.background = '#f59e0b';
    }
    if (info) {
      info.innerHTML = `Masa aktif sampai: <b>${expStr}</b> (<span style="color:#d97706; font-weight:700;">Segera perpanjang</span>)`;
    }
  } else {
    if (badge) {
      badge.textContent = 'Aktif';
      badge.style.background = '#10b981';
    }
    if (info) {
      info.innerHTML = `Masa aktif sampai: <b>${expStr}</b> (${diffDays} hari lagi)`;
    }
  }

  // Update modal tagihan
  const modalKey = document.getElementById('sub-modal-license-key');
  const modalDue = document.getElementById('sub-modal-due-date');
  if (modalKey) modalKey.textContent = currentLicenseKey;
  if (modalDue) modalDue.textContent = expStr + (diffDays <= 0 ? ' (Sudah Lewat)' : '');
}

function saveLicenseKey() {
  const input = document.getElementById('cloud-license-key');
  const val = input ? input.value.trim().toUpperCase() : '';
  if (!val) {
    alert('Kode lisensi tidak boleh kosong!');
    return;
  }

  const oldLicenseKey = currentLicenseKey;
  const isDifferentLicense = (oldLicenseKey && oldLicenseKey !== val);

  if (isDifferentLicense) {
    const confirmSwitch = confirm(`Anda berganti dari lisensi "${oldLicenseKey}" ke lisensi toko baru "${val}".\n\nApakah Anda ingin mengosongkan riwayat transaksi & rak lokal untuk toko baru ini agar data toko sebelumnya tidak ikut terunggah?`);
    if (confirmSwitch) {
      transactions = [];
      localStorage.setItem('kasir_transactions', JSON.stringify([]));
      customRacks = [];
      localStorage.setItem('kasir_custom_racks', JSON.stringify([]));
      salesDeliveries = [];
      localStorage.setItem('kasir_sales_deliveries', JSON.stringify([]));
      salesReturns = [];
      localStorage.setItem('kasir_sales_returns', JSON.stringify([]));
    }
  }

  currentLicenseKey = val;
  localStorage.setItem('kasir_license_key', currentLicenseKey);
  alert(`Kode lisensi "${val}" disimpan! Menguji status lisensi...`);
  
  // Selalu coba hubungkan & cek lisensi, bahkan jika firebaseDb null (misal: sebelumnya expired)
  initFirebase().then(connected => {
    if (connected) {
      alert('✅ Lisensi Aktif! Sinkronisasi cloud berjalan lancar.');
    }
    // Jika tidak connected, initFirebase sudah menampilkan modal tagihan
  });
}

function openSubscriptionInvoiceModal() {
  const modal = document.getElementById('subscription-modal');
  if (modal) modal.classList.add('active');
  if (currentLicenseData) {
    updateLicenseUI(currentLicenseData);
  }
}

function closeSubscriptionInvoiceModal() {
  const modal = document.getElementById('subscription-modal');
  if (modal) modal.classList.remove('active');
}

function contactAdminWhatsAppForRenewal() {
  const tokoName = receiptSettings.name || 'Toko';
  const text = `Halo Admin, saya ingin konfirmasi perpanjangan langganan Cloud POS (Rp 100.000 / Bulan)%0A%0A• Nama Toko: ${encodeURIComponent(tokoName)}%0A• Kode Lisensi: ${encodeURIComponent(currentLicenseKey)}%0A%0AMohon konfirmasi perpanjangan lisensi. Terima kasih.`;
  const url = `https://wa.me/${ADMIN_WA_NUMBER}?text=${text}`;
  window.open(url, '_blank');
}

// Helper hash sederhana untuk melindungi Master Key dari pencarian teks biasa
async function hashSecretStr(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const DEV_MASTER_HASH = "c7e9988d0ac79f466bf33b7bc5a8e31ebad2fe1f6e17c78919f5717acce44230"; // SHA256 dari 998877

async function promptDeveloperSecretKey() {
  const input = prompt('🔐 Masukkan Master Key Developer untuk membuka konfigurasi database:');
  if (input === null) return;
  const inputHash = await hashSecretStr(input.trim());
  if (inputHash === DEV_MASTER_HASH) {
    const lockedView = document.getElementById('dev-locked-view');
    const credPanel = document.getElementById('dev-credentials-panel');
    if (lockedView) lockedView.style.display = 'none';
    if (credPanel) credPanel.style.display = 'block';
    alert('🔓 Akses Diterima. Konfigurasi database developer berhasil dibuka.');
  } else {
    alert('⛔ Kode salah! Anda tidak memiliki izin untuk melihat atau mengubah konfigurasi database.');
  }
}

function lockDeveloperSecretSection() {
  const lockedView = document.getElementById('dev-locked-view');
  const credPanel = document.getElementById('dev-credentials-panel');
  if (lockedView) lockedView.style.display = 'flex';
  if (credPanel) credPanel.style.display = 'none';
}

async function saveFirebaseConfig() {
  const apiKey = document.getElementById('fb-api-key')?.value.trim();
  const authDomain = document.getElementById('fb-auth-domain')?.value.trim();
  const projectId = document.getElementById('fb-project-id')?.value.trim();
  const storageBucket = document.getElementById('fb-storage-bucket')?.value.trim();
  const messagingSenderId = document.getElementById('fb-messaging-sender-id')?.value.trim();
  const appId = document.getElementById('fb-app-id')?.value.trim();
  let databaseURL = document.getElementById('fb-database-url')?.value.trim() || RTDB_URL;

  // Pembersihan otomatis jika user menyalin link dari browser console Firebase
  if (databaseURL.includes('console.firebase.google.com')) {
    // Ekstrak nama project dari URL console jika tertempel tidak sengaja
    const match = databaseURL.match(/project\/([^\/]+)\/database\/([^\/]+)/);
    if (match && match[2]) {
      databaseURL = `https://${match[2]}.asia-southeast1.firebasedatabase.app`;
    }
  }
  // Hapus tanda garis miring di akhir (trailing slash)
  databaseURL = databaseURL.replace(/\/+$/, '');

  if (!projectId || !apiKey) {
    alert('❌ API Key dan Project ID wajib diisi!');
    return;
  }

  fbConfig = { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, databaseURL };
  localStorage.setItem('kasir_firebase_config', JSON.stringify(fbConfig));

  updateSyncStatus('syncing', 'Menghubungkan Firebase...');
  const success = await initFirebase();

  if (success) {
    alert('✅ Konfigurasi Firebase berhasil disimpan & terhubung ke Realtime Database!');
  } else {
    alert('❌ Gagal mengkoneksikan Firebase. Periksa kembali konfigurasi Anda.');
  }
}

async function testFirebaseConnection() {
  if (!firebaseDb) {
    const success = await initFirebase();
    if (!success) {
      alert('❌ Firebase belum terhubung.');
      return;
    }
  }
  updateSyncStatus('syncing', 'Menguji koneksi...');
  try {
    await firebaseDb.ref('.info/connected').once('value');
    updateSyncStatus('online', 'Database Terhubung');
    alert('🚀 Uji Koneksi BERHASIL! Aplikasi terhubung ke Firebase Realtime Database.');
  } catch (err) {
    updateSyncStatus('offline', 'Koneksi Gagal');
    alert('❌ Uji Koneksi Gagal: ' + err.message);
  }
}

function parseTxDate(waktu) {
  if (!waktu) return new Date();
  if (typeof waktu === 'object') {
    if (typeof waktu.toDate === 'function') return waktu.toDate();
    if (waktu.seconds !== undefined) return new Date(waktu.seconds * 1000);
  }
  if (typeof waktu === 'number') return new Date(waktu);
  const d = new Date(waktu);
  return isNaN(d.getTime()) ? new Date() : d;
}

function setupDatabaseListeners() {
  if (!firebaseDb) return;

  // Hentikan semua listener lama
  fbUnsubscribes.forEach(unsub => unsub());
  fbUnsubscribes = [];

  console.log(`🔥 Menyiapkan listener Realtime Database untuk toko: ${currentLicenseKey}...`);

  // ─── LISTENER PRODUK ──────────────────────────────────────────────────────
  const prodRef = firebaseDb.ref(getStorePath('products'));
  const prodCallback = snapshot => {
    const data = snapshot.val();
    if (data) {
      const cloudProds = Object.values(data);
      console.log(`📦 RTDB produk (${currentLicenseKey}): ${cloudProds.length}`);
      products = cloudProds;
      saveProductsLocally();
      updateCategoriesList();
      updateRacksList();
      if (typeof renderProductsTable === 'function') renderProductsTable();
      if (typeof renderPosProducts === 'function') renderPosProducts();
    }
  };
  prodRef.on('value', prodCallback, err => console.error('❌ RTDB Products Error:', err.message));
  fbUnsubscribes.push(() => prodRef.off('value', prodCallback));

  // ─── LISTENER TRANSAKSI ───────────────────────────────────────────────────
  const txRef = firebaseDb.ref(getStorePath('transactions'));
  const txCallback = snapshot => {
    const data = snapshot.val();
    const cloudTxs = data ? Object.values(data) : [];
    
    // Jika cloud kosong tapi di lokal browser ada transaksi (misal: habis restore backup database),
    // jangan hapus transaksi lokal! Unggah data lokal ke cloud agar sinkron.
    if (cloudTxs.length === 0 && Array.isArray(transactions) && transactions.length > 0) {
      console.log(`⚠️ RTDB cloud transaksi kosong untuk toko ${currentLicenseKey}, menyinkronkan ${transactions.length} transaksi lokal ke cloud.`);
      const backupUpdates = {};
      transactions.forEach(t => {
        if (t && t.id) {
          backupUpdates[getStorePath('transactions/' + t.id)] = JSON.parse(JSON.stringify(t));
        }
      });
      if (Object.keys(backupUpdates).length > 0) {
        firebaseDb.ref('/').update(backupUpdates).catch(e => console.warn('Gagal sync restore ke cloud:', e));
      }
      return;
    }

    // Transaksi dari cloud adalah sumber kebenaran (authoritative)
    const txMap = new Map();
    cloudTxs.forEach(tx => {
      const id = tx.id || tx.id_transaksi;
      if (id && !recentlyDeletedTxIds.has(id)) {
        txMap.set(id, { ...tx, id });
      }
    });

    const mergedTxs = Array.from(txMap.values());
    mergedTxs.sort((a, b) => parseTxDate(b.waktu).getTime() - parseTxDate(a.waktu).getTime());
    console.log(`🧾 RTDB transaksi aktif (${currentLicenseKey}): ${mergedTxs.length}`);
    transactions = mergedTxs;
    saveTransactionsLocally();
    if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
    if (typeof renderCustomerDebtBook === 'function') renderCustomerDebtBook();
    if (typeof initAnalyticsFilter === 'function') initAnalyticsFilter();
    if (typeof updateAnalytics === 'function') updateAnalytics();
  };
  txRef.on('value', txCallback, err => console.error('❌ RTDB Transactions Error:', err.message));
  fbUnsubscribes.push(() => txRef.off('value', txCallback));

  // ─── LISTENER PELANGGAN ───────────────────────────────────────────────────
  const custRef = firebaseDb.ref(getStorePath('customers'));
  const custCallback = snapshot => {
    const data = snapshot.val();
    if (data) {
      customers = Object.values(data);
      saveCustomersLocally();
      if (typeof renderCustomersTable === 'function') renderCustomersTable();
    }
  };
  custRef.on('value', custCallback, err => console.error('❌ RTDB Customers Error:', err.message));
  fbUnsubscribes.push(() => custRef.off('value', custCallback));

  // ─── LISTENER SHIFTS ──────────────────────────────────────────────────────
  const shiftRef = firebaseDb.ref(getStorePath('shifts'));
  const shiftCallback = snapshot => {
    const data = snapshot.val();
    if (data) {
      shifts = Object.values(data);
      localStorage.setItem('kasir_shifts', JSON.stringify(shifts));
    }
  };
  shiftRef.on('value', shiftCallback, err => console.error('❌ RTDB Shifts Error:', err.message));
  fbUnsubscribes.push(() => shiftRef.off('value', shiftCallback));

  // ─── LISTENER KATEGORI ──────────────────────────────────────────────────
  const catRef = firebaseDb.ref(getStorePath('categories'));
  const catCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      customCategories = Array.from(new Set([...customCategories, ...data]));
      localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
      updateCategoriesList();
    }
  };
  catRef.on('value', catCallback, err => console.error('❌ RTDB Categories Error:', err.message));
  fbUnsubscribes.push(() => catRef.off('value', catCallback));

  // ─── LISTENER LOKASI RAK ──────────────────────────────────────────────────
  const rackRef = firebaseDb.ref(getStorePath('racks'));
  const rackCallback = snapshot => {
    const data = snapshot.val();
    if (data !== null && data !== undefined) {
      if (Array.isArray(data)) {
        customRacks = data;
      } else if (typeof data === 'object') {
        customRacks = Object.values(data);
      } else {
        customRacks = [];
      }
      localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
      updateRacksList();
    }
  };
  rackRef.on('value', rackCallback, err => console.error('❌ RTDB Racks Error:', err.message));
  fbUnsubscribes.push(() => rackRef.off('value', rackCallback));

  // ─── LISTENER REKANAN SALES ───────────────────────────────────────────────
  const salesRef = firebaseDb.ref(getStorePath('salesList'));
  const salesCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      salesList = data;
      localStorage.setItem('kasir_sales_list', JSON.stringify(salesList));
      if (typeof renderSalesTable === 'function') renderSalesTable();
    }
  };
  salesRef.on('value', salesCallback, err => console.error('❌ RTDB Sales Error:', err.message));
  fbUnsubscribes.push(() => salesRef.off('value', salesCallback));

  // ─── LISTENER NOTA KIRIM / PEMBELIAN SALES ────────────────────────────────
  const salesDelivRef = firebaseDb.ref(getStorePath('salesDeliveries'));
  const salesDelivCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      salesDeliveries = data;
      localStorage.setItem('kasir_sales_deliveries', JSON.stringify(salesDeliveries));
      if (typeof renderSalesDeliveriesTable === 'function') renderSalesDeliveriesTable();
      if (typeof renderSalesRekapView === 'function') renderSalesRekapView();
    }
  };
  salesDelivRef.on('value', salesDelivCallback, err => console.error('❌ RTDB Deliveries Error:', err.message));
  fbUnsubscribes.push(() => salesDelivRef.off('value', salesDelivCallback));

  // ─── LISTENER RETUR SALES ─────────────────────────────────────────────────
  const salesReturnRef = firebaseDb.ref(getStorePath('salesReturns'));
  const salesReturnCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      salesReturns = data;
      localStorage.setItem('kasir_sales_returns', JSON.stringify(salesReturns));
      if (typeof renderSalesReturnsTable === 'function') renderSalesReturnsTable();
    }
  };
  salesReturnRef.on('value', salesReturnCallback, err => console.error('❌ RTDB Returns Error:', err.message));
  fbUnsubscribes.push(() => salesReturnRef.off('value', salesReturnCallback));

  // ─── LISTENER PENGATURAN TOKO & BRANDING ──────────────────────────────────
  const settingsRef = firebaseDb.ref(getStorePath('settings/receipt'));
  const settingsCallback = snapshot => {
    const data = snapshot.val();
    if (data && typeof data === 'object') {
      receiptSettings = { ...receiptSettings, ...data };
      localStorage.setItem('kasir_receipt_settings', JSON.stringify(receiptSettings));
      if (typeof applyReceiptSettings === 'function') applyReceiptSettings();
      if (typeof loadReceiptSettings === 'function') {
        const nameInp = document.getElementById('store-name-input');
        if (nameInp) loadReceiptSettings();
      }
    }
  };
  settingsRef.on('value', settingsCallback, err => console.error('❌ RTDB Settings Error:', err.message));
  fbUnsubscribes.push(() => settingsRef.off('value', settingsCallback));

  // ─── LISTENER PENGATURAN LOYALITAS & VOUCHER ──────────────────────────────
  const loyaltyRef = firebaseDb.ref(getStorePath('settings/loyalty'));
  const loyaltyCallback = snapshot => {
    const data = snapshot.val();
    if (data && typeof data === 'object') {
      loyaltySettings = { ...loyaltySettings, ...data };
      localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
      if (typeof syncLoyaltySettingsUI === 'function') syncLoyaltySettingsUI();
      if (typeof renderCustomersTable === 'function') renderCustomersTable();
      if (typeof renderPosProducts === 'function') renderPosProducts();
    }
  };
  loyaltyRef.on('value', loyaltyCallback, err => console.error('❌ RTDB Loyalty Settings Error:', err.message));
  fbUnsubscribes.push(() => loyaltyRef.off('value', loyaltyCallback));

  // ─── LISTENER PENGATURAN SISTEM TOKO (appConfig) ──────────────────────────
  const appConfigRef = firebaseDb.ref(getStorePath('settings/appConfig'));
  const appConfigCallback = snapshot => {
    const data = snapshot.val();
    if (data && typeof data === 'object') {
      appConfig = { ...appConfig, ...data };
      localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
      if (typeof loadAppConfig === 'function') {
        try { loadAppConfig(); } catch (e) {}
      }
    }
  };
  appConfigRef.on('value', appConfigCallback, err => console.error('❌ RTDB AppConfig Error:', err.message));
  fbUnsubscribes.push(() => appConfigRef.off('value', appConfigCallback));

  // ─── LISTENER BIAYA OPERASIONAL & KAS KECIL ──────────────────────────────
  const expensesRef = firebaseDb.ref(getStorePath('expenses'));
  const expensesCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      expenses = data;
      localStorage.setItem('kasir_expenses', JSON.stringify(expenses));
      if (typeof renderExpensesTable === 'function') renderExpensesTable();
    }
  };
  expensesRef.on('value', expensesCallback, err => console.error('❌ RTDB Expenses Error:', err.message));
  fbUnsubscribes.push(() => expensesRef.off('value', expensesCallback));

  // ─── LISTENER RIWAYAT STOCK OPNAME ─────────────────────────────────────────
  const opnameRef = firebaseDb.ref(getStorePath('stockOpnames'));
  const opnameCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      stockOpnames = data;
      localStorage.setItem('kasir_stock_opnames', JSON.stringify(stockOpnames));
      if (typeof renderStockOpnameHistoryTable === 'function') renderStockOpnameHistoryTable();
    }
  };
  opnameRef.on('value', opnameCallback, err => console.error('❌ RTDB Opname Error:', err.message));
  fbUnsubscribes.push(() => opnameRef.off('value', opnameCallback));

  // ─── LISTENER PAKET BUNDLING ──────────────────────────────────────────────
  const bundlesRef = firebaseDb.ref(getStorePath('bundles'));
  const bundlesCallback = snapshot => {
    const data = snapshot.val();
    if (data && Array.isArray(data)) {
      bundles = data;
      localStorage.setItem('kasir_bundles', JSON.stringify(bundles));
      if (typeof renderBundlesTable === 'function') renderBundlesTable();
    }
  };
  bundlesRef.on('value', bundlesCallback, err => console.error('❌ RTDB Bundles Error:', err.message));
  fbUnsubscribes.push(() => bundlesRef.off('value', bundlesCallback));

  console.log(`✅ Semua listener Realtime Database aktif untuk toko: ${currentLicenseKey}`);
}

// Alias untuk kompatibilitas panggilan lama
function setupFirestoreListeners() { setupDatabaseListeners(); }

// --- DIALOG PILIHAN SINKRONISASI DATA (PRODUK VS TRANSAKSI) ---
function openSyncOptionsModal() {
  const modal = document.getElementById('sync-options-modal');
  if (modal) {
    modal.style.display = 'flex';
    // Default: produk & settings tercentang, transaksi tidak tercentang (aman untuk toko baru)
    const chkProd = document.getElementById('sync-opt-products');
    const chkTx = document.getElementById('sync-opt-transactions');
    const chkSet = document.getElementById('sync-opt-settings');
    if (chkProd) chkProd.checked = true;
    if (chkTx) chkTx.checked = false;
    if (chkSet) chkSet.checked = true;

    const alertBox = document.getElementById('sync-modal-alert-box');
    if (alertBox) {
      alertBox.style.display = 'block';
      alertBox.style.background = '#fff7ed';
      alertBox.style.border = '1px solid #fed7aa';
      alertBox.style.color = '#c2410c';
      alertBox.innerHTML = `💡 <strong>Tips Toko Baru:</strong> Biarkan opsi <em>"Riwayat Transaksi"</em> tidak tercentang agar transaksi toko baru Anda tetap bersih mulai dari 0.`;
    }
  }
}

function closeSyncOptionsModal() {
  const modal = document.getElementById('sync-options-modal');
  if (modal) modal.style.display = 'none';
}

async function executeSyncWithOptions() {
  const syncProducts = document.getElementById('sync-opt-products')?.checked || false;
  const syncTransactions = document.getElementById('sync-opt-transactions')?.checked || false;
  const syncSettings = document.getElementById('sync-opt-settings')?.checked || false;

  if (!syncProducts && !syncTransactions && !syncSettings) {
    alert('Silakan pilih minimal satu jenis data yang ingin disinkronkan.');
    return;
  }

  if (!firebaseDb) {
    const ok = await initFirebase();
    if (!ok) {
      alert('Firebase belum terhubung. Silakan periksa koneksi internet & lisensi.');
      return;
    }
  }

  closeSyncOptionsModal();
  updateSyncStatus('syncing', 'Menyinkronkan data terpilih...');

  try {
    let summaryMsgs = [];

    // 1. SINKRONISASI PRODUK
    if (syncProducts) {
      const prodSnapshot = await firebaseDb.ref(getStorePath('products')).once('value');
      const cloudProductsData = prodSnapshot.val();
      if (cloudProductsData) {
        const cloudProducts = Object.values(cloudProductsData);
        if (cloudProducts.length > 0) {
          products = cloudProducts;
          saveProductsLocally();
          if (typeof renderProductsTable === 'function') renderProductsTable();
          if (typeof renderPosProducts === 'function') renderPosProducts();
          summaryMsgs.push(`📦 ${cloudProducts.length} Produk`);
        }
      } else if (products.length > 0) {
        // Upload master produk lokal ke cloud jika di cloud masih kosong
        const updates = {};
        products.forEach(p => {
          if (p && p.id) updates[getStorePath('products/' + p.id)] = JSON.parse(JSON.stringify(p));
        });
        await firebaseDb.ref('/').update(updates);
        summaryMsgs.push(`📦 ${products.length} Produk diunggah ke cloud`);
      }
    }

    // 2. SINKRONISASI TRANSAKSI
    if (syncTransactions) {
      const txSnapshot = await firebaseDb.ref(getStorePath('transactions')).once('value');
      const cloudTxData = txSnapshot.val();
      if (cloudTxData) {
        const cloudTxs = Object.values(cloudTxData);
        cloudTxs.sort((a, b) => parseTxDate(b.waktu).getTime() - parseTxDate(a.waktu).getTime());
        transactions = cloudTxs;
        saveTransactionsLocally();
        if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
        if (typeof initAnalyticsFilter === 'function') initAnalyticsFilter();
        if (typeof updateAnalytics === 'function') updateAnalytics();
        summaryMsgs.push(`🧾 ${cloudTxs.length} Transaksi`);
      } else {
        transactions = [];
        saveTransactionsLocally();
        if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
        summaryMsgs.push(`🧾 0 Transaksi (Cloud Kosong)`);
      }
    } else {
      // Jika pengguna MENOLAK sinkronisasi transaksi, kosongkan transaksi agar toko baru bersih
      console.log('User memilih untuk TIDAK menyinkronkan transaksi lama.');
      summaryMsgs.push(`🧾 Transaksi lama ditolak (Tetap Bersih)`);
    }

    // 3. SINKRONISASI PENGATURAN & CUSTOMERS
    if (syncSettings) {
      // Receipt
      const receiptSnap = await firebaseDb.ref(getStorePath('settings/receipt')).once('value');
      const rData = receiptSnap.val();
      if (rData) {
        receiptSettings = { ...receiptSettings, ...rData };
        localStorage.setItem('kasir_receipt_settings', JSON.stringify(receiptSettings));
        if (typeof updateNavbarBrandUI === 'function') updateNavbarBrandUI();
      }

      // Loyalty
      const loyaltySnap = await firebaseDb.ref(getStorePath('settings/loyalty')).once('value');
      const lData = loyaltySnap.val();
      if (lData) {
        loyaltySettings = { ...loyaltySettings, ...lData };
        localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
        if (typeof syncLoyaltySettingsUI === 'function') syncLoyaltySettingsUI();
      }

      // App Config / Pengaturan Sistem
      const appConfigSnap = await firebaseDb.ref(getStorePath('settings/appConfig')).once('value');
      const acData = appConfigSnap.val();
      if (acData) {
        appConfig = { ...appConfig, ...acData };
        localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
        if (typeof loadAppConfig === 'function') {
          try { loadAppConfig(); } catch (e) {}
        }
      }

      // Customers
      const custSnap = await firebaseDb.ref(getStorePath('customers')).once('value');
      const cData = custSnap.val();
      if (cData) {
        customers = Object.values(cData);
        saveCustomersLocally();
        if (typeof renderCustomersTable === 'function') renderCustomersTable();
      }
      summaryMsgs.push(`⚙️ Pengaturan & Pelanggan CRM`);
    }

    // Aktifkan listener realtime
    setupDatabaseListeners();
    updateSyncStatus('online', 'Database Terhubung');

    alert(`✅ Sinkronisasi Berhasil!\n\nData yang telah diselaraskan:\n• ${summaryMsgs.join('\n• ')}`);
  } catch (err) {
    console.error('❌ Gagal sinkronisasi data terpilih:', err);
    updateSyncStatus('offline', 'Gagal Sync: ' + err.message);
    alert('❌ Terjadi kesalahan saat sinkronisasi:\n\n' + err.message);
  }
}

// Buka dialog konfirmasi saat klik status sync di header
function syncAllFromCloud() {
  openSyncOptionsModal();
}

// Buka dialog saat klik tombol sync dari pane transaksi
function syncTransactionsFromCloud() {
  openSyncOptionsModal();
}

// Reset filter pencarian tabel riwayat transaksi
function clearTransactionFilters() {
  const searchInput = document.getElementById('transaction-list-search');
  const startDate = document.getElementById('tx-filter-start-date');
  const endDate = document.getElementById('tx-filter-end-date');
  const statusSelect = document.getElementById('tx-filter-status');

  if (searchInput) searchInput.value = '';
  if (startDate) startDate.value = '';
  if (endDate) endDate.value = '';
  if (statusSelect) statusSelect.value = 'Semua';

  if (typeof renderTransactionsTable === 'function') {
    renderTransactionsTable();
  }
}

// Hapus cache lokal & muat ulang aplikasi
function clearLocalCache() {
  if (confirm("⚠️ APAKAH ANDA YAKIN?\n\nSemua cache sementara lokal browser akan dibersihkan dan halaman akan dimuat ulang.")) {
    localStorage.removeItem('kasir_active_cart');
    localStorage.removeItem('kasir_held_carts');
    sessionStorage.clear();
    alert("✅ Cache lokal berhasil dibersihkan!");
    location.reload();
  }
}



async function syncSingleTransactionToCloud(tx) {
  if (!tx) return;

  if (!firebaseDb) {
    console.warn('Firebase Realtime Database belum terhubung.');
    updateSyncStatus('offline', 'Firebase Belum Terhubung');
    return;
  }

  updateSyncStatus('syncing', 'Mengunggah Transaksi...');
  try {
    const cleanTx = JSON.parse(JSON.stringify(tx));

    // Simpan transaksi ke RTDB toko
    await firebaseDb.ref(getStorePath('transactions/' + cleanTx.id)).set(cleanTx);

    // Update stok produk & komponen bundling di RTDB toko secara bersamaan
    if (Array.isArray(cleanTx.items)) {
      const stockUpdates = {};
      cleanTx.items.forEach(item => {
        if (item.isBundle && Array.isArray(item.bundleItems)) {
          item.bundleItems.forEach(bComp => {
            const compProd = products.find(p => String(p.id) === String(bComp.productId));
            if (compProd) {
              stockUpdates[getStorePath('products/' + compProd.id + '/stok')] = compProd.stok;
            }
          });
        } else if (item.id) {
          const p = products.find(prod => String(prod.id) === String(item.id));
          if (p) {
            stockUpdates[getStorePath('products/' + p.id + '/stok')] = p.stok;
            stockUpdates[getStorePath('products/' + p.id + '/kuota_diskon')] = p.kuota_diskon || 0;
          }
        }
      });
      if (Object.keys(stockUpdates).length > 0) {
        await firebaseDb.ref('/').update(stockUpdates);
      }
    }

    updateSyncStatus('online', 'Database Terhubung');
    console.log(`✅ Transaksi tersimpan di RTDB (${currentLicenseKey}):`, cleanTx.id);
  } catch (err) {
    console.error('Gagal simpan transaksi ke RTDB:', err);
    updateSyncStatus('offline', 'Gagal Unggah');
    throw err;
  }
}

async function syncTransactionToCloud(tx) {
  return syncSingleTransactionToCloud(tx);
}

async function saveCustomerCloud(customer) {
  if (!customer || !firebaseDb) return;
  try {
    const cleanCust = JSON.parse(JSON.stringify(customer));
    const custKey = cleanCust.id || cleanCust.no_hp || ('CUST-' + Date.now());
    await firebaseDb.ref(getStorePath('customers/' + custKey)).set(cleanCust);
  } catch (err) {
    console.error('Gagal simpan pelanggan ke RTDB:', err);
  }
}

async function deleteCustomerCloud(customerId) {
  if (!customerId || !firebaseDb) return;
  try {
    await firebaseDb.ref(getStorePath('customers/' + customerId)).remove();
  } catch (err) {
    console.error('Gagal hapus pelanggan di RTDB:', err);
  }
}

async function syncCustomersToCloud() {
  if (!firebaseDb) {
    alert('Firebase Realtime Database belum terhubung. Silakan atur di Pengaturan.');
    return;
  }
  if (!customers || customers.length === 0) {
    alert('Tidak ada data pelanggan lokal untuk diunggah.');
    return;
  }
  updateSyncStatus('syncing', 'Mengunggah semua pelanggan...');
  try {
    const updates = {};
    customers.forEach(c => {
      const clean = JSON.parse(JSON.stringify(c));
      const key = clean.id || clean.no_hp || ('CUST-' + Date.now());
      updates[getStorePath('customers/' + key)] = clean;
    });
    await firebaseDb.ref('/').update(updates);
    updateSyncStatus('online', 'Database Terhubung');
    alert(`Berhasil menyinkronkan ${customers.length} data pelanggan ke Firebase Realtime Database! 🚀`);
  } catch (err) {
    console.error('Gagal sync pelanggan:', err);
    alert('Gagal menyinkronkan pelanggan: ' + err.message);
  }
}

async function saveProductCloud(product) {
  if (!firebaseDb || !product) return;
  updateSyncStatus('syncing', 'Mengunggah Produk...');
  try {
    const cleanProduct = JSON.parse(JSON.stringify(product));
    await firebaseDb.ref(getStorePath('products/' + cleanProduct.id)).set(cleanProduct);
    updateSyncStatus('online', 'Database Terhubung');
  } catch (err) {
    console.error('Gagal simpan produk ke RTDB:', err);
    updateSyncStatus('offline', 'Gagal Unggah Produk');
  }
}

async function deleteProductCloud(productId) {
  if (!firebaseDb) return;
  updateSyncStatus('syncing', 'Menghapus Produk...');
  try {
    await firebaseDb.ref(getStorePath('products/' + productId)).remove();
    updateSyncStatus('online', 'Database Terhubung');
  } catch (err) {
    console.error('Gagal hapus produk dari RTDB:', err);
    updateSyncStatus('offline', 'Gagal Hapus Produk');
  }
}

async function migrateLocalDataToFirebase() {
  if (!firebaseDb) {
    alert('Firebase belum terhubung. Harap lengkapi & simpan form Konfigurasi Firebase terlebih dahulu.');
    return;
  }

  if (!confirm(`Apakah Anda yakin ingin memindahkan data ke Firebase Realtime Database?\n- ${products.length} Produk\n- ${transactions.length} Transaksi\n- ${customers.length} Pelanggan\n- ${shifts.length} Shift Kasir`)) {
    return;
  }

  updateSyncStatus('syncing', 'Memulai migrasi ke Realtime Database...');

  try {
    // Bangun objek update besar sekaligus (1 request = efisien)
    const updates = {};
    products.forEach(p => {
      const clean = JSON.parse(JSON.stringify(p));
      updates[getStorePath('products/' + clean.id)] = clean;
    });
    transactions.forEach(t => {
      const clean = JSON.parse(JSON.stringify(t));
      updates[getStorePath('transactions/' + clean.id)] = clean;
    });
    customers.forEach(c => {
      const clean = JSON.parse(JSON.stringify(c));
      updates[getStorePath('customers/' + (clean.id || clean.no_hp))] = clean;
    });
    shifts.forEach(s => {
      const clean = JSON.parse(JSON.stringify(s));
      const sId = clean.id_shift || ('SH-' + Date.now());
      updates[getStorePath('shifts/' + sId)] = clean;
    });

    // Pastikan data lisensi juga ikut terunggah
    const now = new Date();
    const defaultExpiry = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
    updates['licenses/' + currentLicenseKey] = {
      status: 'active',
      nama_toko: receiptSettings.name || 'Toko Sahil',
      created_at: now.toISOString(),
      expired_at: defaultExpiry.toISOString(),
      harga_per_bulan: 50000
    };

    await firebaseDb.ref('/').update(updates);
    const total = products.length + transactions.length + customers.length + shifts.length;
    updateSyncStatus('online', 'Database Terhubung');
    alert(`⚡ Selesai! Berhasil mengunggah ${total} data ke Firebase Realtime Database.`);
  } catch (err) {
    console.error('Gagal migrasi ke RTDB:', err);
    updateSyncStatus('offline', 'Migrasi Gagal');
    alert('Terjadi kesalahan saat migrasi: ' + err.message);
  }
}

async function clearAllTransactions() {
  if (!confirm('⚠️ APAKAH ANDA YAKIN?\n\nSemua riwayat transaksi di Realtime Database dan memori Lokal akan DIHAPUS BERSIH.\nData penjualan toko akan kembali dari 0.\nLangkah ini tidak dapat dibatalkan!')) {
    return;
  }

  updateSyncStatus('syncing', 'Menghapus semua transaksi...');

  try {
    // 1. Catat semua ID yang sedang ada agar tidak dibangkitkan lagi oleh listener snapshot
    transactions.forEach(t => {
      if (t && t.id) recentlyDeletedTxIds.add(t.id);
    });
    saveDeletedTxIdsLocally();

    // 2. Kosongkan state di memori dan localStorage
    transactions = [];
    localStorage.removeItem('kasir_transactions');
    localStorage.setItem('kasir_transactions', JSON.stringify([]));

    if (Array.isArray(weeklyTrendData)) weeklyTrendData = [];
    if (typeof analyticsTransactions !== 'undefined' && Array.isArray(analyticsTransactions)) {
      analyticsTransactions = [];
    }

    // 3. RTDB: hapus seluruh node 'transactions' untuk toko ini jika online
    if (firebaseDb) {
      await firebaseDb.ref(getStorePath('transactions')).remove();
      console.log('✅ Semua node transaksi toko berhasil dihapus bersih dari RTDB');
      updateSyncStatus('online', 'Database Terhubung');
    } else {
      updateSyncStatus('offline', 'Mode Offline (Database Lokal)');
    }

    if (typeof selectedTransactionIds !== 'undefined') selectedTransactionIds.clear();
    if (typeof updateBulkTxButtonState === 'function') updateBulkTxButtonState();
    if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
    if (typeof initAnalyticsFilter === 'function') initAnalyticsFilter();
    if (typeof updateAnalytics === 'function') updateAnalytics();

    alert('🗑️ Berhasil mengosongkan semua transaksi! Data riwayat penjualan toko sekarang bersih mulai dari 0.');
  } catch (err) {
    console.error('❌ Gagal hapus transaksi:', err.message);
    updateSyncStatus('offline', 'Gagal Hapus: ' + err.message);
    alert('❌ Terjadi kesalahan saat menghapus transaksi:\n\n' + err.message);
  }
}

// Alias untuk tombol lama di index.html
function clearFirestoreTransactions() {
  return clearAllTransactions();
}


// Fungsi Backup & Restore Database Lokal (JSON)
function exportFullDatabaseJSON(silent = false) {
  const backupData = {
    app: "Toko Sahil POS",
    version: "3.3",
    exportedAt: new Date().toISOString(),
    storeName: receiptSettings.name || 'Toko',
    data: {
      products: products || [],
      transactions: transactions || [],
      customers: customers || [],
      shifts: shifts || [],
      cashiers: cashiers || [],
      heldCarts: heldCarts || [],
      loyaltySettings: loyaltySettings || {},
      receiptSettings: receiptSettings || {},
      appConfig: appConfig || {},
      // Modul lengkap agar tidak ada data yang tertinggal
      salesList: (typeof salesList !== 'undefined' ? salesList : safeJsonParse('kasir_sales_list', [])),
      salesDeliveries: (typeof salesDeliveries !== 'undefined' ? salesDeliveries : safeJsonParse('kasir_sales_deliveries', [])),
      salesReturns: (typeof salesReturns !== 'undefined' ? salesReturns : safeJsonParse('kasir_sales_returns', [])),
      expenses: (typeof expenses !== 'undefined' ? expenses : safeJsonParse('kasir_expenses', [])),
      stockOpnames: (typeof stockOpnames !== 'undefined' ? stockOpnames : safeJsonParse('kasir_stock_opnames', [])),
      bundles: (typeof bundles !== 'undefined' ? bundles : safeJsonParse('kasir_bundles', [])),
      customCategories: (typeof customCategories !== 'undefined' ? customCategories : safeJsonParse('kasir_custom_categories', [])),
      customRacks: (typeof customRacks !== 'undefined' ? customRacks : safeJsonParse('kasir_custom_racks', [])),
      staffAccounts: (typeof staffAccounts !== 'undefined' ? staffAccounts : safeJsonParse('kasir_staff_accounts', [])),
      ownerPin: localStorage.getItem('kasir_owner_pin') || ''
    }
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  
  // Format nama file sesuai permintaan: database-(nama toko)-DD-MM-YYYY.json
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateFormatted = `${dd}-${mm}-${yyyy}`;
  const storeNameRaw = receiptSettings.name || 'Toko';
  const cleanStoreName = storeNameRaw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `database-${cleanStoreName}-${dateFormatted}.json`;

  const dateStr = now.toISOString().slice(0, 10);

  // 1. Coba simpan langsung ke folder fisik komputer jika di Desktop (.exe)
  let directSaved = false;
  if (typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.saveBackupFile) {
    window.desktopAPI.saveBackupFile(fileName, jsonStr).then(res => {
      if (res && res.success) {
        console.log(`[Backup Desktop] Sukses tersimpan ke: ${res.path}`);
      }
    });
    directSaved = true;
  } else if (window.backupDirHandle) {
    try {
      window.backupDirHandle.getFileHandle(fileName, { create: true })
        .then(async (fileHandle) => {
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          console.log(`[Backup] Berhasil menyimpan langsung ke folder "backup database/${fileName}"`);
        })
        .catch(err => {
          console.warn('[Backup] Gagal menulis via directory handle:', err);
        });
      directSaved = true;
    } catch(e) {}
  }

  // 2. Download browser standar HANYA jika bukan panggilan sinkronisasi real-time hening
  if (!silent) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Simpan juga salinan terakhir ke localStorage cadangan otomatis (fail-safe)
  try {
    localStorage.setItem('kasir_last_auto_backup_date', dateStr);
    localStorage.setItem('kasir_last_backup_meta', JSON.stringify({
      fileName: fileName,
      date: dateFormatted,
      time: now.toLocaleTimeString('id-ID'),
      productsCount: (products || []).length,
      txsCount: (transactions || []).length
    }));
  } catch(e) {}

  if (!silent) {
    if (typeof showToastNotification === 'function') {
      showToastNotification(`📁 Cadangan database "${fileName}" berhasil diunduh!`);
    } else {
      console.log(`[Backup] File ${fileName} berhasil diunduh tanpa popup notifikasi.`);
    }
  }
}

// Debounce timer untuk Real-Time Auto-Backup agar tidak membebani performa kasir
let realTimeBackupDebounceTimer = null;

function triggerRealTimeBackupDebounced() {
  // Hanya jalankan di background, jeda 2.5 detik setelah transaksi selesai dengan tenang
  if (realTimeBackupDebounceTimer) {
    clearTimeout(realTimeBackupDebounceTimer);
  }
  realTimeBackupDebounceTimer = setTimeout(() => {
    try {
      if (window.backupDirHandle) {
        // Tulis langsung ke file fisik di folder "backup database" tanpa popup/download bar
        exportFullDatabaseJSON(true);
      }
    } catch(err) {
      console.warn('[Real-Time Backup] Gagal sync ke folder:', err);
    }
  }, 2500);
}

// --- Penyimpanan Permanen Directory Handle via IndexedDB ---
function openBackupIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kasirkilat_backup_db', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveStoredBackupDirHandle(handle) {
  try {
    const db = await openBackupIDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'backup_dir');
    return new Promise(resolve => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) {
    return false;
  }
}

async function getStoredBackupDirHandle() {
  try {
    const db = await openBackupIDB();
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('backup_dir');
    return new Promise(resolve => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

// Update indikator UI dan banner peringatan status folder backup
function updateBackupFolderIndicators(state, folderName = '') {
  const banner = document.getElementById('backup-folder-warning-banner');
  const statusEl = document.getElementById('backup-folder-status');
  const isFeatureEnabled = localStorage.getItem('kasir_enable_folder_backup') === 'true';

  if (!isFeatureEnabled) {
    if (banner) banner.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
    return;
  }

  if (state === 'connected') {
    if (banner) banner.style.display = 'none';
    if (statusEl) {
      statusEl.className = 'sync-status online';
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(34, 197, 94, 0.12)';
      statusEl.style.borderColor = 'rgba(34, 197, 94, 0.3)';
      statusEl.style.color = '#15803d';
      statusEl.innerHTML = `🟢 <b>Otomatis Terhubung:</b> Folder <b>${folderName}</b> aktif. Backup tersimpan otomatis ke folder ini di latar belakang tanpa notifikasi yang mengganggu.`;
    }
  } else if (state === 'reconnect_needed') {
    // Periksa apakah pengguna menutup banner di sesi ini
    const dismissed = sessionStorage.getItem('dismiss_backup_warning') === 'true';
    if (banner && !dismissed) banner.style.display = 'flex';
    
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(245, 158, 11, 0.12)';
      statusEl.style.borderColor = 'rgba(245, 158, 11, 0.35)';
      statusEl.style.color = '#b45309';
      statusEl.innerHTML = `🟡 Folder <b>${folderName}</b> sebelumnya pernah dipilih. Klik tombol <b>"Hubungkan Folder"</b> di bawah untuk mengaktifkan izin tulis otomatis sesi ini.`;
    }
  } else {
    // Not connected
    const dismissed = sessionStorage.getItem('dismiss_backup_warning') === 'true';
    if (banner && !dismissed) banner.style.display = 'flex';

    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(239, 68, 68, 0.08)';
      statusEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      statusEl.style.color = '#dc2626';
      statusEl.innerHTML = `⚠️ <b>PENTING:</b> Folder <b>backup database</b> belum dihubungkan ke aplikasi. Klik tombol <b>"Hubungkan Folder 'backup database'"</b> di atas agar file database tersimpan otomatis di komputer Anda.`;
    }
  }
}

function toggleFolderBackupFeature(enabled) {
  localStorage.setItem('kasir_enable_folder_backup', enabled ? 'true' : 'false');
  const controls = document.getElementById('folder-backup-controls');
  if (controls) {
    controls.style.display = enabled ? 'block' : 'none';
  }
  const banner = document.getElementById('backup-folder-warning-banner');
  if (!enabled && banner) {
    banner.style.display = 'none';
  } else if (enabled) {
    initAutoBackupDirHandle();
  }
}

function dismissBackupWarningBanner() {
  const banner = document.getElementById('backup-folder-warning-banner');
  if (banner) banner.style.display = 'none';
  sessionStorage.setItem('dismiss_backup_warning', 'true');
}

// Inisialisasi otomatis folder backup saat aplikasi dibuka
async function initAutoBackupDirHandle() {
  try {
    const isFeatureEnabled = localStorage.getItem('kasir_enable_folder_backup') === 'true';
    const chk = document.getElementById('chk-enable-folder-backup');
    const controls = document.getElementById('folder-backup-controls');
    if (chk) chk.checked = isFeatureEnabled;
    if (controls) controls.style.display = isFeatureEnabled ? 'block' : 'none';

    if (!isFeatureEnabled) {
      updateBackupFolderIndicators('not_connected');
      return;
    }
    if (typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.isDesktop) {
      const desktopFolder = localStorage.getItem('kasir_desktop_backup_folder_name');
      if (desktopFolder) {
        updateBackupFolderIndicators('connected', desktopFolder);
        console.log(`[Backup Desktop] Folder "${desktopFolder}" aktif dari sesi sebelumnya.`);
        return;
      }
    }

    const storedHandle = await getStoredBackupDirHandle();
    if (storedHandle) {
      // Cek apakah permission masih ada
      const perm = await storedHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        window.backupDirHandle = storedHandle;
        updateBackupFolderIndicators('connected', storedHandle.name);
        console.log(`[Backup] Folder "${storedHandle.name}" terhubung otomatis dari sesi sebelumnya.`);
      } else {
        updateBackupFolderIndicators('reconnect_needed', storedHandle.name);
      }
    } else {
      updateBackupFolderIndicators('not_connected');
    }
  } catch (err) {
    console.warn('[Backup] Gagal inisialisasi handle tersimpan:', err);
    updateBackupFolderIndicators('not_connected');
  }
}

// Fitur: Pilih Folder "backup database" via Native Windows Explorer (Desktop) atau File System Access API (Browser)
async function selectBackupDatabaseFolder() {
  if (typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.selectBackupFolder) {
    try {
      const res = await window.desktopAPI.selectBackupFolder();
      if (res && res.success && res.folderPath) {
        localStorage.setItem('kasir_desktop_backup_folder', res.folderPath);
        localStorage.setItem('kasir_desktop_backup_folder_name', res.folderName);
        updateBackupFolderIndicators('connected', res.folderName);
        exportFullDatabaseJSON(true);
        if (typeof showToastNotification === 'function') {
          showToastNotification(`📁 Folder "${res.folderName}" berhasil terhubung permanen!`);
        }
      }
    } catch(err) {
      console.warn('Gagal memilih folder desktop:', err);
    }
    return;
  }

  if ('showDirectoryPicker' in window) {
    try {
      // Jika sebelumnya ada handle tersimpan, coba minta izin dulu
      let dirHandle = null;
      const storedHandle = await getStoredBackupDirHandle();
      if (storedHandle) {
        try {
          const perm = await storedHandle.requestPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            dirHandle = storedHandle;
          }
        } catch(e) {}
      }

      if (!dirHandle) {
        dirHandle = await window.showDirectoryPicker();
      }

      window.backupDirHandle = dirHandle;
      await saveStoredBackupDirHandle(dirHandle);

      // Sinkronkan langsung ke folder tanpa notifikasi/download popup
      exportFullDatabaseJSON(true);

      updateBackupFolderIndicators('connected', dirHandle.name);

      if (typeof showToastNotification === 'function') {
        showToastNotification(`📁 Folder "${dirHandle.name}" berhasil terhubung permanen!`);
      }
    } catch(e) {
      if (e.name !== 'AbortError') {
        console.warn('Gagal memilih folder:', e.message);
      }
    }
  } else {
    alert('Browser ini tidak mendukung File System Access API. Pastikan menggunakan Google Chrome, Edge, atau browser berbasis Chromium terbaru di PC/Laptop.');
  }
}

// Pemeriksaan & Pencadangan Otomatis Harian ke File Lokal Komputer (100% Hening tanpa Notifikasi/Alert)
function checkAndTriggerDailyAutoBackup() {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const lastBackup = localStorage.getItem('kasir_last_auto_backup_date');
    const autoBackupEnabled = appConfig.enableDailyAutoBackup !== false; // Default aktif (true)

    if (autoBackupEnabled && lastBackup !== todayStr) {
      const hasData = (products && products.length > 0) || (transactions && transactions.length > 0);
      if (hasData) {
        setTimeout(() => {
          // Unduh / tulis otomatis secara hening (silent = true) tanpa notif popup
          exportFullDatabaseJSON(true);
        }, 2000);
      }
    }
  } catch (err) {
    console.warn('Gagal memproses auto-backup:', err);
  }
}

// Pengaturan aktif/nonaktif auto backup harian
function toggleAutoDailyBackup(isChecked) {
  appConfig.enableDailyAutoBackup = isChecked;
  localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
}

function importFullDatabaseJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const parsedJSON = JSON.parse(e.target.result);
      if (!parsedJSON) {
        throw new Error("File cadangan kosong atau tidak valid.");
      }

      // Dukung format { data: { products, transactions } } maupun format root langsung { products, transactions }
      const d = parsedJSON.data ? parsedJSON.data : parsedJSON;
      const rawTxs = Array.isArray(d.transactions) ? d.transactions : (Array.isArray(d.riwayatTransaksi) ? d.riwayatTransaksi : []);
      const rawProds = Array.isArray(d.products) ? d.products : (Array.isArray(d.produk) ? d.produk : []);

      const countProds = rawProds.length;
      const countTxs = rawTxs.length;

      if (!confirm(`Apakah Anda yakin ingin memulihkan database dari file ini?\n\n• ${countProds} Produk\n• ${countTxs} Riwayat Transaksi\n\n⚠️ Tindakan ini akan menggantikan data yang ada saat ini.`)) {
        event.target.value = '';
        return;
      }

      // Bersihkan daftar ID yang pernah dihapus agar transaksi yang dipulihkan tidak terfilter/terhapus otomatis
      recentlyDeletedTxIds.clear();
      saveDeletedTxIdsLocally();

      if (Array.isArray(rawProds) && rawProds.length > 0) {
        products = rawProds;
        saveProductsLocally();
      }
      if (Array.isArray(rawTxs)) {
        transactions = rawTxs;
        saveTransactionsLocally();
      }
      if (Array.isArray(d.customers)) {
        customers = d.customers;
        saveCustomersLocally();
      }
      if (Array.isArray(d.shifts)) {
        shifts = d.shifts;
        localStorage.setItem('kasir_shifts', JSON.stringify(shifts));
      }
      if (Array.isArray(d.cashiers)) {
        cashiers = d.cashiers;
        localStorage.setItem('kasir_cashiers', JSON.stringify(cashiers));
      }
      if (Array.isArray(d.salesList)) {
        salesList = d.salesList;
        localStorage.setItem('kasir_sales_list', JSON.stringify(salesList));
      }
      if (Array.isArray(d.salesDeliveries)) {
        salesDeliveries = d.salesDeliveries;
        localStorage.setItem('kasir_sales_deliveries', JSON.stringify(salesDeliveries));
      }
      if (Array.isArray(d.salesReturns)) {
        salesReturns = d.salesReturns;
        localStorage.setItem('kasir_sales_returns', JSON.stringify(salesReturns));
      }
      if (Array.isArray(d.expenses)) {
        expenses = d.expenses;
        localStorage.setItem('kasir_expenses', JSON.stringify(expenses));
      }
      if (Array.isArray(d.stockOpnames)) {
        stockOpnames = d.stockOpnames;
        localStorage.setItem('kasir_stock_opnames', JSON.stringify(stockOpnames));
      }
      if (Array.isArray(d.bundles)) {
        bundles = d.bundles;
        localStorage.setItem('kasir_bundles', JSON.stringify(bundles));
      }
      if (Array.isArray(d.customCategories)) {
        customCategories = d.customCategories;
        localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
      }
      if (Array.isArray(d.customRacks)) {
        customRacks = d.customRacks;
        localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
      }
      if (Array.isArray(d.staffAccounts)) {
        staffAccounts = d.staffAccounts;
        localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));
      }
      if (d.ownerPin) {
        localStorage.setItem('kasir_owner_pin', d.ownerPin);
      }
      if (d.receiptSettings) {
        receiptSettings = d.receiptSettings;
        localStorage.setItem('kasir_receipt_settings', JSON.stringify(receiptSettings));
      }
      if (d.appConfig) {
        appConfig = { ...appConfig, ...d.appConfig };
        localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
      }

      // Jika cloud aktif, tawarkan sinkronkan ke cloud
      if (appConfig.enableCloudSync && firebaseDb) {
        const syncCloud = confirm('Apakah Anda ingin langsung menyinkronkan seluruh data yang baru dipulihkan ke Cloud Realtime Database?');
        if (syncCloud) {
          const updates = {};
          if (Array.isArray(products)) products.forEach(p => { if (p && p.id) updates[getStorePath('products/' + p.id)] = p; });
          if (Array.isArray(transactions)) transactions.forEach(t => { if (t && t.id) updates[getStorePath('transactions/' + t.id)] = t; });
          if (Array.isArray(customers)) customers.forEach(c => { if (c && (c.id || c.no_hp)) updates[getStorePath('customers/' + (c.id || c.no_hp))] = c; });
          if (Array.isArray(bundles)) bundles.forEach(b => { if (b && b.id) updates[getStorePath('bundles/' + b.id)] = b; });
          if (Array.isArray(expenses)) updates[getStorePath('expenses')] = expenses;
          if (Array.isArray(shifts)) {
            shifts.forEach(s => {
              const sId = s.id_shift || ('SH-' + Date.now());
              updates[getStorePath('shifts/' + sId)] = s;
            });
          }
          await firebaseDb.ref('/').update(updates);
        }
      }

      alert(`✅ Berhasil memulihkan ${countTxs} transaksi & ${countProds} produk!\n\nSeluruh riwayat transaksi telah dikembalikan ke sistem.`);
      location.reload();
    } catch (err) {
      console.error('Gagal memulihkan database:', err);
      alert('❌ Gagal membaca file cadangan: ' + err.message);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

async function toggleCloudSyncMode() {
  const chk = document.getElementById('chk-enable-cloud');
  const panel = document.getElementById('firebase-settings-panel');
  const isEnabled = chk ? chk.checked : false;

  appConfig.enableCloudSync = isEnabled;
  localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));

  if (panel) {
    panel.style.display = isEnabled ? 'block' : 'none';
  }

  if (isEnabled) {
    updateSyncStatus('syncing', 'Menghubungkan ke Cloud...');
    const connected = await initFirebase();
    
    // JIKA BERHASIL TERHUBUNG: Set status online tanpa upload transaksi diam-diam
    if (connected && firebaseDb) {
      updateSyncStatus('online', 'Database Terhubung');
    }
  } else {
    // Matikan listener cloud jika dinonaktifkan
    if (fbUnsubscribes && fbUnsubscribes.length > 0) {
      fbUnsubscribes.forEach(unsub => unsub());
      fbUnsubscribes = [];
    }
    firebaseDb = null;
    updateSyncStatus('offline', 'Mode Offline (Database Lokal)');
  }
}

// Pengaturan Sistem Aplikasi
let appConfig = safeJsonParse('kasir_app_config', {
  strictShift: false,
  allowZeroStock: true,
  customerMode: false,
  enablePromo: false,
  showDiscountPos: false,
  showPromoBanner: true,
  posGridMode: false,
  autoCashNonCash: false,
  enableCloudSync: false,
  enableDailyAutoBackup: true
});
if (appConfig.enableCloudSync === undefined) appConfig.enableCloudSync = false;
if (appConfig.enablePromo === undefined) appConfig.enablePromo = false;
if (appConfig.showDiscountPos === undefined) appConfig.showDiscountPos = false;
if (appConfig.showPromoBanner === undefined) appConfig.showPromoBanner = true;
if (appConfig.posGridMode === undefined) appConfig.posGridMode = false;
if (appConfig.autoCashNonCash === undefined) appConfig.autoCashNonCash = false;
if (appConfig.enableDailyAutoBackup === undefined) appConfig.enableDailyAutoBackup = true;

// Pengaturan Nota / Struk Toko (Default)
let receiptSettings = safeJsonParse('kasir_receipt_settings', {
  logo: '',
  name: 'TOKO SAHIL',
  phone: '0896-3649-2890',
  address: 'Desa Sumurber Rt 21 Rw 07 Panceng Gresik',
  fontSizeHeader: 14,
  fontSizeItems: 12,
  fontSizeFooter: 12
});
// Kompatibilitas mundur
if (receiptSettings.showLogo === undefined) receiptSettings.showLogo = true;
if (receiptSettings.showName === undefined) receiptSettings.showName = true;
if (receiptSettings.showAddress === undefined) receiptSettings.showAddress = true;
if (receiptSettings.showPhone === undefined) receiptSettings.showPhone = true;
if (receiptSettings.showCashier === undefined) receiptSettings.showCashier = true;
if (receiptSettings.showSubtotal === undefined) receiptSettings.showSubtotal = true;
if (receiptSettings.showDiscount === undefined) receiptSettings.showDiscount = true;
if (receiptSettings.showMethod === undefined) receiptSettings.showMethod = true;
if (receiptSettings.fontSizeHeader === undefined) receiptSettings.fontSizeHeader = receiptSettings.fontSize || 14;
if (receiptSettings.fontSizeItems === undefined) receiptSettings.fontSizeItems = receiptSettings.fontSize || 12;
if (receiptSettings.fontSizeFooter === undefined) receiptSettings.fontSizeFooter = receiptSettings.fontSize || 12;
if (receiptSettings.printFormat === undefined) receiptSettings.printFormat = 'text';
if (receiptSettings.textFontSize === undefined) receiptSettings.textFontSize = 12;
if (receiptSettings.textTitleFontSize === undefined) receiptSettings.textTitleFontSize = 16;
if (receiptSettings.textPaddingLeft === undefined) receiptSettings.textPaddingLeft = 1;
if (receiptSettings.textWidth === undefined) receiptSettings.textWidth = 25;
if (receiptSettings.headerPaddingLR === undefined) receiptSettings.headerPaddingLR = 0;
if (receiptSettings.logoMarginLR === undefined) receiptSettings.logoMarginLR = 0;
if (receiptSettings.nameMarginLR === undefined) receiptSettings.nameMarginLR = 0;
if (receiptSettings.addressMarginLR === undefined) receiptSettings.addressMarginLR = 0;
if (receiptSettings.phoneMarginLR === undefined) receiptSettings.phoneMarginLR = 0;

let labelSettings = safeJsonParse('kasir_label_settings', {
  width: 65,
  height: 30,
  marginLeft: 0,
  chars: 25,
  showBarcode: false,
  showPrice: true,
  priceFontSize: 30,
  priceFontWeight: 1300,
  nameFontSize: 12,
  nameFontWeight: 900
});

let productLabelSettings = safeJsonParse('kasir_product_label_settings', {
  width: 50,
  height: 30,
  marginLeft: 0,
  chars: 25,
  showBarcode: true,
  showPrice: true,
  showStoreName: true
});


// Contoh Data Awal (Produk)
const defaultProducts = [
  { 
    id: "P001", 
    nama: "Kopi Hitam", 
    kategori: "Minuman", 
    harga_beli: 3000, 
    harga_jual: 5000, 
    stok: 50, 
    barcode: "8996001300124", 
    rak: "Rak A1",
    gambar: "https://m.media-amazon.com/images/I/71Bs3RzmTyL._SL1500_.jpg",
    tanggal_kadaluarsa: "2027-12-31"
  },
  { 
    id: "P002", 
    nama: "Teh Manis", 
    kategori: "Minuman", 
    harga_beli: 2000, 
    harga_jual: 4000, 
    stok: 1, 
    barcode: "8996001300247", 
    rak: "Rak A2",
    gambar: "https://images.unsplash.com/photo-1576092768241-dec231879fc3?q=80&w=300",
    tanggal_kadaluarsa: ""
  },
  { 
    id: "P003", 
    nama: "Roti Bakar Cokelat", 
    kategori: "Makanan", 
    harga_beli: 8000, 
    harga_jual: 12000, 
    stok: 30, 
    barcode: "", 
    rak: "Etalase Depan",
    gambar: "https://images.unsplash.com/photo-1584776296944-ab6fb57b0bdd?q=80&w=300",
    tanggal_kadaluarsa: "2026-07-05" // Contoh produk mendekati kadaluarsa
  }
];

// Data Awal Transaksi (Kosong secara default agar riwayat transaksi bersih)
const seedTransactions = () => [];

// --- Inisialisasi Aplikasi ---
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  loadAppConfig();
  loadReceiptSettings();
  loadLabelSettings();
  loadProductLabelSettings();
  loadData();
  initCashiers();

  // Hubungkan Firebase HANYA JIKA mode Cloud Sync diaktifkan oleh pengguna
  if (appConfig.enableCloudSync) {
    updateSyncStatus('syncing', 'Menghubungkan ke Database...');
    initFirebase().then(connected => {
      if (!connected) {
        initAnalyticsFilter();
        updateAnalytics();
        // Jangan timpa status sync jika sudah diatur oleh initFirebase (misal: expired)
        // Hanya update jika belum ada pesan spesifik
        const syncTextEl = document.getElementById('sync-text');
        const currentSyncText = syncTextEl ? syncTextEl.textContent : '';
        if (!currentSyncText.includes('Expired') && !currentSyncText.includes('Tidak Terdaftar')) {
          if (navigator.onLine) {
            updateSyncStatus('offline', 'Firebase belum dikonfigurasi');
          } else {
            updateSyncStatus('offline', 'Tidak ada koneksi internet');
          }
        }
      }
    });
  } else {
    // Mode Offline Murni (Database Lokal)
    updateSyncStatus('offline', 'Mode Offline (Database Lokal)');
    initAnalyticsFilter();
    updateAnalytics();
  }
  
  // Biarkan filter tanggal riwayat transaksi default kosong agar seluruh riwayat transaksi (termasuk yang baru dipulihkan) langsung tampil
  const startDateInput = document.getElementById('tx-filter-start-date');
  const endDateInput = document.getElementById('tx-filter-end-date');
  if (startDateInput) startDateInput.value = '';
  if (endDateInput) endDateInput.value = '';
  
  // Saat kembali online, hanya init Firebase jika fitur cloud diaktifkan
  window.addEventListener('online', () => {
    if (appConfig.enableCloudSync && !firebaseDb) initFirebase();
  });
  
  // Event listeners
  window.addEventListener('keydown', handleGlobalKeydowns);
  
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('keydown', handleSearchInputKeydowns);
  
  const kulakSearchInput = document.getElementById('kulak-search-input');
  kulakSearchInput.addEventListener('keydown', handleKulakSearchInputKeydowns);
  
  const editTxSearchInput = document.getElementById('edit-tx-search-input');
  if (editTxSearchInput) {
    editTxSearchInput.addEventListener('keydown', handleEditTxSearchInputKeydowns);
  }
  
  const productListSearchInput = document.getElementById('product-list-search');
  if (productListSearchInput) {
    productListSearchInput.addEventListener('keydown', handleProductListSearchKeydowns);
  }
  
  const prodBarcode = document.getElementById('prod-barcode');
  if (prodBarcode) {
    prodBarcode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const expiryInput = document.getElementById('prod-expiry');
        if (expiryInput) expiryInput.focus();
      }
    });
  }
  
  // Tutup dropdown melayang saat klik di luar
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-bar')) {
      closeFloatingResults();
      closeKulakFloatingResults();
      closeEditTxFloatingResults();
    }
    
    // Auto Refocus ke input pencarian sesuai tab aktif saat mengeklik area non-interaktif
    const activeModal = document.querySelector('.modal.active, .modal-overlay.active');
    const kulakFormCard = document.getElementById('kulak-form-card');
    const kulakFormOpen = kulakFormCard && kulakFormCard.style.display !== 'none';
    const bulkEditCard = document.getElementById('kulak-bulk-edit-card');
    const bulkEditOpen = bulkEditCard && bulkEditCard.style.display !== 'none';
    if (!activeModal && !kulakFormOpen && !bulkEditOpen) {
      const isInteractive = e.target.closest('input, textarea, select, button, label, a, .modal, .modal-content, [onclick], .product-select-checkbox');
      if (!isInteractive) {
        if (activeTab === 'products') {
          focusProductListSearch();
        } else if (activeTab === 'pos') {
          focusSearchInput();
        } else if (activeTab === 'kulak') {
          focusKulakSearch();
        }
      }
    }
  });
  
  // Deteksi event cetak untuk toggle body class
  window.addEventListener('beforeprint', () => {
    const receiptModal = document.getElementById('receipt-modal');
    if (receiptModal && receiptModal.classList.contains('active')) {
      document.body.classList.add('printing-receipt');
    }
  });

  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-receipt');
    document.body.classList.remove('printing-daily-report');
    document.body.classList.remove('printing-rack-report');
  });
  
  // Render ikon Lucide (Offline & Online)
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
});

// Timer Jam
function initClock() {
  const timeDisplay = document.getElementById('time-display');
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour12: false });
    timeDisplay.textContent = timeStr;
  }, 1000);
}

// Muat data dari LocalStorage
function loadData() {
  const cachedProducts = localStorage.getItem('kasir_products');
  if (cachedProducts) {
    try {
      products = JSON.parse(cachedProducts) || [];
    } catch(e) {
      products = [...defaultProducts];
    }
  } else {
    products = [...defaultProducts];
    saveProductsLocally();
  }

  // Pastikan setiap produk memiliki tanggal pencatatan (createdAt)
  let prodNeedSave = false;
  const nowIso = new Date().toISOString();
  products.forEach(p => {
    if (!p.createdAt) {
      p.createdAt = nowIso;
      prodNeedSave = true;
    }
  });
  if (prodNeedSave) {
    saveProductsLocally();
  }
  
  // Muat transaksi: jika mode offline lokal, muat dari localStorage.
  // Jika cloud aktif, transactions diisi oleh listener Realtime Database.
  const cachedTransactions = localStorage.getItem('kasir_transactions');
  if (cachedTransactions) {
    try {
      const parsed = JSON.parse(cachedTransactions);
      transactions = Array.isArray(parsed) 
        ? parsed.filter(t => t && t.id && !recentlyDeletedTxIds.has(t.id))
        : [];
    } catch (e) {
      transactions = [];
    }
  } else {
    transactions = [];
  }

  // ─── Migrasi sekali: Bersihkan transaksi non-Bon yang salah punya sisa_piutang:0
  // (Versi lama selalu menyimpan sisa_piutang:0 di semua transaksi, 
  //  sehingga semua transaksi muncul di buku hutang "Sudah Lunas")
  let needsMigration = false;
  transactions.forEach(tx => {
    const isBon = tx.status_pembayaran === 'Bon' || tx.sisa_piutang > 0;
    const hasHistory = Array.isArray(tx.riwayat_pelunasan) && tx.riwayat_pelunasan.length > 0;
    // Jika bukan Bon, tidak punya history, tapi punya sisa_piutang:0 → hapus field itu
    if (!isBon && !hasHistory && tx.hasOwnProperty('sisa_piutang') && tx.sisa_piutang === 0) {
      delete tx.sisa_piutang;
      needsMigration = true;
    }
  });
  if (needsMigration) {
    localStorage.setItem('kasir_transactions', JSON.stringify(transactions));
    console.log('✅ Migrasi data hutang selesai: Hapus sisa_piutang:0 dari transaksi non-Bon');
  }

  
  const cachedShifts = localStorage.getItem('kasir_shifts');
  if (cachedShifts) shifts = JSON.parse(cachedShifts);
  
  const cachedActiveShift = localStorage.getItem('kasir_active_shift');
  if (cachedActiveShift) activeShift = JSON.parse(cachedActiveShift);
  
  const cachedCustomers = localStorage.getItem('kasir_customers');
  if (cachedCustomers) customers = JSON.parse(cachedCustomers);
  
  updateCategoriesList();
  updateRacksList();
  
  // Muat data Sales, Deliveries, dan Returns
  try {
    const cachedSales = localStorage.getItem('kasir_sales_list');
    if (cachedSales) salesList = JSON.parse(cachedSales);
    const cachedDeliveries = localStorage.getItem('kasir_sales_deliveries');
    if (cachedDeliveries) salesDeliveries = JSON.parse(cachedDeliveries);
    const cachedReturns = localStorage.getItem('kasir_sales_returns');
    if (cachedReturns) salesReturns = JSON.parse(cachedReturns);

    const cachedExpenses = localStorage.getItem('kasir_expenses');
    if (cachedExpenses) expenses = JSON.parse(cachedExpenses);
    const cachedOpnames = localStorage.getItem('kasir_stock_opnames');
    if (cachedOpnames) stockOpnames = JSON.parse(cachedOpnames);
    const cachedBundles = localStorage.getItem('kasir_bundles');
    if (cachedBundles) bundles = JSON.parse(cachedBundles);
  } catch (e) {}

  if (typeof renderExpensesTable === 'function') {
    renderExpensesTable();
  }
  if (typeof renderBundlesTable === 'function') {
    renderBundlesTable();
  }
  if (typeof updateExpiredBadgeCount === 'function') {
    updateExpiredBadgeCount();
  }

  if (typeof renderSalesTable === 'function') {
    renderSalesTable();
  }

  // Update Shift UI on load
  if (typeof updateShiftStatusUI === 'function') {
    updateShiftStatusUI();
  }
  
  if (typeof renderCustomersTable === 'function') {
    renderCustomersTable();
  }
  
  if (typeof checkPromoBanner === 'function') {
    checkPromoBanner();
  }
  
  // Set UI inputs for Loyalty
  const ptsInput = document.getElementById('setting-points-per-rp');
  const rpInput = document.getElementById('setting-rp-per-point');
  if (ptsInput) ptsInput.value = loyaltySettings.pointsPerRp;
  if (rpInput) rpInput.value = loyaltySettings.rpPerPoint;

  if (typeof syncLoyaltySettingsUI === 'function') {
    syncLoyaltySettingsUI();
  }

  // Hubungkan otomatis folder backup yang tersimpan via IndexedDB
  if (typeof initAutoBackupDirHandle === 'function') {
    initAutoBackupDirHandle();
  }

  // Cek dan jalankan auto backup harian ke file lokal
  if (typeof checkAndTriggerDailyAutoBackup === 'function') {
    checkAndTriggerDailyAutoBackup();
  }
}

// Batas maksimal transaksi yang disimpan di LocalStorage agar aplikasi tidak hang/freeze
const MAX_LOCAL_TRANSACTIONS = 300;

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn(`[LocalStorage Penuh] Kuota habis untuk key: ${key}, membersihkan cache analitik...`);
      try {
        Object.keys(localStorage).forEach(k => {
          if (k.startsWith('kasir_analytics_cache_') || k.startsWith('kasir_temp_')) {
            localStorage.removeItem(k);
          }
        });
        localStorage.setItem(key, value);
        return true;
      } catch (retryErr) {
        console.error('LocalStorage tetap penuh setelah pembersihan cache:', retryErr);
        return false;
      }
    }
    return false;
  }
}

function saveTransactionsLocally() {
  const dataToSave = transactions.length > MAX_LOCAL_TRANSACTIONS 
    ? transactions.slice(-MAX_LOCAL_TRANSACTIONS) 
    : transactions;
    
  safeLocalStorageSet('kasir_transactions', JSON.stringify(dataToSave));

  // Real-time background sync ke folder "backup database" (aman, cepat, dan non-blocking)
  if (typeof triggerRealTimeBackupDebounced === 'function') {
    triggerRealTimeBackupDebounced();
  }
}

// Simpan data produk secara lokal
function saveProductsLocally() {
  safeLocalStorageSet('kasir_products', JSON.stringify(products));
}

// Simpan master daftar kategori khusus (yang dibuat manual pengguna)
let customCategories = safeJsonParse('kasir_custom_categories', ['Umum', 'Makanan', 'Minuman', 'Snack', 'Sembako']);

// Update daftar kategori unik & perbarui pilihan dropdown kategori di modal produk
function updateCategoriesList() {
  const catsFromProducts = products.map(p => p.kategori || 'Umum').filter(Boolean);
  const combined = Array.from(new Set([...customCategories, ...catsFromProducts]));
  categories = ['All', ...combined];
  populateCategorySelect();
}

// Mengisi opsi dropdown kategori (#prod-category dan #product-list-category-filter)
function populateCategorySelect(selectedCategory = null) {
  const catSelect = document.getElementById('prod-category');
  const filterSelect = document.getElementById('product-list-category-filter');

  const currentVal = selectedCategory || (catSelect ? catSelect.value : 'Umum');
  const catsFromProducts = products.map(p => p.kategori || 'Umum').filter(Boolean);
  const allCats = Array.from(new Set([...customCategories, ...catsFromProducts]));

  if (catSelect) {
    catSelect.innerHTML = '';
    allCats.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (cat.toLowerCase() === currentVal.toLowerCase()) {
        opt.selected = true;
      }
      catSelect.appendChild(opt);
    });
  }

  // Perbarui dropdown filter kategori di tabel produk
  if (filterSelect) {
    const currentFilterVal = filterSelect.value || 'All';
    filterSelect.innerHTML = '<option value="All">Semua Kategori</option>';
    allCats.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (cat.toLowerCase() === currentFilterVal.toLowerCase()) {
        opt.selected = true;
      }
      filterSelect.appendChild(opt);
    });
  }
}

// Dialog input untuk menambahkan kategori baru lewat tombol '+'
function promptAddNewCategory() {
  const newCat = prompt('Masukkan Nama Kategori Baru:');
  if (!newCat) return;

  const cleanCat = newCat.trim();
  if (!cleanCat) return;

  // Cek apakah sudah ada (case-insensitive)
  const existing = customCategories.find(c => c.toLowerCase() === cleanCat.toLowerCase());
  if (!existing) {
    customCategories.push(cleanCat);
    localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
  }

  updateCategoriesList();
  populateCategorySelect(cleanCat);
  saveCustomCategoriesCloud();
  alert(`✅ Kategori "${cleanCat}" berhasil ditambahkan!`);
}

// Simpan customCategories ke cloud jika online
function saveCustomCategoriesCloud() {
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('categories')).set(customCategories).catch(() => {});
    } catch (e) {}
  }
}

// Dialog hapus kategori yang sedang dipilih di form
function promptDeleteCategory() {
  const catSelect = document.getElementById('prod-category');
  if (!catSelect) return;

  const targetCategory = catSelect.value;
  if (!targetCategory) {
    alert("Silakan pilih kategori yang ingin dihapus.");
    return;
  }

  if (targetCategory.toLowerCase() === 'umum') {
    alert('Kategori "Umum" adalah kategori bawaan sistem dan tidak dapat dihapus.');
    return;
  }

  // Hitung berapa banyak produk yang menggunakan kategori ini
  const usedProducts = products.filter(p => (p.kategori || 'Umum').toLowerCase() === targetCategory.toLowerCase());
  const confirmMsg = usedProducts.length > 0
    ? `Kategori "${targetCategory}" digunakan oleh ${usedProducts.length} produk.\n\nJika dihapus, produk-produk tersebut akan dialihkan ke kategori "Umum".\n\nApakah Anda yakin ingin menghapus kategori ini?`
    : `Apakah Anda yakin ingin menghapus kategori "${targetCategory}"?`;

  if (!confirm(confirmMsg)) return;

  // 1. Hapus dari customCategories
  customCategories = customCategories.filter(c => c.toLowerCase() !== targetCategory.toLowerCase());
  localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
  saveCustomCategoriesCloud();

  // 2. Alihkan produk yang memakai kategori ini ke 'Umum'
  let hasUpdatedProducts = false;
  products.forEach(p => {
    if ((p.kategori || 'Umum').toLowerCase() === targetCategory.toLowerCase()) {
      p.kategori = 'Umum';
      hasUpdatedProducts = true;
      if (firebaseDb && typeof saveProductCloud === 'function') {
        saveProductCloud(p);
      }
    }
  });

  if (hasUpdatedProducts) {
    saveProductsLocally();
    if (typeof renderProductsTable === 'function') renderProductsTable();
    if (typeof renderPosProducts === 'function') renderPosProducts();
  }

  updateCategoriesList();
  populateCategorySelect('Umum');
  alert(`✅ Kategori "${targetCategory}" berhasil dihapus.`);
}

// ==========================================================================
// PENGELOLAAN LOKASI RAK PRODUK (OFFLINE + CLOUD SYNC)
// ==========================================================================
let customRacks = safeJsonParse('kasir_custom_racks', []);

// Simpan customRacks ke cloud jika online
function saveCustomRacksCloud() {
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('racks')).set(customRacks).catch(() => {});
    } catch (e) {}
  }
}

// Update daftar rak unik & perbarui pilihan dropdown rak di modal produk, dropdown filter, serta dropdown cetak
function updateRacksList() {
  populateRackSelect();

  const racksFromProducts = products.map(p => (p.rak || '').trim()).filter(Boolean);
  const combined = Array.from(new Set([...customRacks, ...racksFromProducts])).filter(Boolean);
  combined.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  // 1. Perbarui <select id="product-list-rack-filter"> di atas tabel produk
  const filterSelect = document.getElementById('product-list-rack-filter');
  if (filterSelect) {
    const currentVal = filterSelect.value || 'All';
    filterSelect.innerHTML = '<option value="All">Semua Rak</option><option value="__NONE__">Tanpa Rak (Belum Ditentukan)</option>';
    combined.forEach(rack => {
      const opt = document.createElement('option');
      opt.value = rack;
      opt.textContent = `Rak: ${rack}`;
      if (rack.toLowerCase() === currentVal.toLowerCase()) {
        opt.selected = true;
      }
      filterSelect.appendChild(opt);
    });
    for (let i = 0; i < filterSelect.options.length; i++) {
      if (filterSelect.options[i].value.toLowerCase() === currentVal.toLowerCase()) {
        filterSelect.selectedIndex = i;
        break;
      }
    }
  }

  // 2. Perbarui <select id="select-print-rack-target"> di modal cetak isi rak
  const printSelect = document.getElementById('select-print-rack-target');
  if (printSelect) {
    const currentVal = printSelect.value || 'All';
    printSelect.innerHTML = '<option value="All">-- Semua Rak --</option>';
    combined.forEach(rack => {
      const opt = document.createElement('option');
      opt.value = rack;
      opt.textContent = rack;
      printSelect.appendChild(opt);
    });
    for (let i = 0; i < printSelect.options.length; i++) {
      if (printSelect.options[i].value.toLowerCase() === currentVal.toLowerCase()) {
        printSelect.selectedIndex = i;
        break;
      }
    }
  }
}

// Mengisi opsi dropdown lokasi rak (#prod-rack) di modal tambah/edit produk
function populateRackSelect(selectedRack = null) {
  const rackSelect = document.getElementById('prod-rack');
  if (!rackSelect) return;

  const currentVal = selectedRack !== null ? selectedRack : rackSelect.value;
  const racksFromProducts = products.map(p => (p.rak || '').trim()).filter(Boolean);
  const combined = Array.from(new Set([...customRacks, ...racksFromProducts])).filter(Boolean);
  combined.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  rackSelect.innerHTML = '<option value="">-- Tanpa Rak --</option>';
  combined.forEach(rack => {
    const opt = document.createElement('option');
    opt.value = rack;
    opt.textContent = rack;
    if (currentVal && rack.toLowerCase() === String(currentVal).toLowerCase().trim()) {
      opt.selected = true;
    }
    rackSelect.appendChild(opt);
  });

  if (currentVal && !combined.some(r => r.toLowerCase() === String(currentVal).toLowerCase().trim())) {
    const opt = document.createElement('option');
    opt.value = currentVal;
    opt.textContent = currentVal;
    opt.selected = true;
    rackSelect.appendChild(opt);
  }
}

// Dialog input untuk menambah lokasi rak baru lewat tombol '+'
function promptAddNewRack() {
  const newRack = prompt('Masukkan Nama/Kode Rak Baru (misal: "Rak Minuman", "Rak A3", "Gudang Belakang"):');
  if (!newRack) return;

  const cleanRack = newRack.trim();
  if (!cleanRack) return;

  const existing = customRacks.find(r => r.toLowerCase() === cleanRack.toLowerCase());
  if (!existing) {
    customRacks.push(cleanRack);
    localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
    saveCustomRacksCloud();
  }

  updateRacksList();
  populateRackSelect(cleanRack);
  alert(`✅ Rak "${cleanRack}" berhasil ditambahkan & disimpan!`);
}

// Dialog hapus lokasi rak yang sedang dipilih di form
function promptDeleteRack() {
  const rackSelect = document.getElementById('prod-rack');
  if (!rackSelect) return;

  const targetRack = (rackSelect.value || '').trim();
  if (!targetRack) {
    alert("Silakan pilih rak yang ingin dihapus terlebih dahulu.");
    return;
  }

  // Hitung produk yang sedang tersimpan di rak ini
  const usedProducts = products.filter(p => (p.rak || '').toLowerCase().trim() === targetRack.toLowerCase());
  const confirmMsg = usedProducts.length > 0
    ? `Rak "${targetRack}" digunakan oleh ${usedProducts.length} produk.\n\nJika dihapus, produk-produk tersebut akan dialihkan menjadi tanpa rak.\n\nApakah Anda yakin ingin menghapus rak ini?`
    : `Apakah Anda yakin ingin menghapus rak "${targetRack}"?`;

  if (!confirm(confirmMsg)) return;

  // 1. Hapus dari customRacks
  customRacks = customRacks.filter(r => r.toLowerCase().trim() !== targetRack.toLowerCase());
  localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
  saveCustomRacksCloud();

  // 2. Kosongkan rak pada produk yang memakai rak ini
  let hasUpdatedProducts = false;
  products.forEach(p => {
    if ((p.rak || '').toLowerCase().trim() === targetRack.toLowerCase()) {
      p.rak = '';
      hasUpdatedProducts = true;
      if (firebaseDb && typeof saveProductCloud === 'function') {
        saveProductCloud(p);
      }
    }
  });

  if (hasUpdatedProducts) {
    saveProductsLocally();
    if (typeof renderProductsTable === 'function') renderProductsTable();
    if (typeof renderPosProducts === 'function') renderPosProducts();
  }

  updateRacksList();
  populateRackSelect('');
  alert(`✅ Rak "${targetRack}" berhasil dihapus.`);
}

// --- PENGATURAN NOTA & REBRANDING NAVBAR ---
function loadReceiptSettings() {
  // Update UI Pengaturan
  document.getElementById('store-name-input').value = receiptSettings.name;
  document.getElementById('store-phone-input').value = receiptSettings.phone;
  document.getElementById('store-address-input').value = receiptSettings.address;
  
  document.getElementById('receipt-font-header').value = receiptSettings.fontSizeHeader;
  document.getElementById('font-preview-header-val').textContent = `${receiptSettings.fontSizeHeader}px`;
  document.getElementById('receipt-font-items').value = receiptSettings.fontSizeItems;
  document.getElementById('font-preview-items-val').textContent = `${receiptSettings.fontSizeItems}px`;
  document.getElementById('receipt-font-footer').value = receiptSettings.fontSizeFooter;
  document.getElementById('font-preview-footer-val').textContent = `${receiptSettings.fontSizeFooter}px`;
  
  document.getElementById('chk-show-logo').checked = receiptSettings.showLogo;
  document.getElementById('chk-show-name').checked = receiptSettings.showName;
  document.getElementById('chk-show-address').checked = receiptSettings.showAddress;
  document.getElementById('chk-show-phone').checked = receiptSettings.showPhone;
  document.getElementById('chk-show-cashier').checked = receiptSettings.showCashier;
  document.getElementById('chk-show-subtotal').checked = receiptSettings.showSubtotal;
  document.getElementById('chk-show-discount').checked = receiptSettings.showDiscount;
  document.getElementById('chk-show-method').checked = receiptSettings.showMethod;
  document.getElementById('receipt-print-format').value = receiptSettings.printFormat || 'html';
  
  // Load Text Format Settings
  document.getElementById('receipt-text-title-font-size').value = receiptSettings.textTitleFontSize !== undefined ? receiptSettings.textTitleFontSize : 16;
  document.getElementById('text-title-font-preview-val').textContent = `${receiptSettings.textTitleFontSize !== undefined ? receiptSettings.textTitleFontSize : 16}pt`;
  document.getElementById('receipt-text-font-size').value = receiptSettings.textFontSize !== undefined ? receiptSettings.textFontSize : 12;
  document.getElementById('text-font-preview-val').textContent = `${receiptSettings.textFontSize !== undefined ? receiptSettings.textFontSize : 12}pt`;
  document.getElementById('receipt-text-padding-left').value = receiptSettings.textPaddingLeft !== undefined ? receiptSettings.textPaddingLeft : 1;
  document.getElementById('text-padding-preview-val').textContent = `${receiptSettings.textPaddingLeft !== undefined ? receiptSettings.textPaddingLeft : 1}mm`;
  document.getElementById('receipt-text-width').value = receiptSettings.textWidth !== undefined ? receiptSettings.textWidth : 25;
  document.getElementById('text-width-preview-val').textContent = `${receiptSettings.textWidth !== undefined ? receiptSettings.textWidth : 25} karakter`;
  
  // Load Individual Header Element Margins
  ['logo', 'name', 'address', 'phone'].forEach(item => {
    const key = `${item}MarginLR`;
    const val = receiptSettings[key] || 0;
    const sHtml = document.getElementById(`receipt-${item}-margin`);
    const sText = document.getElementById(`receipt-${item}-margin-text`);
    if (sHtml) sHtml.value = val;
    if (sText) sText.value = val;
    
    const lHtml = document.getElementById(`${item}-margin-preview-val`);
    const lText = document.getElementById(`${item}-margin-preview-text-val`);
    if (lHtml) lHtml.textContent = `${val}mm`;
    if (lText) lText.textContent = `${val}mm`;
  });
  
  applyReceiptSettings();
}

function updateFontPreview(type, val) {
  document.getElementById(`font-preview-${type}-val`).textContent = `${val}px`;
}

function saveAppConfig() {
  const chkStrictShift = document.getElementById('chk-strict-shift');
  if (chkStrictShift) {
    appConfig.strictShift = chkStrictShift.checked;
  }
  appConfig.allowZeroStock = document.getElementById('chk-allow-zero-stock').checked;
  appConfig.customerMode = document.getElementById('chk-customer-mode').checked;
  appConfig.enablePromo = document.getElementById('chk-enable-promo').checked;
  appConfig.showDiscountPos = document.getElementById('chk-show-discount').checked;
  
  const chkPromoBanner = document.getElementById('chk-show-promo-banner');
  if (chkPromoBanner) {
    appConfig.showPromoBanner = chkPromoBanner.checked;
  }

  const chkGridMode = document.getElementById('chk-pos-grid-mode');
  if (chkGridMode) {
    appConfig.posGridMode = chkGridMode.checked;
  }

  const chkAutoCash = document.getElementById('chk-auto-cash-noncash');
  if (chkAutoCash) {
    appConfig.autoCashNonCash = chkAutoCash.checked;
  }

  const chkPointsMode = document.getElementById('chk-loyalty-points-mode');
  if (chkPointsMode) {
    const newRewardMode = chkPointsMode.checked ? 'points' : 'voucher';
    if (loyaltySettings.rewardMode !== newRewardMode) {
      loyaltySettings.rewardMode = newRewardMode;
      localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
      saveLoyaltySettingsCloud();
      syncLoyaltySettingsUI();
      if (typeof renderCustomersTable === 'function') renderCustomersTable();
    }
  }
  
  localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
  saveAppConfigCloud();
  
  const promoContainer = document.getElementById('promo-fields-container');
  if (promoContainer) {
    promoContainer.style.display = appConfig.enablePromo ? 'grid' : 'none';
  }
  
  const shiftWrapper = document.getElementById('buka-shift-wrapper');
  if (shiftWrapper) {
    shiftWrapper.style.display = appConfig.strictShift ? 'flex' : 'none';
  }
  const sheetShiftItem = document.getElementById('m3-sheet-shift-item');
  if (sheetShiftItem) {
    sheetShiftItem.style.display = appConfig.strictShift ? 'flex' : 'none';
  }
  
  calculateTotal(); // Update POS discount visibility
  checkPromoBanner(); // Update visibilitas banner carousel promo
  if (typeof applyPosGridConfig === 'function') applyPosGridConfig();
  
  alert('Pengaturan Sistem Aplikasi berhasil disimpan!');
}

function saveAppConfigCloud() {
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('settings/appConfig')).set(appConfig).catch(err => {
        console.warn('⚠️ Gagal sinkron pengaturan sistem appConfig ke cloud:', err.message);
      });
    } catch (e) {
      console.warn('⚠️ Gagal trigger saveAppConfigCloud:', e);
    }
  }
}

function loadAppConfig() {
  const chkStrictShift = document.getElementById('chk-strict-shift');
  if (chkStrictShift) {
    chkStrictShift.checked = appConfig.strictShift;
  }
  document.getElementById('chk-allow-zero-stock').checked = appConfig.allowZeroStock;
  document.getElementById('chk-customer-mode').checked = appConfig.customerMode;
  document.getElementById('chk-enable-promo').checked = appConfig.enablePromo;
  
  const chkPointsMode = document.getElementById('chk-loyalty-points-mode');
  if (chkPointsMode) {
    chkPointsMode.checked = (loyaltySettings.rewardMode === 'points');
  }
  
  const chkDiscount = document.getElementById('chk-show-discount');
  if (chkDiscount) chkDiscount.checked = appConfig.showDiscountPos;

  const chkPromoBanner = document.getElementById('chk-show-promo-banner');
  if (chkPromoBanner) chkPromoBanner.checked = appConfig.showPromoBanner !== false;

  const chkGridMode = document.getElementById('chk-pos-grid-mode');
  if (chkGridMode) chkGridMode.checked = appConfig.posGridMode === true;
  if (typeof applyPosGridConfig === 'function') applyPosGridConfig();

  const chkAutoCash = document.getElementById('chk-auto-cash-noncash');
  if (chkAutoCash) chkAutoCash.checked = appConfig.autoCashNonCash === true;
  
  const discountRowWrapper = document.getElementById('discount-row-wrapper');
  if (discountRowWrapper) {
    discountRowWrapper.style.display = appConfig.showDiscountPos ? 'flex' : 'none';
  }
  
  const promoContainer = document.getElementById('promo-fields-container');
  if (promoContainer) {
    promoContainer.style.display = appConfig.enablePromo ? 'grid' : 'none';
  }
  
  const shiftWrapper = document.getElementById('buka-shift-wrapper');
  if (shiftWrapper) {
    shiftWrapper.style.display = appConfig.strictShift ? 'flex' : 'none';
  }
  const sheetShiftItem = document.getElementById('m3-sheet-shift-item');
  if (sheetShiftItem) {
    sheetShiftItem.style.display = appConfig.strictShift ? 'flex' : 'none';
  }

  const chkCloud = document.getElementById('chk-enable-cloud');
  const panelCloud = document.getElementById('firebase-settings-panel');
  if (chkCloud) chkCloud.checked = appConfig.enableCloudSync === true;
  if (panelCloud) panelCloud.style.display = appConfig.enableCloudSync ? 'block' : 'none';

  const chkAutoBackup = document.getElementById('chk-auto-daily-backup');
  if (chkAutoBackup) chkAutoBackup.checked = appConfig.enableDailyAutoBackup !== false;

  checkPromoBanner();
}

function applyReceiptSettings() {
  // 1. Rebranding Navbar Atas & Footer (Nama Toko & Logo)
  const storeNameEl = document.getElementById('app-store-name');
  if (storeNameEl) storeNameEl.textContent = receiptSettings.name;

  const footerNameEl = document.getElementById('store-footer-name');
  if (footerNameEl) footerNameEl.textContent = receiptSettings.name;
  
  const logoContainer = document.getElementById('app-logo-container');
  if (receiptSettings.logo) {
    logoContainer.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo" class="navbar-logo-img">`;
  } else {
    // Kembali ke SVG Default
    logoContainer.innerHTML = `
      <svg class="icon-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
      </svg>
    `;
  }
  
  // 2. Rebranding Struk Nota
  document.getElementById('rec-store-name').textContent = receiptSettings.name;
  document.getElementById('rec-store-address').textContent = receiptSettings.address;
  document.getElementById('rec-store-phone').textContent = `Telp: ${receiptSettings.phone}`;
  
  document.getElementById('rec-store-name').style.display = receiptSettings.showName ? 'block' : 'none';
  document.getElementById('rec-store-address').style.display = receiptSettings.showAddress ? 'block' : 'none';
  document.getElementById('rec-store-phone').style.display = receiptSettings.showPhone ? 'block' : 'none';
  
  const cashierRow = document.getElementById('rec-cashier-row');
  if (cashierRow) {
    cashierRow.style.display = receiptSettings.showCashier ? 'flex' : 'none';
  }
  
  const recLogoContainer = document.getElementById('rec-logo-container');
  if (receiptSettings.logo && receiptSettings.showLogo) {
    recLogoContainer.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo" class="receipt-logo-img">`;
    recLogoContainer.style.display = 'block';
  } else {
    recLogoContainer.innerHTML = '';
    recLogoContainer.style.display = 'none';
  }

  const recTextLogoContainer = document.getElementById('rec-text-logo-container');
  if (recTextLogoContainer) {
    if (receiptSettings.logo && receiptSettings.showLogo) {
      recTextLogoContainer.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo" class="receipt-logo-img">`;
      recTextLogoContainer.style.display = 'flex';
    } else {
      recTextLogoContainer.innerHTML = '';
      recTextLogoContainer.style.display = 'none';
    }
  }
  
  // 3. Atur Font Size & Margin Masing-Masing Elemen Header
  const receiptCard = document.getElementById('receipt-card-print');
  
  const receiptHeader = receiptCard.querySelector('.receipt-header');
  if (receiptHeader) {
    receiptHeader.style.fontSize = `${receiptSettings.fontSizeHeader}px`;
  }
  
  // Terapkan margin kiri-kanan masing-masing elemen (HTML & Text)
  const headerItemsMap = [
    { type: 'logo', ids: ['rec-logo-container', 'rec-text-logo-container'] },
    { type: 'name', ids: ['rec-store-name', 'rec-text-store-name'] },
    { type: 'address', ids: ['rec-store-address', 'rec-text-store-address'] },
    { type: 'phone', ids: ['rec-store-phone', 'rec-text-store-phone'] }
  ];

  headerItemsMap.forEach(itemObj => {
    const m = receiptSettings[`${itemObj.type}MarginLR`] || 0;
    itemObj.ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.paddingLeft = m > 0 ? `${m}mm` : '0px';
        el.style.boxSizing = 'border-box';
      }
    });
  });
  
  const receiptItems = receiptCard.querySelector('.receipt-items');
  if (receiptItems) receiptItems.style.fontSize = `${receiptSettings.fontSizeItems}px`;
  
  const receiptTotals = receiptCard.querySelector('.receipt-totals');
  if (receiptTotals) receiptTotals.style.fontSize = `${receiptSettings.fontSizeFooter}px`;
  
  // Sembunyikan Subtotal, Diskon, Metode
  const subtotalRow = document.getElementById('rec-subtotal-row');
  if (subtotalRow) subtotalRow.style.display = receiptSettings.showSubtotal ? 'flex' : 'none';
  
  const discountRow = document.getElementById('rec-discount-row');
  if (discountRow) discountRow.style.display = receiptSettings.showDiscount ? 'flex' : 'none';
  
  const methodRow = document.getElementById('rec-method-row');
  if (methodRow) methodRow.style.display = receiptSettings.showMethod ? 'flex' : 'none';
  
  // 4. Update logo preview box di pengaturan
  const previewBox = document.getElementById('logo-preview-box');
  if (receiptSettings.logo) {
    previewBox.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo Preview">`;
  } else {
    previewBox.innerHTML = `<span>Belum ada Logo</span>`;
  }

  // 5. Atur Format Cetak Struk (HTML vs Text)
  const printFormat = receiptSettings.printFormat || 'html';
  const htmlContent = document.getElementById('receipt-html-content');
  const textContent = document.getElementById('receipt-text-content');
  
  const htmlSettings = document.getElementById('html-format-settings');
  const textSettings = document.getElementById('text-format-settings');
  
  if (htmlContent && textContent) {
    if (printFormat === 'text') {
      htmlContent.style.display = 'none';
      textContent.style.display = 'flex';
      document.body.classList.remove('print-format-html');
      document.body.classList.add('print-format-text');
      
      if (htmlSettings) htmlSettings.style.display = 'none';
      if (textSettings) textSettings.style.display = 'flex';
    } else {
      htmlContent.style.display = 'block';
      textContent.style.display = 'none';
      document.body.classList.remove('print-format-text');
      document.body.classList.add('print-format-html');
      
      if (htmlSettings) htmlSettings.style.display = 'flex';
      if (textSettings) textSettings.style.display = 'none';
    }
  }
  
  // Set CSS Variables for Plain Text Format dynamic values
  const textTitleFontSize = receiptSettings.textTitleFontSize !== undefined ? receiptSettings.textTitleFontSize : 16; // in pt
  const textFontSize = receiptSettings.textFontSize !== undefined ? receiptSettings.textFontSize : 12; // in pt
  const textPaddingLeft = receiptSettings.textPaddingLeft !== undefined ? receiptSettings.textPaddingLeft : 1; // in mm
  const textWidth = receiptSettings.textWidth !== undefined ? receiptSettings.textWidth : 25; // character columns
  
  document.documentElement.style.setProperty('--print-text-title-size', `${textTitleFontSize}pt`);
  document.documentElement.style.setProperty('--print-text-font-size', `${textFontSize}pt`);
  document.documentElement.style.setProperty('--print-text-padding-left', `${textPaddingLeft}mm`);
  document.documentElement.style.setProperty('--print-text-width', textWidth);
}

// Memicu klik input file untuk logo
function triggerLogoUpload() {
  document.getElementById('logo-file-input').click();
}

// Konversi berkas gambar ke Base64 (Offline-Safe)
function handleLogoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    receiptSettings.logo = e.target.result;
    
    // Update preview box langsung
    const previewBox = document.getElementById('logo-preview-box');
    previewBox.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo Preview">`;
  };
  reader.readAsDataURL(file);
}

function updateReceiptFontSizePreview(val) {
  const el = document.getElementById('font-size-preview-val');
  if (el) el.textContent = `${val}px`;
}

function updateTextTitleFontPreview(val) {
  document.getElementById('text-title-font-preview-val').textContent = `${val}pt`;
  const textTitleFontSize = parseFloat(val) || 16;
  document.documentElement.style.setProperty('--print-text-title-size', `${textTitleFontSize}pt`);
}

function updateTextFontPreview(val) {
  document.getElementById('text-font-preview-val').textContent = `${val}pt`;
  const textFontSize = parseFloat(val) || 12;
  document.documentElement.style.setProperty('--print-text-font-size', `${textFontSize}pt`);
}

function updateTextPaddingPreview(val) {
  document.getElementById('text-padding-preview-val').textContent = `${val}mm`;
  const textPaddingLeft = parseFloat(val) || 1;
  document.documentElement.style.setProperty('--print-text-padding-left', `${textPaddingLeft}mm`);
}

function updateTextWidthPreview(val) {
  document.getElementById('text-width-preview-val').textContent = `${val} karakter`;
  const textWidth = parseInt(val) || 25;
  document.documentElement.style.setProperty('--print-text-width', textWidth);
}

function updateItemMarginPreview(type, val) {
  const marginVal = parseFloat(val) || 0;
  const key = `${type}MarginLR`;
  receiptSettings[key] = marginVal;
  
  // Sync HTML and Text sliders
  const sHtml = document.getElementById(`receipt-${type}-margin`);
  const sText = document.getElementById(`receipt-${type}-margin-text`);
  if (sHtml) sHtml.value = marginVal;
  if (sText) sText.value = marginVal;
  
  const lHtml = document.getElementById(`${type}-margin-preview-val`);
  const lText = document.getElementById(`${type}-margin-preview-text-val`);
  if (lHtml) lHtml.textContent = `${marginVal}mm`;
  if (lText) lText.textContent = `${marginVal}mm`;

  // Dynamic preview update for both HTML and Text elements
  const targetMap = {
    logo: ['rec-logo-container', 'rec-text-logo-container'],
    name: ['rec-store-name', 'rec-text-store-name'],
    address: ['rec-store-address', 'rec-text-store-address'],
    phone: ['rec-store-phone', 'rec-text-store-phone']
  };

  const targets = targetMap[type] || [];
  targets.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.paddingLeft = marginVal > 0 ? `${marginVal}mm` : '0px';
      el.style.boxSizing = 'border-box';
    }
  });
}

function saveReceiptSettings() {
  receiptSettings.name = document.getElementById('store-name-input').value.trim() || 'Toko Sahil POS';
  receiptSettings.phone = document.getElementById('store-phone-input').value.trim() || '-';
  receiptSettings.address = document.getElementById('store-address-input').value.trim() || '-';
  
  receiptSettings.fontSizeHeader = parseInt(document.getElementById('receipt-font-header').value) || 14;
  receiptSettings.fontSizeItems = parseInt(document.getElementById('receipt-font-items').value) || 12;
  receiptSettings.fontSizeFooter = parseInt(document.getElementById('receipt-font-footer').value) || 12;
  
  ['logo', 'name', 'address', 'phone'].forEach(item => {
    const sHtml = document.getElementById(`receipt-${item}-margin`);
    const sText = document.getElementById(`receipt-${item}-margin-text`);
    if (sHtml) {
      receiptSettings[`${item}MarginLR`] = parseFloat(sHtml.value) || 0;
    } else if (sText) {
      receiptSettings[`${item}MarginLR`] = parseFloat(sText.value) || 0;
    }
  });
  
  receiptSettings.showLogo = document.getElementById('chk-show-logo').checked;
  receiptSettings.showName = document.getElementById('chk-show-name').checked;
  receiptSettings.showAddress = document.getElementById('chk-show-address').checked;
  receiptSettings.showPhone = document.getElementById('chk-show-phone').checked;
  receiptSettings.showCashier = document.getElementById('chk-show-cashier').checked;
  receiptSettings.showSubtotal = document.getElementById('chk-show-subtotal').checked;
  receiptSettings.showDiscount = document.getElementById('chk-show-discount').checked;
  receiptSettings.showMethod = document.getElementById('chk-show-method').checked;
  receiptSettings.printFormat = document.getElementById('receipt-print-format').value;
  
  // Save Text Format Settings
  receiptSettings.textTitleFontSize = parseFloat(document.getElementById('receipt-text-title-font-size').value) || 16;
  receiptSettings.textFontSize = parseFloat(document.getElementById('receipt-text-font-size').value) || 12;
  receiptSettings.textPaddingLeft = parseFloat(document.getElementById('receipt-text-padding-left').value) || 1;
  receiptSettings.textWidth = parseInt(document.getElementById('receipt-text-width').value) || 25;
  
  localStorage.setItem('kasir_receipt_settings', JSON.stringify(receiptSettings));
  
  // Sinkronisasi ke Cloud Database per lisensi toko
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('settings/receipt')).set(receiptSettings).catch(err => {
        console.warn('⚠️ Gagal sinkron pengaturan toko ke cloud:', err.message);
      });
    } catch (e) {}
  }

  applyReceiptSettings();
  loadLabelSettings();
  loadProductLabelSettings();
  renderProductsTable();
  alert('Pengaturan Branding & Nota berhasil disimpan dan disinkronkan ke Cloud!');
}

function loadLabelSettings() {
  document.getElementById('setting-label-width').value = labelSettings.width || 65;
  document.getElementById('setting-label-height').value = labelSettings.height || 30;
  document.getElementById('setting-label-margin-left').value = labelSettings.marginLeft !== undefined ? labelSettings.marginLeft : 0;
  document.getElementById('setting-label-chars').value = labelSettings.chars || 25;
  const barcodeEl = document.getElementById('setting-label-show-barcode');
  if (barcodeEl) barcodeEl.checked = !!labelSettings.showBarcode;
  document.getElementById('setting-label-show-price').checked = labelSettings.showPrice !== false;
  document.getElementById('setting-label-price-fontsize').value = labelSettings.priceFontSize || 30;
  document.getElementById('label-price-fontsize-val').textContent = `${labelSettings.priceFontSize || 30}pt`;
  document.getElementById('setting-label-price-fontweight').value = labelSettings.priceFontWeight || 1300;
  document.getElementById('setting-label-name-fontsize').value = labelSettings.nameFontSize || 12;
  document.getElementById('label-name-fontsize-val').textContent = `${labelSettings.nameFontSize || 12}pt`;
  document.getElementById('setting-label-name-fontweight').value = labelSettings.nameFontWeight || 900;
}

function saveLabelSettings() {
  labelSettings.width = parseFloat(document.getElementById('setting-label-width').value) || 65;
  labelSettings.height = parseFloat(document.getElementById('setting-label-height').value) || 30;
  labelSettings.marginLeft = parseFloat(document.getElementById('setting-label-margin-left').value) || 0;
  labelSettings.chars = parseInt(document.getElementById('setting-label-chars').value) || 25;
  const barcodeEl = document.getElementById('setting-label-show-barcode');
  labelSettings.showBarcode = barcodeEl ? barcodeEl.checked : false;
  labelSettings.showPrice = document.getElementById('setting-label-show-price').checked;
  labelSettings.priceFontSize = parseInt(document.getElementById('setting-label-price-fontsize').value) || 30;
  labelSettings.priceFontWeight = parseInt(document.getElementById('setting-label-price-fontweight').value) || 1300;
  labelSettings.nameFontSize = parseInt(document.getElementById('setting-label-name-fontsize').value) || 12;
  labelSettings.nameFontWeight = parseInt(document.getElementById('setting-label-name-fontweight').value) || 900;
  
  localStorage.setItem('kasir_label_settings', JSON.stringify(labelSettings));
  alert('Pengaturan Cetak Label Rak berhasil disimpan!');
}

function loadProductLabelSettings() {
  document.getElementById('setting-prodlabel-width').value = productLabelSettings.width || 50;
  document.getElementById('setting-prodlabel-height').value = productLabelSettings.height || 30;
  document.getElementById('setting-prodlabel-margin-left').value = productLabelSettings.marginLeft || 0;
  document.getElementById('setting-prodlabel-chars').value = productLabelSettings.chars || 25;
  document.getElementById('setting-prodlabel-show-barcode').checked = productLabelSettings.showBarcode !== false;
  document.getElementById('setting-prodlabel-show-price').checked = productLabelSettings.showPrice !== false;
  document.getElementById('setting-prodlabel-show-storename').checked = productLabelSettings.showStoreName !== false;
  document.getElementById('setting-prodlabel-barcode-width').value = productLabelSettings.barcodeWidth || 1.5;
  document.getElementById('prodlabel-barcode-width-val').textContent = productLabelSettings.barcodeWidth || 1.5;
  document.getElementById('setting-prodlabel-barcode-height').value = productLabelSettings.barcodeHeight || 32;
  document.getElementById('prodlabel-barcode-height-val').textContent = (productLabelSettings.barcodeHeight || 32) + 'px';
}

function saveProductLabelSettings() {
  productLabelSettings.width = parseFloat(document.getElementById('setting-prodlabel-width').value) || 50;
  productLabelSettings.height = parseFloat(document.getElementById('setting-prodlabel-height').value) || 30;
  productLabelSettings.marginLeft = parseFloat(document.getElementById('setting-prodlabel-margin-left').value) || 0;
  productLabelSettings.chars = parseInt(document.getElementById('setting-prodlabel-chars').value) || 25;
  productLabelSettings.showBarcode = document.getElementById('setting-prodlabel-show-barcode').checked;
  productLabelSettings.showPrice = document.getElementById('setting-prodlabel-show-price').checked;
  productLabelSettings.showStoreName = document.getElementById('setting-prodlabel-show-storename').checked;
  productLabelSettings.barcodeWidth = parseFloat(document.getElementById('setting-prodlabel-barcode-width').value) || 1.5;
  productLabelSettings.barcodeHeight = parseInt(document.getElementById('setting-prodlabel-barcode-height').value) || 32;
  
  localStorage.setItem('kasir_product_label_settings', JSON.stringify(productLabelSettings));
  alert('Pengaturan Cetak Label Produk berhasil disimpan!');
}

function toggleSidebar() {
  const navTabs = document.querySelector('.nav-tabs');
  if (navTabs) {
    navTabs.classList.toggle('sidebar-active');
  }
}

// --- NAVIGASI TAB ---
function switchTab(tabName) {
  // Cek apakah pengguna saat ini berhak membuka tab ini
  if (!canAccessTab(tabName)) {
    alert(`⛔ Akses Terbatas!\n\nAkun "${activeCashier}" tidak memiliki izin untuk membuka menu ini.\nSilakan masuk sebagai Owner untuk mengakses menu ini.`);
    openCashierLoginModal();
    return;
  }

  activeTab = tabName;
  
  const navTabs = document.querySelector('.nav-tabs');
  if (navTabs) navTabs.classList.remove('sidebar-active');
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  const topTab = document.getElementById(`tab-${tabName}`);
  if (topTab) topTab.classList.add('active');

  // Update State Aktif pada M3 Bottom Navigation Bar
  document.querySelectorAll('.m3-nav-item').forEach(item => {
    item.classList.remove('active');
  });
  const m3Fab = document.getElementById('m3-tab-pos');
  if (m3Fab) m3Fab.classList.remove('active');

  const m3Item = document.getElementById(`m3-tab-${tabName}`);
  if (m3Item) {
    m3Item.classList.add('active');
  } else if (tabName === 'kulak' || tabName === 'customers' || tabName === 'settings') {
    // Menu sekunder di sheet "Saya"
    const moreTab = document.getElementById('m3-tab-more');
    if (moreTab) moreTab.classList.add('active');
  }

  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });
  const targetPane = document.getElementById(`pane-${tabName}`);
  if (targetPane) targetPane.classList.add('active');

  // Perbarui status icon keranjang melayang di mobile
  if (typeof updateMobileCartBadge === 'function') {
    updateMobileCartBadge();
  }
  
  // Aksi tab
  if (tabName === 'pos') {
    closeFloatingResults();
    document.getElementById('search-input').value = '';
    renderCart();
    if (typeof applyPosGridConfig === 'function') applyPosGridConfig();
    focusSearchInput();
  } else if (tabName === 'products') {
    lastScannedProductId = null;
    document.getElementById('product-list-search').value = '';
    renderProductsTable();
    resetProductForm();
    focusProductListSearch();
  } else if (tabName === 'analytics') {
    initAnalyticsFilter();
    updateAnalytics();
    if (weeklyTrendData.length === 0) {
      loadWeeklyTrendInBackground();
    }
  } else if (tabName === 'kulak') {
    closeKulakForm();
    if (typeof renderSalesTable === 'function') renderSalesTable();
    if (typeof updateSalesDropdowns === 'function') updateSalesDropdowns();
    focusKulakSearch();
  } else if (tabName === 'transactions') {
    document.getElementById('transaction-list-search').value = '';
    renderTransactionsTable();
    closeEditTransactionModal();
  }

  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

// Handler Material Design 3 Bottom Sheet ("Saya" / Menu Tambahan)
function toggleMobileMoreSheet() {
  const sheet = document.getElementById('m3-bottom-sheet');
  const backdrop = document.getElementById('m3-sheet-backdrop');
  if (!sheet || !backdrop) return;

  const isOpen = sheet.classList.contains('active');
  if (isOpen) {
    closeMobileMoreSheet();
  } else {
    // Update info akun di header sheet
    const userTitle = document.getElementById('m3-sheet-user-title');
    const storeInfo = document.getElementById('m3-sheet-store-info');
    if (userTitle) userTitle.textContent = `${activeCashier} (${currentUserRole === 'owner' ? 'Owner' : 'Kasir'})`;
    if (storeInfo) storeInfo.textContent = receiptSettings.name || 'Toko Sahil POS';

    // Sesuaikan item Shift Kasir & Ganti Akun sesuai status fitur di pengaturan
    const sheetShiftItem = document.getElementById('m3-sheet-shift-item');
    if (sheetShiftItem) {
      sheetShiftItem.style.display = appConfig.strictShift ? 'flex' : 'none';
    }
    const sheetAuthItem = document.getElementById('m3-sheet-auth-item');
    if (sheetAuthItem) {
      sheetAuthItem.style.display = isStaffLoginEnabled ? 'flex' : 'none';
    }

    backdrop.classList.add('active');
    sheet.classList.add('active');
  }
}

function closeMobileMoreSheet() {
  const sheet = document.getElementById('m3-bottom-sheet');
  const backdrop = document.getElementById('m3-sheet-backdrop');
  if (sheet) sheet.classList.remove('active');
  if (backdrop) backdrop.classList.remove('active');
}

function switchTabFromSheet(tabName) {
  closeMobileMoreSheet();
  switchTab(tabName);
}

// Fokuskan kursor ke input kasir
function focusSearchInput() {
  setTimeout(() => {
    const input = document.getElementById('search-input');
    if (input && activeTab === 'pos') {
      const activeModal = document.querySelector('.modal.active, .modal-overlay.active');
      if (!activeModal) {
        input.focus();
        input.select();
      }
    }
  }, 50);
}

// --- MOBILE CHECKOUT PANEL ---
function toggleMobileCheckout() {
  const panel = document.getElementById('pos-right-section');
  const overlay = document.getElementById('mobile-checkout-overlay');
  const floatBtn = document.getElementById('mobile-cart-float-btn');
  if (!panel) return;
  const isOpen = panel.classList.contains('mobile-panel-open');
  if (isOpen) {
    closeMobileCheckout();
  } else {
    panel.classList.add('mobile-panel-open');
    if (overlay) overlay.classList.add('active');
    // Sembunyikan icon keranjang bulat ketika dialog ringkasan belanja terbuka
    if (floatBtn) floatBtn.style.display = 'none';
    document.body.style.overflow = 'hidden';
  }
}

function closeMobileCheckout() {
  const panel = document.getElementById('pos-right-section');
  const overlay = document.getElementById('mobile-checkout-overlay');
  const floatBtn = document.getElementById('mobile-cart-float-btn');
  if (panel) panel.classList.remove('mobile-panel-open');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
  // Tampilkan kembali icon keranjang bulat jika masih ada item belanja di kasir
  if (typeof updateMobileCartBadge === 'function') {
    updateMobileCartBadge();
  }
}

function updateMobileCartBadge() {
  const badge = document.getElementById('mobile-cart-badge');
  const floatBadge = document.getElementById('mobile-cart-float-badge');
  const floatTotal = document.getElementById('mobile-cart-float-total');
  const floatBtn = document.getElementById('mobile-cart-float-btn');
  const isMobile = window.innerWidth <= 768;
  
  const totalQty = cart.reduce((sum, it) => sum + (it.qty || 0), 0);
  if (badge) {
    badge.textContent = totalQty;
    badge.style.display = totalQty > 0 ? 'flex' : 'none';
  }
  if (floatBadge) {
    floatBadge.textContent = totalQty;
  }
  if (floatTotal) {
    floatTotal.textContent = `Rp ${formatRupiah(globalTotal || 0)}`;
  }
  if (floatBtn) {
    // Tombol keranjang & total belanja melayang HANYA boleh muncul di mode mobile (<= 768px), di kasir (POS), dan ada item belanja
    if (isMobile && activeTab === 'pos' && totalQty > 0) {
      floatBtn.style.display = 'flex';
    } else {
      floatBtn.style.display = 'none';
    }
  }

  // Jika opsi menu grid aktif di POS, perbarui badge jumlah pada kartu produk
  if (appConfig.posGridMode === true && activeTab === 'pos') {
    const catalogContainer = document.getElementById('pos-catalog-container');
    if (catalogContainer && catalogContainer.style.display !== 'none') {
      renderPosCatalogGrid();
    }
  }
}

// Fokuskan kursor ke input Kulak
function focusKulakSearch() {
  setTimeout(() => {
    const input = document.getElementById('kulak-search-input');
    if (input && activeTab === 'kulak') {
      const activeModal = document.querySelector('.modal.active, .modal-overlay.active');
      if (!activeModal) {
        input.focus();
        input.select();
      }
    }
  }, 50);
}

// Fokuskan kursor ke input Produk & Stok
function focusProductListSearch() {
  setTimeout(() => {
    const input = document.getElementById('product-list-search');
    if (input && activeTab === 'products') {
      const activeModal = document.querySelector('.modal.active, .modal-overlay.active');
      if (!activeModal) {
        input.focus();
        input.select();
      }
    }
  }, 50);
}

// Fokuskan input sesuai tab aktif
function focusActiveTabSearch() {
  if (activeTab === 'pos') focusSearchInput();
  else if (activeTab === 'products') focusProductListSearch();
  else if (activeTab === 'kulak') focusKulakSearch();
}

// --- SINKRONISASI & API ---
function updateSyncStatus(status, text) {
  syncStatus = status;
  const statusEl = document.getElementById('sync-status');
  const textEl = document.getElementById('sync-text');
  if (statusEl && textEl) {
    statusEl.className = 'sync-status ' + status;
    textEl.textContent = text;
  }
}





// Parsing daftar item string "Teh Manis (2x @4000)" kembali ke objek
function parseTransactionItemsString(itemsStr) {
  if (!itemsStr) return [];
  const list = [];
  const parts = itemsStr.split(", ");
  
  parts.forEach(part => {
    // Regex mencocokkan format: Nama Barang (Qtyx @Harga)
    const match = part.match(/(.+) \((\d+)x @(\d+)\)/);
    if (match) {
      const nama = match[1].trim();
      const qty = parseInt(match[2]) || 1;
      const harga = parseFloat(match[3]) || 0;
      
      // Lookup harga beli di database lokal saat ini
      const prod = products.find(p => p.nama.toLowerCase() === nama.toLowerCase());
      const harga_beli = prod ? prod.harga_beli : Math.round(harga * 0.7); // estimasi jika data produk terhapus
      
      list.push({
        id: prod ? prod.id : '',
        nama: nama,
        harga: harga,
        harga_beli: harga_beli,
        qty: qty
      });
    }
  });
  return list;
}

// --- TAB 1: MODUL ANALISIS PENJUALAN ---

function getLocalISODate(dateStrOrObj) {
  const date = new Date(dateStrOrObj);
  if (isNaN(date)) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString();
}

function parseTxDateStr(waktu) {
  if (!waktu) return '';
  if (typeof waktu === 'string') {
    const match = waktu.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      if (waktu.includes('T')) {
        const d = new Date(waktu);
        if (!isNaN(d)) return getLocalISODate(d).slice(0, 10);
      }
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
    const slashMatch = waktu.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      const d = new Date(waktu);
      if (!isNaN(d)) return getLocalISODate(d).slice(0, 10);
      return `${slashMatch[3]}-${slashMatch[1].padStart(2, '0')}-${slashMatch[2].padStart(2, '0')}`;
    }
  }
  const d = new Date(waktu);
  if (!isNaN(d)) return getLocalISODate(d).slice(0, 10);
  return String(waktu).slice(0, 10);
}

function getAllAvailableTransactions() {
  const map = new Map();
  if (Array.isArray(weeklyTrendData)) {
    weeklyTrendData.forEach(tx => {
      if (tx && (tx.id || tx.id_transaksi)) {
        const id = String(tx.id || tx.id_transaksi).trim();
        if (id) map.set(id, tx);
      }
    });
  }
  if (Array.isArray(analyticsTransactions)) {
    analyticsTransactions.forEach(tx => {
      if (tx && (tx.id || tx.id_transaksi)) {
        const id = String(tx.id || tx.id_transaksi).trim();
        if (id) map.set(id, tx);
      }
    });
  }
  if (Array.isArray(transactions)) {
    transactions.forEach(tx => {
      if (tx && (tx.id || tx.id_transaksi)) {
        const id = String(tx.id || tx.id_transaksi).trim();
        if (id) map.set(id, tx);
      }
    });
  }
  return Array.from(map.values());
}

// Inisialisasi filter analisis (hari ini by default)
function initAnalyticsFilter() {
  const nowStr = getLocalISODate(new Date());
  const todayStr = nowStr.slice(0, 10);
  const thisMonth = todayStr.slice(0, 7); // YYYY-MM
  const thisYear = new Date().getFullYear();
  
  // Set default date filter to today
  const dateInput = document.getElementById('analytics-filter-date');
  if (dateInput && !dateInput.value) dateInput.value = todayStr;
  
  const monthInput = document.getElementById('analytics-filter-month');
  if (monthInput && !monthInput.value) monthInput.value = thisMonth;
  
  // Populate year dropdown from transaction years + current year
  const yearSelect = document.getElementById('analytics-filter-year');
  if (yearSelect) {
    const years = new Set([thisYear]);
    transactions.forEach(tx => {
      if (tx.waktu) years.add(parseInt(tx.waktu.slice(0, 4)));
    });
    const sortedYears = [...years].sort((a, b) => b - a);
    yearSelect.innerHTML = sortedYears.map(y => 
      `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}</option>`
    ).join('');
  }
}

function onAnalyticsFilterTypeChange() {
  const filterType = document.getElementById('analytics-filter-type').value;
  document.getElementById('analytics-filter-date-wrap').style.display = filterType === 'hari' ? 'flex' : 'none';
  document.getElementById('analytics-filter-month-wrap').style.display = filterType === 'bulan' ? 'flex' : 'none';
  document.getElementById('analytics-filter-year-wrap').style.display = filterType === 'tahun' ? 'flex' : 'none';
  fetchAndUpdateAnalytics();
}

/// Buffer khusus analitik - tidak menimpa transactions (data hari ini)
let analyticsTransactions = null; // null = pakai transactions lokal (hari ini)

// Buffer khusus grafik 7 hari - diisi diam-diam di background
let weeklyTrendData = []; // array gabungan: 6 hari lalu (cloud) + hari ini (lokal)

// Dipanggil 3 detik setelah app siap — muat 6 hari lalu secara diam-diam untuk grafik tren
async function loadWeeklyTrendInBackground() {
  // Seluruh transaksi historis sudah tersimpan di Realtime Database dan termuat di `transactions`
  weeklyTrendData = [...transactions];
  render7DayChart();
}

// Dipanggil saat filter analitik berubah: tarik cloud jika perlu, lalu render
async function fetchAndUpdateAnalytics() {
  const todayStr = getLocalISODate(new Date()).slice(0, 10);
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';

  let needCloud = false;
  let startDate = '';
  let endDate = '';

  if (filterType === 'hari') {
    const dateVal = document.getElementById('analytics-filter-date')?.value || todayStr;
    if (dateVal !== todayStr) {
      needCloud = true;
      startDate = dateVal;
      endDate = dateVal;
    }
  } else if (filterType === 'bulan') {
    const monthVal = document.getElementById('analytics-filter-month')?.value || todayStr.slice(0, 7);
    const isThisMonth = monthVal === todayStr.slice(0, 7);
    if (!isThisMonth) {
      needCloud = true;
      startDate = monthVal + '-01';
      // Hari terakhir bulan tersebut
      const [y, m] = monthVal.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      endDate = monthVal + '-' + String(lastDay).padStart(2, '0');
    }
  } else if (filterType === 'tahun') {
    const yearVal = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
    const isThisYear = yearVal === String(new Date().getFullYear());
    if (!isThisYear) {
      needCloud = true;
      startDate = yearVal + '-01-01';
      endDate = yearVal + '-12-31';
    }
  } else if (filterType === 'semua') {
    needCloud = true;
    startDate = '';
    endDate = '';
  }

  analyticsTransactions = null;
  updateAnalytics();
}

function getAnalyticsFilteredTxs() {
  // Gunakan buffer analitik jika ada (data historis dari cloud), atau transactions lokal
  const source = (analyticsTransactions !== null && analyticsTransactions !== undefined) ? analyticsTransactions : transactions;

  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  if (filterType === 'hari') {
    const dateVal = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
    return source.filter(tx => tx.waktu && parseTxDateStr(tx.waktu) === dateVal);
  } else if (filterType === 'bulan') {
    const monthVal = document.getElementById('analytics-filter-month')?.value || getLocalISODate(new Date()).slice(0, 7);
    return source.filter(tx => tx.waktu && parseTxDateStr(tx.waktu).slice(0, 7) === monthVal);
  } else if (filterType === 'tahun') {
    const yearVal = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
    return source.filter(tx => tx.waktu && parseTxDateStr(tx.waktu).slice(0, 4) === yearVal);
  } else {
    return [...source];
  }
}

function getHistoricalProductStock(targetDateStr) {
  // Rekonstruksi akurat posisi produk dan stok pada tanggal targetDateStr (YYYY-MM-DD):
  // 1. Produk belum ada pada tanggal tersebut jika tanggal dibuat / transaksi pertama / kulak pertama setelah targetDateStr.
  // 2. Stok pada tanggal = stok_saat_ini 
  //    + sum(penjualan SETELAH targetDateStr) 
  //    - sum(kulak/pembelian sales SETELAH targetDateStr) 
  //    + sum(retur sales SETELAH targetDateStr)
  //    - penyesuaian opname SETELAH targetDateStr
  if (!targetDateStr) {
    return products.map(p => ({ ...p, stok: Number(p.stok) || 0 }));
  }

  const txSource = (analyticsTransactions !== null && analyticsTransactions !== undefined) ? analyticsTransactions : transactions;
  const targetDateOnly = targetDateStr.slice(0, 10);

  // Kumpulkan seluruh tanggal aktivitas paling awal (earliest activity) per produk untuk menentukan kapan produk mulai ada di toko
  const earliestActivityMap = {};

  // a. Dari data produk langsung jika punya createdAt
  products.forEach(p => {
    if (p.createdAt) {
      earliestActivityMap[p.id] = p.createdAt.slice(0, 10);
    }
  });

  // b. Dari transaksi penjualan
  txSource.forEach(tx => {
    if (tx.waktu && Array.isArray(tx.items)) {
      const d = parseTxDateStr(tx.waktu).slice(0, 10);
      tx.items.forEach(it => {
        const pId = it.id;
        if (pId) {
          if (!earliestActivityMap[pId] || d < earliestActivityMap[pId]) {
            earliestActivityMap[pId] = d;
          }
        }
      });
    }
  });

  // c. Dari nota kulak / delivery sales
  if (Array.isArray(salesDeliveries)) {
    salesDeliveries.forEach(deliv => {
      if (deliv.tanggal && Array.isArray(deliv.items)) {
        const d = String(deliv.tanggal).slice(0, 10);
        deliv.items.forEach(it => {
          const pId = it.productId;
          if (pId) {
            if (!earliestActivityMap[pId] || d < earliestActivityMap[pId]) {
              earliestActivityMap[pId] = d;
            }
          }
        });
      }
    });
  }

  // d. Dari riwayat opname
  if (Array.isArray(stockOpnames)) {
    stockOpnames.forEach(op => {
      if (op.waktu && op.productId) {
        const d = parseTxDateStr(op.waktu).slice(0, 10);
        if (!earliestActivityMap[op.productId] || d < earliestActivityMap[op.productId]) {
          earliestActivityMap[op.productId] = d;
        }
      }
    });
  }

  const result = [];

  products.forEach(p => {
    // Cek apakah produk sudah ada di tanggal target:
    // Jika ada tanggal aktivitas paling awal dan targetDateOnly LEBIH KECIL dari tanggal tersebut, maka produk belum ada!
    const pNameKey = p.nama ? p.nama.trim().toLowerCase() : '';
    const earliestDate = earliestActivityMap[p.id] || (pNameKey ? earliestActivityMap[pNameKey] : null) || (p.createdAt ? p.createdAt.slice(0, 10) : null);
    if (earliestDate && targetDateOnly < earliestDate) {
      return; // Skip: produk belum ada pada tanggal yang dipilih
    }

    let reconstructedStock = Number(p.stok) || 0;

    // 1. Tambah kembali penjualan yang terjadi SETELAH targetDateStr
    txSource.forEach(tx => {
      if (tx.waktu) {
        const txDate = parseTxDateStr(tx.waktu).slice(0, 10);
        if (txDate > targetDateOnly && Array.isArray(tx.items)) {
          tx.items.forEach(item => {
            const isMatch = (item.id === p.id) || (p.nama && item.nama === p.nama);
            if (isMatch) {
              const qtyMultiplier = item.isBox ? (item.isiBox || 1) : (item.isGrosir ? (item.grosirQty || 1) : 1);
              reconstructedStock += ((Number(item.qty) || 0) * qtyMultiplier);
            }
          });
        }
      }
    });

    // 2. Kurangi stok dari pembelian kulakan (sales deliveries) yang datang SETELAH targetDateStr
    if (Array.isArray(salesDeliveries)) {
      salesDeliveries.forEach(deliv => {
        if (deliv.tanggal) {
          const delivDate = String(deliv.tanggal).slice(0, 10);
          if (delivDate > targetDateOnly && Array.isArray(deliv.items)) {
            deliv.items.forEach(it => {
              if (it.productId === p.id || (p.nama && it.nama === p.nama)) {
                reconstructedStock -= (Number(it.qty) || 0);
              }
            });
          }
        }
      });
    }

    // 3. Tambah kembali retur sales yang ditarik fisik SETELAH targetDateStr
    if (Array.isArray(salesReturns)) {
      salesReturns.forEach(ret => {
        if (ret.tanggal && ret.status === 'Sudah Diganti Fisik') {
          const retDate = String(ret.tanggal).slice(0, 10);
          if (retDate > targetDateOnly && (ret.productId === p.id || (p.nama && ret.productName === p.nama))) {
            reconstructedStock += (Number(ret.qty) || 0);
          }
        }
      });
    }

    // 4. Balikkan penyesuaian selisih Stock Opname yang terjadi SETELAH targetDateStr
    if (Array.isArray(stockOpnames)) {
      stockOpnames.forEach(op => {
        if (op.waktu && (op.productId === p.id || (p.nama && op.productName === p.nama))) {
          const opDate = parseTxDateStr(op.waktu).slice(0, 10);
          if (opDate > targetDateOnly) {
            // Jika saat opname stok ditambah diff, maka mundur ke masa lalu stok dikurangi diff
            reconstructedStock -= (Number(op.selisih) || 0);
          }
        }
      });
    }

    result.push({
      ...p,
      stok: Math.max(0, reconstructedStock)
    });
  });

  return result;
}

function updateAnalytics() {
  const now = new Date();
  
  // Filter transaksi sesuai filter yang dipilih
  const todayTxs = getAnalyticsFilteredTxs();
  
  // Set label untuk Produk Terlaris & Widget
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  const labelEl = document.getElementById('best-seller-period');
  if (labelEl) {
    if (filterType === 'hari') {
      const d = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
      labelEl.textContent = `(${d})`;
    } else if (filterType === 'bulan') {
      const m = document.getElementById('analytics-filter-month')?.value || getLocalISODate(new Date()).slice(0, 7);
      labelEl.textContent = `(${m})`;
    } else if (filterType === 'tahun') {
      const y = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
      labelEl.textContent = `(${y})`;
    } else {
      labelEl.textContent = '(Semua Waktu)';
    }
  }
  
  let revenue = 0;
  let netProfit = 0;
  
  // Rincian Metode Pembayaran Hari Ini
  const methodsBreakdown = {
    'Tunai': 0,
    'QRIS': 0,
    'Debit': 0,
    'Transfer': 0
  };
  
  // Metode non-tunai: uang tidak langsung masuk laci (hanya laba bersih dihitung ke stat revenue)
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  
  todayTxs.forEach(tx => {
    const metode = tx.metode_pembayaran || 'Tunai';
    const isNonCash = nonCashMethods.includes(metode);
    
    // Hitung Laba Bersih sebelum diskon transaksi
    let txSubtotal = 0;
    let txNetProfitBeforeDiscount = 0;
    tx.items.forEach(item => {
      let buyPrice = Number(item.harga_beli) || 0;
      // Fallback jika item adalah bundle dan belum memiliki harga_beli tercatat
      if (item.isBundle && buyPrice === 0 && Array.isArray(item.bundleItems)) {
        item.bundleItems.forEach(b => {
          const cp = products.find(p => String(p.id) === String(b.productId));
          if (cp) buyPrice += (Number(cp.harga_beli) || 0) * (Number(b.qty) || 1);
        });
      }
      const sellPrice = item.harga || 0;
      txNetProfitBeforeDiscount += (sellPrice - buyPrice) * item.qty;
      txSubtotal += sellPrice * item.qty;
    });
    
    // Kurangi laba bersih dengan diskon transaksi
    const txDiscount = Math.max(0, txSubtotal - tx.total);
    const txNetProfit = txNetProfitBeforeDiscount - txDiscount;
    netProfit += txNetProfit;
    
    // Perhitungan Penghasilan Tunai / Penjualan Kas Masuk:
    // Jika Tunai atau non-tunai yang diganti uang cash: seluruh nominal transaksi dihitung penuh ke penjualan kas
    // Jika non-tunai tidak diganti uang cash: hanya laba bersihnya saja yang masuk ke penerimaan kas toko
    if (!isNonCash || tx.diganti_cash === true) {
      revenue += tx.total;
    } else {
      revenue += txNetProfit;
    }
    
    // Akumulasi metode pembayaran
    methodsBreakdown[metode] = (methodsBreakdown[metode] || 0) + tx.total;
  });
  
  // Hitung total piutang aktif secara kumulatif (semua transaksi belum lunas)
  let totalDebt = 0;
  const activeDebtorsMap = {}; // nama => { total: 0, earliestDue: null, overdue: false }
  const todayDateStr = getLocalISODate(now).slice(0, 10);

  transactions.forEach(tx => {
    const sisa = tx.sisa_piutang || 0;
    if (sisa > 0) {
      totalDebt += sisa;
      const cName = tx.nama_pelanggan || 'Pelanggan Umum';
      if (!activeDebtorsMap[cName]) {
        activeDebtorsMap[cName] = {
          name: cName,
          totalDebt: 0,
          dueDates: [],
          txCount: 0
        };
      }
      activeDebtorsMap[cName].totalDebt += sisa;
      activeDebtorsMap[cName].txCount++;
      if (tx.jatuh_tempo) {
        activeDebtorsMap[cName].dueDates.push(tx.jatuh_tempo);
      }
    }
  });

  // Render widget debitor di Dashboard Analisis
  const debtorsListEl = document.getElementById('analytics-debtors-list');
  const debtBadgeEl = document.getElementById('analytics-debt-count-badge');
  const debtorsArray = Object.values(activeDebtorsMap).sort((a, b) => b.totalDebt - a.totalDebt);

  if (debtBadgeEl) {
    debtBadgeEl.textContent = `${debtorsArray.length} Orang`;
  }

  if (debtorsListEl) {
    debtorsListEl.innerHTML = '';
    if (debtorsArray.length === 0) {
      debtorsListEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 1rem;">Tidak ada pelanggan yang memiliki hutang.</div>';
    } else {
      debtorsArray.forEach(d => {
        // Cari jatuh tempo terdekat
        d.dueDates.sort();
        const earliestDue = d.dueDates[0] || null;
        let dueBadge = '';
        if (earliestDue) {
          const isOverdue = earliestDue < todayDateStr;
          const isToday = earliestDue === todayDateStr;
          if (isOverdue) {
            dueBadge = `<span style="font-size: 0.72rem; color: #dc2626; background: #fef2f2; font-weight: 700; padding: 0.15rem 0.45rem; border-radius: 999px; border: 1px solid #fecaca;">Jatuh Tempo: ${earliestDue} (Lewat)</span>`;
          } else if (isToday) {
            dueBadge = `<span style="font-size: 0.72rem; color: #d97706; background: #fffbeb; font-weight: 700; padding: 0.15rem 0.45rem; border-radius: 999px; border: 1px solid #fde68a;">Jatuh Tempo: Hari Ini</span>`;
          } else {
            dueBadge = `<span style="font-size: 0.72rem; color: #475569; background: #f1f5f9; font-weight: 600; padding: 0.15rem 0.45rem; border-radius: 999px;">Jatuh Tempo: ${earliestDue}</span>`;
          }
        } else {
          dueBadge = `<span style="font-size: 0.72rem; color: #94a3b8;">Tanpa Tempo</span>`;
        }

        const div = document.createElement('div');
        div.className = 'widget-item';
        div.style.padding = '0.6rem 0.75rem';
        div.style.cursor = 'pointer';
        div.onclick = () => {
          switchTab('customers');
          switchCustomerSubView('debt');
        };
        div.innerHTML = `
          <div class="widget-item-left" style="gap: 0.6rem;">
            <div class="widget-icon-box" style="background: rgba(239, 68, 68, 0.1); color: #dc2626;">
              <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
            <div>
              <div style="font-weight: 700; font-size: 0.88rem; color: var(--text-main);">${d.name}</div>
              <div style="margin-top: 2px;">${dueBadge}</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 800; font-size: 0.9rem; color: #dc2626;">Rp ${formatRupiah(d.totalDebt)}</div>
            <div style="font-size: 0.72rem; color: var(--text-muted);">${d.txCount} Transaksi</div>
          </div>
        `;
        debtorsListEl.appendChild(div);
      });
    }
  }
  
  // Hitung Penerimaan Pembayaran Hutang pada periode ini
  let totalDebtRepaid = 0;
  const allTxsSource = (analyticsTransactions !== null && analyticsTransactions !== undefined) ? analyticsTransactions : transactions;
  allTxsSource.forEach(tx => {
    if (Array.isArray(tx.riwayat_pelunasan)) {
      tx.riwayat_pelunasan.forEach(p => {
        if (!p.waktu) return;
        const pDateStr = parseTxDateStr(p.waktu);
        let match = false;
        if (filterType === 'hari') {
          const d = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
          match = (pDateStr === d);
        } else if (filterType === 'bulan') {
          const m = document.getElementById('analytics-filter-month')?.value || getLocalISODate(new Date()).slice(0, 7);
          match = (pDateStr.slice(0, 7) === m);
        } else if (filterType === 'tahun') {
          const y = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
          match = (pDateStr.slice(0, 4) === y);
        } else {
          match = true;
        }
        if (match) {
          totalDebtRepaid += (Number(p.bayar) || 0);
        }
      });
    }
  });

  // Total Modal HPP = Total Omset - Laba Bersih (selalu >= 0)
  const totalPenjualan = Math.max(0, revenue - netProfit);
  
  // Update Metrik Hari Ini di UI
  document.getElementById('stat-revenue').textContent = `Rp ${formatRupiah(revenue)}`;
  document.getElementById('stat-gross-profit').textContent = `Rp ${formatRupiah(totalPenjualan)}`;
  document.getElementById('stat-net-profit').textContent = `Rp ${formatRupiah(netProfit)}`;
  
  const statDebtEl = document.getElementById('stat-debt');
  if (statDebtEl) {
    statDebtEl.textContent = `Rp ${formatRupiah(totalDebt)}`;
  }
  const statDebtPaidEl = document.getElementById('stat-debt-paid');
  if (statDebtPaidEl) {
    statDebtPaidEl.textContent = `Rp ${formatRupiah(totalDebtRepaid)}`;
  }
  
  // Render rincian metode pembayaran di panel kanan
  const breakdownContainer = document.getElementById('payment-method-breakdown');
  if (breakdownContainer) {
    breakdownContainer.innerHTML = '';
    
    // Config icon & warna per metode
    const methodConfigs = {
      'Tunai': { icon: `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>`, bg: 'bg-emerald-light', text: 'text-emerald' },
      'QRIS': { icon: `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`, bg: 'bg-blue-light', text: 'text-blue' },
      'Debit': { icon: `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`, bg: 'bg-purple-light', text: 'text-purple' },
      'Transfer': { icon: `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`, bg: 'bg-amber-light', text: 'text-amber' }
    };

    Object.keys(methodsBreakdown).forEach(m => {
      const amt = methodsBreakdown[m];
      const cfg = methodConfigs[m] || { icon: `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`, bg: 'bg-slate-light', text: 'text-slate' };
      const isNonZero = amt > 0;
      
      const div = document.createElement('div');
      div.className = `widget-item ${isNonZero ? 'active-border' : 'muted-bg'}`;
      div.innerHTML = `
        <div class="widget-item-left">
          <div class="widget-icon-box ${cfg.bg} ${cfg.text}">
            ${cfg.icon}
          </div>
          <span class="widget-item-title">${m}</span>
        </div>
        <span class="widget-item-amount ${isNonZero ? 'font-bold-main' : 'font-muted'}">
          Rp ${formatRupiah(amt)}
        </span>
      `;
      breakdownContainer.appendChild(div);
    });

    // Baris Khusus: Penerimaan Bayar Hutang di bawah Transfer
    const isDebtRepaidNonZero = totalDebtRepaid > 0;
    const debtRepaidDiv = document.createElement('div');
    debtRepaidDiv.className = `widget-item ${isDebtRepaidNonZero ? 'active-border' : 'muted-bg'}`;
    debtRepaidDiv.style.borderTop = '1.5px dashed var(--border-color)';
    debtRepaidDiv.style.marginTop = '4px';
    debtRepaidDiv.style.paddingTop = '8px';
    debtRepaidDiv.innerHTML = `
      <div class="widget-item-left">
        <div class="widget-icon-box" style="background: rgba(37, 99, 235, 0.12); color: #2563eb;">
          <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div>
          <span class="widget-item-title" style="font-weight: 700; color: #1e40af;">Bayar Hutang</span>
          <div style="font-size: 0.72rem; color: var(--text-muted);">Penerimaan cicilan/lunas</div>
        </div>
      </div>
      <span class="widget-item-amount ${isDebtRepaidNonZero ? 'font-bold-main' : 'font-muted'}" style="${isDebtRepaidNonZero ? 'color: #2563eb; font-weight: 800;' : ''}">
        Rp ${formatRupiah(totalDebtRepaid)}
      </span>
    `;
    breakdownContainer.appendChild(debtRepaidDiv);
  }
  
  // 1. Hitung Stok pada tanggal/periode yang difilter
  let targetDateForStock = null;
  if (filterType === 'hari') {
    targetDateForStock = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
  }
  const productsWithHistoricalStock = getHistoricalProductStock(targetDateForStock);
  const stockAlerts = productsWithHistoricalStock.filter(p => p.stok <= 2);
  const stockListEl = document.getElementById('stock-alerts-list');
  const countBadgeEl = document.getElementById('stock-alert-count-badge');
  if (countBadgeEl) {
    countBadgeEl.textContent = `${stockAlerts.length} Item`;
  }
  
  if (stockListEl) {
    stockListEl.innerHTML = '';
    
    if (stockAlerts.length === 0) {
      stockListEl.innerHTML = '<div class="widget-empty">Stok aman terkendali.</div>';
    } else {
      stockAlerts.forEach(p => {
        const isHabis = p.stok <= 0;
        const itemEl = document.createElement('div');
        itemEl.className = 'widget-item stock-item';
        
        const iconOrImg = p.gambar 
          ? `<img src="${p.gambar}" alt="${p.nama}" class="stock-item-img" onclick="event.stopPropagation(); openProductImageLightbox('${p.gambar}', '${escapeJsQuotes(p.nama)}')" onerror="this.onerror=null; this.outerHTML='<div class=\\'widget-icon-box bg-white-border\\'><svg viewBox=\\'0 0 24 24\\' class=\\'w-4 h-4 text-muted\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><path d=\\'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\\'/><polyline points=\\'3.27 6.96 12 12.01 20.73 6.96\\'/><line x1=\\'12\\' y1=\\'22.08\\' x2=\\'12\\' y2=\\'12\\'/></svg></div>';">`
          : `<div class="widget-icon-box bg-white-border"><svg viewBox="0 0 24 24" class="w-4 h-4 text-muted" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>`;

        itemEl.innerHTML = `
          <div class="widget-item-left">
            ${iconOrImg}
            <div>
              <h4 class="stock-item-title">${p.nama} <span class="stock-qty-sub">(${p.stok})</span></h4>
              <p class="stock-category-sub">KATEGORI: ${p.kategori || 'UMUM'}</p>
            </div>
          </div>
          <span class="stock-status-badge ${isHabis ? 'badge-rose' : 'badge-amber'}">
            ${isHabis ? 'Habis' : 'Menipis'}
          </span>
        `;
        stockListEl.appendChild(itemEl);
      });
    }
  }
  
  // 2. Hitung Produk Kadaluarsa dalam 30 hari
  const expAlertsList = document.getElementById('expiry-alerts-list');
  if (expAlertsList) {
    expAlertsList.innerHTML = '';
  }
  const upcomingExpiry = [];
  
  products.forEach(p => {
    if (p.tanggal_kadaluarsa) {
      const expDate = new Date(p.tanggal_kadaluarsa);
      const diffTime = expDate - now;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      // Jika kadaluarsa kurang dari 30 hari (bisa bernilai negatif jika sudah lewat)
      if (diffDays <= 30) {
        upcomingExpiry.push({ product: p, daysLeft: diffDays });
      }
    }
  });
  
  if (upcomingExpiry.length === 0) {
    expAlertsList.innerHTML = '<li class="empty-alert">Tidak ada produk mendekati kadaluarsa.</li>';
  } else {
    // Urutkan dari yang paling mendesak
    upcomingExpiry.sort((a, b) => a.daysLeft - b.daysLeft);
    upcomingExpiry.forEach(item => {
      const p = item.product;
      const li = document.createElement('li');
      li.className = 'alert-item';
      
      let expText = '';
      if (item.daysLeft < 0) {
        expText = `KADALUARSA (${Math.abs(item.daysLeft)} hari lalu)`;
      } else if (item.daysLeft === 0) {
        expText = 'HARI INI KADALUARSA!';
      } else {
        expText = `${item.daysLeft} hari lagi`;
      }
      
      li.innerHTML = `
        <div class="alert-item-left">
          <span class="alert-item-name">${p.nama}</span>
          <span class="alert-item-meta">Tgl Exp: ${p.tanggal_kadaluarsa}</span>
        </div>
        <span class="alert-item-badge ${item.daysLeft <= 7 ? '' : 'warning'}">${expText}</span>
      `;
      expAlertsList.appendChild(li);
    });
  }
  
  // 3. Produk Terlaris
  const sellCounts = {};
  const sellRevenue = {};
  
  todayTxs.forEach(tx => {
    tx.items.forEach(item => {
      sellCounts[item.nama] = (sellCounts[item.nama] || 0) + item.qty;
      sellRevenue[item.nama] = (sellRevenue[item.nama] || 0) + (item.harga * item.qty);
    });
  });
  
  const bestSellersBody = document.getElementById('best-sellers-body');
  bestSellersBody.innerHTML = '';
  
  const sortedSellers = Object.keys(sellCounts).sort((a, b) => sellCounts[b] - sellCounts[a]);
  
  if (sortedSellers.length === 0) {
    bestSellersBody.innerHTML = '<tr><td colspan="4" class="best-seller-empty">Belum ada penjualan pada periode ini.</td></tr>';
  } else {
    sortedSellers.forEach((nama, idx) => {
      // Cari data produk asli berdasarkan nama
      const p = products.find(prod => prod.nama === nama);
      const category = p && p.kategori ? p.kategori : 'UMUM';
      
      const boxSvg = `<div class="best-seller-box-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>`;
      
      // Jika produk ada gambar, tampilkan HANYA elemen <img> (tidak ada div dus). Jika tidak ada gambar, tampilkan div dus.
      const imgThumbnail = (p && p.gambar && p.gambar.trim() !== '')
        ? `<img src="${p.gambar}" alt="${nama}" class="best-seller-img" onclick="event.stopPropagation(); openProductImageLightbox('${p.gambar}', '${escapeJsQuotes(nama)}')" onerror="this.outerHTML=\`<div class='best-seller-box-icon'><svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='2'><path d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/><polyline points='3.27 6.96 12 12.01 20.73 6.96'/><line x1='12' y1='22.08' x2='12' y2='12'/></svg></div>\`;">`
        : boxSvg;
        
      // Badge Ranking (#1 Gold, #2 Silver, #3 Bronze, dst)
      let rankClass = 'rank-default';
      if (idx === 0) rankClass = 'rank-gold';
      else if (idx === 1) rankClass = 'rank-silver';
      else if (idx === 2) rankClass = 'rank-bronze';

      const tr = document.createElement('tr');
      tr.className = 'best-seller-row';
      tr.innerHTML = `
        <td class="td-rank"><span class="rank-badge ${rankClass}">#${idx + 1}</span></td>
        <td class="td-product">
          <div class="best-seller-prod-info">
            ${imgThumbnail}
            <div>
              <div class="best-seller-prod-name">${nama}</div>
              <div class="best-seller-prod-cat">${category}</div>
            </div>
          </div>
        </td>
        <td class="td-qty"><span class="qty-pill">${sellCounts[nama]} terjual</span></td>
        <td class="td-revenue"><strong>Rp ${formatRupiah(sellRevenue[nama])}</strong></td>
      `;
      bestSellersBody.appendChild(tr);
    });
  }
  
  // 4. Gambar Grafik Omzet 7 Hari Terakhir
  render7DayChart();
}

function render7DayChart() {
  const chartContainer = document.getElementById('analytics-bar-chart');
  chartContainer.innerHTML = '';
  
  const days = [];
  const now = new Date();
  
  // Generate list tanggal 7 hari terakhir
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push({
      dateStr: getLocalISODate(d).slice(0, 10),
      label: d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' })
    });
  }
  
  // Hitung total omzet per hari menggunakan seluruh data transaksi yang tersedia
  const txSource = getAllAvailableTransactions();

  const dailyTotals = days.map(day => {
    let total = 0;
    txSource.forEach(tx => {
      if (tx.waktu && parseTxDateStr(tx.waktu) === day.dateStr) {
        total += (parseFloat(tx.total) || 0);
      }
    });
    return { label: day.label, amount: total };
  });
  
  const maxAmount = Math.max(...dailyTotals.map(d => d.amount), 100000);
  
  // Deteksi mode mobile (<= 768px) atau desktop
  const isMobile = window.innerWidth <= 768;

  // Ukuran viewBox SVG: Desktop kembali seperti semula (lebar 800 x tinggi 220), Mobile dibuat tinggi, gagah & besar (lebar 500 x tinggi 275)
  const width = isMobile ? 500 : 800;
  const height = isMobile ? 275 : 220;
  const paddingX = isMobile ? 28 : 40;
  const paddingYTop = isMobile ? 50 : 38;
  const paddingYBottom = isMobile ? 42 : 42;
  const chartWidth = width - (paddingX * 2);
  const chartHeight = height - paddingYTop - paddingYBottom;
  
  // Hitung titik koordinat (x, y) untuk 7 hari
  const points = dailyTotals.map((day, idx) => {
    const x = paddingX + (idx * (chartWidth / (dailyTotals.length - 1)));
    const ratio = day.amount / maxAmount;
    const y = height - paddingYBottom - (ratio * chartHeight);
    return { x, y, day };
  });
  
  // Helper fungsi untuk menghasilkan Catmull-Rom / Bezier smooth curve SVG path
  function getSmoothPath(pts) {
    if (pts.length === 0) return '';
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? i : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
      
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      
      d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  const linePathD = getSmoothPath(points);
  const areaPathD = `${linePathD} L ${points[points.length - 1].x},${height - paddingYBottom} L ${points[0].x},${height - paddingYBottom} Z`;

  let svgHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="smooth-line-chart" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; display: block; overflow: visible;">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-primary, #3b82f6)" stop-opacity="${isMobile ? '0.36' : '0.35'}" />
          <stop offset="100%" stop-color="var(--color-primary, #3b82f6)" stop-opacity="0.0" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="${isMobile ? '3.5' : '4'}" flood-color="var(--color-primary, #3b82f6)" flood-opacity="${isMobile ? '0.4' : '0.3'}"/>
        </filter>
      </defs>
      
      <!-- Horizontal Grid Lines -->
      <line x1="${paddingX - (isMobile ? 12 : 0)}" y1="${paddingYTop}" x2="${width - paddingX + (isMobile ? 12 : 0)}" y2="${paddingYTop}" stroke="var(--border-color, #e5e7eb)" stroke-dasharray="${isMobile ? '3 3' : '4 4'}" stroke-opacity="${isMobile ? '0.65' : '0.5'}"/>
      <line x1="${paddingX - (isMobile ? 12 : 0)}" y1="${paddingYTop + chartHeight / 2}" x2="${width - paddingX + (isMobile ? 12 : 0)}" y2="${paddingYTop + chartHeight / 2}" stroke="var(--border-color, #e5e7eb)" stroke-dasharray="${isMobile ? '3 3' : '4 4'}" stroke-opacity="${isMobile ? '0.65' : '0.5'}"/>
      <line x1="${paddingX - (isMobile ? 12 : 0)}" y1="${height - paddingYBottom}" x2="${width - paddingX + (isMobile ? 12 : 0)}" y2="${height - paddingYBottom}" stroke="var(--border-color, #cbd5e1)" stroke-width="${isMobile ? '1.5' : '1'}" stroke-opacity="${isMobile ? '0.9' : '0.8'}"/>

      <!-- Area Fill Under Curve -->
      <path d="${areaPathD}" fill="url(#chartGradient)" />

      <!-- Smoothed Line -->
      <path d="${linePathD}" fill="none" stroke="var(--color-primary, #3b82f6)" stroke-width="${isMobile ? '4.5' : '3.5'}" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" />

      <!-- Data Points, Nominal Labels & Date Labels -->
  `;

  points.forEach((pt) => {
    const formattedNominal = pt.day.amount > 0 ? `Rp ${formatRupiah(pt.day.amount)}` : 'Rp 0';
    let shortText = '0';
    if (pt.day.amount > 0) {
      if (pt.day.amount >= 1000000) {
        const valM = pt.day.amount / 1000000;
        shortText = valM >= 10 ? `${Math.round(valM)}Jt` : `${valM.toFixed(1).replace('.0', '')}Jt`;
      } else {
        shortText = `${Math.round(pt.day.amount / 1000)}Rb`;
      }
    }
    
    if (isMobile) {
      // Mobile: font besar & tebal (16.5px & 15px), stroke outline putih tebal agar terbaca sangat jelas
      svgHTML += `
        <g class="chart-point-group">
          <line x1="${pt.x}" y1="${paddingYTop}" x2="${pt.x}" y2="${height - paddingYBottom}" stroke="var(--color-primary, #3b82f6)" stroke-width="1.2" stroke-dasharray="2 2" opacity="0.25"/>
          <circle cx="${pt.x}" cy="${pt.y}" r="6.5" fill="#ffffff" stroke="var(--color-primary, #3b82f6)" stroke-width="4" />
          <text x="${pt.x}" y="${Math.max(paddingYTop - 8, pt.y - 13)}" text-anchor="middle" font-size="16.5" font-weight="800" fill="var(--text-main, #0f172a)" class="chart-nominal-text" style="paint-order: stroke; stroke: #ffffff; stroke-width: 4px; stroke-linejoin: round;">
            ${shortText}
          </text>
          <title>${pt.day.label}: ${formattedNominal}</title>
          <text x="${pt.x}" y="${height - 12}" text-anchor="middle" font-size="15" font-weight="800" fill="var(--text-muted, #334155)">
            ${pt.day.label}
          </text>
        </g>
      `;
    } else {
      // Desktop: tampilan semula yang proporsional, rapi, dan luas
      svgHTML += `
        <g class="chart-point-group">
          <line x1="${pt.x}" y1="${paddingYTop}" x2="${pt.x}" y2="${height - paddingYBottom}" stroke="var(--color-primary, #3b82f6)" stroke-width="1" stroke-dasharray="3 3" opacity="0.25"/>
          <circle cx="${pt.x}" cy="${pt.y}" r="4" fill="var(--bg-surface, #fff)" stroke="var(--color-primary, #3b82f6)" stroke-width="2.5" />
          <text x="${pt.x}" y="${Math.max(paddingYTop - 4, pt.y - 12)}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text-main, #1f2937)" class="chart-nominal-text">
            ${shortText}
          </text>
          <title>${pt.day.label}: ${formattedNominal}</title>
          <text x="${pt.x}" y="${height - 10}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text-muted, #6b7280)">
            ${pt.day.label}
          </text>
        </g>
      `;
    }
  });

  svgHTML += `</svg>`;
  chartContainer.innerHTML = svgHTML;
}

// ========================================================
// FITUR MODAL FULL SCREEN: DAFTAR BELANJA / KULAKAN (BARANG HABIS & MENIPIS)
// ========================================================

function openShoppingListModal() {
  const modal = document.getElementById('shopping-list-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.classList.add('active');
  const searchInput = document.getElementById('shopping-search-input');
  if (searchInput) searchInput.value = '';
  renderShoppingListTable();
}

function closeShoppingListModal() {
  const modal = document.getElementById('shopping-list-modal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.classList.remove('active');
}

function renderShoppingListTable() {
  const tbody = document.getElementById('shopping-list-tbody');
  if (!tbody) return;
  
  const searchVal = (document.getElementById('shopping-search-input')?.value || '').toLowerCase().trim();
  
  // Ambil semua barang dengan stok <= 2 (0 = habis, 1-2 = menipis)
  const lowStockProducts = products.filter(p => p.stok <= 2);
  
  const outCount = lowStockProducts.filter(p => p.stok === 0).length;
  const lowCount = lowStockProducts.filter(p => p.stok > 0).length;
  
  const totalItemsEl = document.getElementById('shopping-total-items');
  const outCountEl = document.getElementById('shopping-out-count');
  const lowCountEl = document.getElementById('shopping-low-count');
  
  if (totalItemsEl) totalItemsEl.textContent = `${lowStockProducts.length} item`;
  if (outCountEl) outCountEl.textContent = `${outCount} habis total`;
  if (lowCountEl) lowCountEl.textContent = `${lowCount} menipis`;
  
  const filtered = lowStockProducts.filter(p =>
    String(p.nama).toLowerCase().includes(searchVal) ||
    String(p.id).toLowerCase().includes(searchVal) ||
    (p.kategori && String(p.kategori).toLowerCase().includes(searchVal)) ||
    (p.barcode && String(p.barcode).toLowerCase().includes(searchVal))
  );
  
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 2rem; color: var(--text-muted);">Tidak ada barang yang perlu dibeli. Semua stok aman! 🎉</td></tr>`;
    return;
  }
  
  // Urutkan: yang habis (0) paling atas
  filtered.sort((a, b) => a.stok - b.stok);
  
  filtered.forEach((p, idx) => {
    const isHabis = p.stok === 0;
    const tr = document.createElement('tr');
    tr.id = `shopping-row-${p.id}`;
    tr.style.borderBottom = '1px solid var(--border-color)';
    tr.innerHTML = `
      <td style="text-align: center; padding: 0.65rem 0.5rem;">
        <input type="checkbox" style="width: 1.15rem; height: 1.15rem; cursor: pointer; accent-color: var(--color-success);" onchange="toggleShoppingItemDone(this)">
      </td>
      <td style="font-weight: 600; padding: 0.65rem 0.75rem;">
        <div class="shopping-item-title">${p.nama}</div>
        <span style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace;">ID: ${p.id}</span>
      </td>
      <td style="padding: 0.65rem 0.75rem;">
        <span class="cat-btn" style="cursor:default; margin:0; font-size:0.75rem;">${p.kategori || 'Umum'}</span>
      </td>
      <td style="text-align: center; padding: 0.65rem 0.75rem;">
        <span style="display: inline-block; padding: 0.2rem 0.6rem; border-radius: 50px; font-weight: 700; font-size: 0.8rem; background: ${isHabis ? 'rgba(244,63,94,0.12)' : 'rgba(245,158,11,0.12)'}; color: ${isHabis ? 'var(--color-danger)' : '#b45309'};">
          ${isHabis ? '0 (Habis)' : `${p.stok} pcs`}
        </span>
      </td>
      <td style="padding: 0.65rem 0.75rem; font-weight: 600; color: var(--text-main); font-size: 0.85rem;">
        Rp ${formatRupiah(p.harga_beli || 0)}
      </td>
      <td style="padding: 0.65rem 0.75rem; font-size: 0.82rem; font-family: monospace; color: var(--text-muted);">
        ${p.barcode || '-'}
      </td>
      <td style="padding: 0.65rem 0.75rem; text-align: center;">
        <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
          <input type="number" id="correct-qty-${p.id}" min="0" placeholder="Qty" value="${p.stok}"
            style="width: 58px; padding: 0.3rem 0.4rem; border: 1px solid var(--border-color); border-radius: 6px; font-family: var(--font-main); font-size: 0.85rem; text-align: center; background: var(--bg-card); color: var(--text-main); outline: none;"
            title="Ketik jumlah fisik di rak jika barang sebenarnya masih ada"
            onfocus="this.select()"
            onkeydown="if(event.key==='Enter') quickCorrectStock('${p.id}')">
          <button class="btn btn-primary btn-sm" onclick="quickCorrectStock('${p.id}')" title="Simpan Koreksi Stok" style="padding: 0.3rem 0.55rem; font-size: 0.8rem;">
            Simpan
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Koreksi Cepat Stok Barang Langsung dari Modal Belanja
function quickCorrectStock(productId) {
  const inputEl = document.getElementById(`correct-qty-${productId}`);
  if (!inputEl) return;
  
  const newQty = parseInt(inputEl.value);
  if (isNaN(newQty) || newQty < 0) {
    alert('Jumlah stok tidak valid.');
    return;
  }
  
  const p = products.find(prod => prod.id === productId);
  if (!p) return;
  
  const oldStock = p.stok;
  p.stok = newQty;
  saveProductsLocally();
  
  // Sinkronkan ke cloud RTDB
  if (firebaseDb) {
    saveProductCloud(p);
  }
  
  // Refresh tabel analytics dan shopping list
  updateAnalytics();
  renderShoppingListTable();
  
  if (newQty > 2) {
    alert(`✅ Berhasil mengoreksi stok "${p.nama}" dari ${oldStock} pcs menjadi ${newQty} pcs. Produk telah dihapus dari daftar barang habis.`);
  } else {
    alert(`✅ Stok "${p.nama}" diperbarui menjadi ${newQty} pcs.`);
  }
}

function toggleShoppingItemDone(checkbox) {
  const row = checkbox.closest('tr');
  if (row) {
    if (checkbox.checked) {
      row.style.opacity = '0.4';
      row.style.textDecoration = 'line-through';
    } else {
      row.style.opacity = '1';
      row.style.textDecoration = 'none';
    }
  }
}

// Buka Langsung WhatsApp dengan Pesan Terisi (Direct Open)
function copyShoppingListToWhatsApp() {
  const lowStockProducts = products.filter(p => p.stok <= 2);
  if (lowStockProducts.length === 0) {
    alert('Tidak ada produk yang habis/menipis.');
    return;
  }
  
  // Kelompokkan produk berdasarkan kategori
  const groupedByCategory = {};
  lowStockProducts.forEach(p => {
    const cat = (p.kategori && p.kategori.trim()) ? p.kategori.trim() : 'Lainnya';
    if (!groupedByCategory[cat]) {
      groupedByCategory[cat] = [];
    }
    groupedByCategory[cat].push(p);
  });

  const categoryNames = Object.keys(groupedByCategory);
  let text = '';
  categoryNames.forEach((cat, index) => {
    text += `${cat}\n`;
    groupedByCategory[cat].forEach(p => {
      text += `- ${p.nama} (${p.stok})\n`;
    });
    if (index < categoryNames.length - 1) {
      text += `\n`;
    }
  });
  
  const encodedText = encodeURIComponent(text.trim());
  const waUrl = `https://api.whatsapp.com/send?text=${encodedText}`;
  
  // Buka WhatsApp langsung di tab baru / aplikasi WhatsApp
  window.open(waUrl, '_blank');
}

// Export Daftar Belanja ke CSV / Excel
function exportShoppingListCSV() {
  const lowStockProducts = products.filter(p => p.stok <= 2);
  if (lowStockProducts.length === 0) {
    alert('Tidak ada produk yang habis/menipis.');
    return;
  }
  
  lowStockProducts.sort((a, b) => a.stok - b.stok);
  
  let csvContent = 'data:text/csv;charset=utf-8,';
  csvContent += 'No,ID Produk,Nama Barang,Kategori,Sisa Stok,Status,Harga Beli (Modal),Harga Jual,Barcode\r\n';
  
  lowStockProducts.forEach((p, idx) => {
    const status = p.stok === 0 ? 'Habis Total' : 'Stok Menipis';
    const row = [
      idx + 1,
      `"${p.id}"`,
      `"${(p.nama || '').replace(/"/g, '""')}"`,
      `"${(p.kategori || 'Umum').replace(/"/g, '""')}"`,
      p.stok,
      `"${status}"`,
      p.harga_beli || 0,
      p.harga_jual || 0,
      `"${p.barcode || ''}"`
    ];
    csvContent += row.join(',') + '\r\n';
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  const dateStr = getLocalISODate();
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `Daftar_Belanja_Kulakan_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Cetak Checklist Belanja (Ukuran Font Ringkas & Hemat Kertas 58mm / A4)
function printShoppingList() {
  const lowStockProducts = products.filter(p => p.stok <= 2);
  if (lowStockProducts.length === 0) {
    alert('Tidak ada barang yang habis/menipis.');
    return;
  }
  
  lowStockProducts.sort((a, b) => a.stok - b.stok);
  
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : 'TOKO';
  const nowStr = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
  
  let printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Daftar Belanja - ${storeName}</title>
        <style>
          @page {
            margin: 4mm;
            size: auto;
          }
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body {
            font-family: 'Courier New', Courier, monospace, sans-serif;
            font-size: 10px;
            color: #000;
            background: #fff;
            max-width: 58mm;
            margin: 0 auto;
            padding: 2mm;
            line-height: 1.25;
          }
          .title {
            font-size: 11.5px;
            font-weight: 900;
            text-align: center;
            text-transform: uppercase;
            margin-bottom: 2px;
          }
          .sub {
            font-size: 9.5px;
            text-align: center;
            margin-bottom: 5px;
          }
          .divider {
            border-bottom: 1px dashed #000;
            margin: 4px 0;
          }
          .item-row {
            display: flex;
            align-items: flex-start;
            gap: 4px;
            margin-bottom: 5px;
            page-break-inside: avoid;
          }
          .item-chk {
            font-size: 10px;
            font-weight: bold;
            flex-shrink: 0;
          }
          .item-info {
            flex: 1;
          }
          .item-name {
            font-size: 10.5px;
            font-weight: bold;
            word-break: break-word;
          }
          .item-meta {
            font-size: 9px;
            color: #333;
            display: flex;
            justify-content: space-between;
          }
          .footer {
            font-size: 9.5px;
            font-weight: bold;
            text-align: center;
            margin-top: 6px;
          }
          @media screen and (min-width: 600px) {
            body {
              max-width: 100%;
              padding: 10px 20px;
              font-size: 11px;
            }
            .item-row {
              margin-bottom: 6px;
            }
            .item-name {
              font-size: 11.5px;
            }
          }
        </style>
      </head>
      <body>
        <div class="title">DAFTAR BELANJA</div>
        <div class="sub">${storeName}<br>${nowStr}</div>
        <div class="divider"></div>
  `;
  
  lowStockProducts.forEach((p, i) => {
    const sisa = p.stok === 0 ? 'HABIS (0)' : `Sisa ${p.stok}`;
    printHtml += `
      <div class="item-row">
        <div class="item-chk">[ ]</div>
        <div class="item-info">
          <div class="item-name">${i + 1}. ${p.nama}</div>
          <div class="item-meta">
            <span>${sisa}</span>
            <span>Modal: ${formatRupiah(p.harga_beli || 0)}</span>
          </div>
        </div>
      </div>
    `;
  });
  
  printHtml += `
        <div class="divider"></div>
        <div class="footer">TOTAL: ${lowStockProducts.length} ITEM PERLU DIBELI</div>
      </body>
    </html>
  `;
  
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(printHtml);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 300);
  }
}

// --- KAMERA SCANNER BARCODE (html5-qrcode) ---

// Memainkan bunyi bip scanner (Web Audio API Synthesizer - 100% Offline)
function playBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 1200; // Frekuensi bip tinggi khas POS
    gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
    
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioCtx.close();
    }, 100);
  } catch (err) {
    console.error("Gagal memainkan suara bip:", err);
  }
}

let scannerMode = 'pos'; // pos, kulak, produk

function openCameraScanner(mode = 'pos') {
  scannerMode = mode;
  if (typeof Html5Qrcode === 'undefined') {
    alert("Maaf, modul kamera scanner gagal dimuat. Pastikan perangkat Anda terhubung ke internet saat membuka aplikasi agar modul dapat diunduh otomatis.");
    return;
  }
  
  const wrapper = document.getElementById('camera-scanner-wrapper');
  wrapper.classList.add('active');
  
  html5QrcodeScanner = new Html5Qrcode("interactive-reader", {
    useBarCodeDetectorIfSupported: true
  });
  
  html5QrcodeScanner.start(
    { facingMode: "environment" },
    {
      fps: 15,
      qrbox: { width: 250, height: 120 }
    },
    onScanSuccess,
    onScanFailure
  ).catch(err => {
    console.error("Gagal menyalakan kamera:", err);
    alert("Gagal mengakses kamera! Berikan izin kamera untuk situs ini di pengaturan browser Anda.");
    closeCameraScanner();
  });
}

function onScanSuccess(decodedText, decodedResult) {
  playBeep();
  
  const searchVal = decodedText.trim();
  
  if (scannerMode === 'kulak') {
    const input = document.getElementById('kulak-search-input');
    if (input) {
      input.value = searchVal;
      filterKulakSearch();
    }
    closeCameraScanner();
    return;
  }
  
  // Cek Bundle terlebih dahulu di scanner
  if (scannerMode === 'pos') {
    const matchedBundle = bundles.find(b => b.barcode && String(b.barcode).toLowerCase() === searchVal.toLowerCase());
    if (matchedBundle) {
      addBundleToCart(matchedBundle);
      closeCameraScanner();
      return;
    }
  }

  let exactMatch = null;
  let isBoxScan = false;
  let matchedUnit = null;
  
  products.forEach(p => {
    if (p.barcode && String(p.barcode).toLowerCase() === searchVal.toLowerCase()) {
      exactMatch = p;
      isBoxScan = false;
    } else if (Array.isArray(p.units) && p.units.some(u => u.barcode && String(u.barcode).toLowerCase() === searchVal.toLowerCase())) {
      exactMatch = p;
      isBoxScan = true;
      matchedUnit = p.units.find(u => u.barcode && String(u.barcode).toLowerCase() === searchVal.toLowerCase());
    } else if (p.has_unit_box && p.barcode_box && String(p.barcode_box).toLowerCase() === searchVal.toLowerCase()) {
      exactMatch = p;
      isBoxScan = true;
    } else if (String(p.id).toLowerCase() === searchVal.toLowerCase() && !exactMatch) {
      exactMatch = p;
      isBoxScan = false;
    }
  });

  if (scannerMode === 'produk') {
    const input = document.getElementById('product-list-search');
    if (exactMatch) {
      if (input) input.value = ''; // Hilangkan teks setelah produk ditemukan
      renderProductsTable(exactMatch.id);
    } else {
      if (input) input.value = searchVal;
      filterProductListTable();
      alert(`Barcode "${searchVal}" tidak terdaftar di inventaris!`);
    }
    closeCameraScanner();
    return;
  }
  
  if (exactMatch) {
    const requiredPcs = isBoxScan ? (matchedUnit ? matchedUnit.ratio : (exactMatch.isi_box || 1)) : 1;
    if (exactMatch.stok >= requiredPcs || appConfig.allowZeroStock) {
      if (isBoxScan) {
        addBoxToCart(exactMatch, matchedUnit);
      } else {
        addToCart(exactMatch);
      }
      closeCameraScanner();
    } else {
      alert(`Barang "${exactMatch.nama}" ditemukan, namun stoknya kurang! Tersisa ${exactMatch.stok} pcs.`);
      closeCameraScanner();
    }
  } else {
    alert(`Barcode "${searchVal}" tidak terdaftar di inventaris!`);
    closeCameraScanner();
  }
}

function onScanFailure(error) {
  // Hanya abaikan scan kegagalan kecil (proses frame berjalan)
}

function closeCameraScanner() {
  const wrapper = document.getElementById('camera-scanner-wrapper');
  wrapper.classList.remove('active');
  
  if (html5QrcodeScanner) {
    html5QrcodeScanner.stop().then(() => {
      html5QrcodeScanner = null;
      focusActiveTabSearch();
    }).catch(err => {
      console.error("Gagal menghentikan scanner kamera:", err);
      html5QrcodeScanner = null;
      focusActiveTabSearch();
    });
  } else {
    focusActiveTabSearch();
  }
}

// --- LOGIKA TAMPILAN POS MENU GRID (CAFE / RESTO DARI PENGATURAN) ---
let posGridCategory = 'All';

function applyPosGridConfig() {
  const isGridEnabled = appConfig.posGridMode === true;
  const catalogContainer = document.getElementById('pos-catalog-container');
  const cartCard = document.querySelector('.cart-card-left');

  if (isGridEnabled) {
    if (catalogContainer) catalogContainer.style.display = 'block';
    renderPosCategoryChips();
    renderPosCatalogGrid();
  } else {
    if (catalogContainer) catalogContainer.style.display = 'none';
    if (cartCard) cartCard.style.display = 'block';
  }
}

function renderPosCategoryChips() {
  const container = document.getElementById('pos-grid-category-chips');
  if (!container) return;
  container.innerHTML = '';

  const catsFromProducts = products.map(p => p.kategori || 'Umum').filter(Boolean);
  const allCats = ['All', ...Array.from(new Set(catsFromProducts))];
  if (Array.isArray(bundles) && bundles.length > 0) {
    allCats.push('🎁 Paket Bundling');
  }

  allCats.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `pos-cat-chip ${posGridCategory === cat ? 'active' : ''}`;
    chip.textContent = cat === 'All' ? 'Semua' : cat;
    chip.onclick = () => {
      posGridCategory = cat;
      renderPosCategoryChips();
      renderPosCatalogGrid();
    };
    container.appendChild(chip);
  });
}

function renderPosCatalogGrid() {
  const container = document.getElementById('pos-product-grid');
  if (!container) return;
  container.innerHTML = '';

  const searchInput = document.getElementById('search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';

  // Jika tab kategori Paket Bundling dipilih
  if (posGridCategory === '🎁 Paket Bundling') {
    let bList = Array.isArray(bundles) ? [...bundles] : [];
    if (searchVal) {
      bList = bList.filter(b =>
        String(b.nama).toLowerCase().includes(searchVal) ||
        (b.barcode && String(b.barcode).toLowerCase().includes(searchVal))
      );
    }

    if (bList.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 2rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: 14px; border: 1px dashed var(--border-color);">
          <p style="font-weight: 600; font-size: 0.9rem; margin: 0;">Belum ada paket bundling yang cocok.</p>
        </div>
      `;
      return;
    }

    bList.forEach(b => {
      const cartItem = cart.find(it => it.cartId === `bundle_${b.id}`);
      const cartQty = cartItem ? cartItem.qty : 0;
      const inCartClass = cartQty > 0 ? 'in-cart' : '';
      const cartBadgeHtml = cartQty > 0 ? `<span class="pos-grid-qty-badge">🛒 ${cartQty}</span>` : '';

      // Hitung stok komponen
      let maxAvailable = 9999;
      (b.items || []).forEach(it => {
        const prod = products.find(p => String(p.id) === String(it.productId));
        const stock = prod ? (prod.stok || 0) : 0;
        const sets = Math.floor(stock / (Number(it.qty) || 1));
        if (sets < maxAvailable) maxAvailable = sets;
      });
      const isOut = maxAvailable <= 0;

      const card = document.createElement('div');
      card.className = `pos-grid-card ${isOut && !appConfig.allowZeroStock ? 'out-of-stock' : ''} ${inCartClass}`;
      card.onclick = () => {
        addBundleToCart(b);
      };

      const compSummary = (b.items || []).map(it => `${it.productName} (${it.qty}x)`).join(' + ');

      card.innerHTML = `
        <div class="pos-grid-img-wrap" style="background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%); display:flex; align-items:center; justify-content:center; min-height:110px; font-size:2.5rem;">
          🎁
          ${cartBadgeHtml}
          <span class="pos-grid-stock-badge ${isOut ? 'empty' : ''}">${isOut ? 'Stok Habis' : `Bisa ${maxAvailable} Pkt`}</span>
        </div>
        <div class="pos-grid-body">
          <div class="pos-grid-name" title="${b.nama}">[PAKET] ${b.nama}</div>
          <div style="font-size:0.7rem; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;">${compSummary}</div>
          <div class="pos-grid-footer">
            <span class="pos-grid-price">Rp ${formatRupiah(b.harga)}</span>
            <button type="button" class="pos-grid-add-btn" title="Tambah Paket" tabindex="-1">+</button>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
    return;
  }

  let list = products;
  if (posGridCategory !== 'All') {
    list = list.filter(p => (p.kategori || 'Umum') === posGridCategory);
  }
  if (searchVal) {
    list = list.filter(p => 
      String(p.nama).toLowerCase().includes(searchVal) ||
      String(p.id).toLowerCase().includes(searchVal) ||
      (p.barcode && String(p.barcode).toLowerCase().includes(searchVal))
    );
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 2rem 1rem; color: var(--text-muted); background: var(--bg-surface); border-radius: 14px; border: 1px dashed var(--border-color);">
        <svg viewBox="0 0 24 24" class="icon-empty" style="width: 2.5rem; height: 2.5rem; margin-bottom: 0.5rem;"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>
        <p style="font-weight: 600; font-size: 0.9rem; margin: 0;">Tidak ada produk ditemukan.</p>
      </div>
    `;
    return;
  }

  list.forEach(p => {
    const isOutOfStock = p.stok <= 0;
    const isLowStock = p.stok > 0 && p.stok <= 5;
    let stockBadgeClass = '';
    let stockText = `${p.stok} pcs`;
    if (isOutOfStock) {
      stockBadgeClass = 'empty';
      stockText = 'Habis';
    } else if (isLowStock) {
      stockBadgeClass = 'low';
      stockText = `Sisa ${p.stok}`;
    }

    const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=200';

    // Cek apakah produk ini ada di keranjang belanja
    const cartItem = cart.find(it => it.id === p.id && !it.isBox);
    const cartQty = cartItem ? cartItem.qty : 0;
    const inCartClass = cartQty > 0 ? 'in-cart' : '';
    const cartBadgeHtml = cartQty > 0 ? `<span class="pos-grid-qty-badge">🛒 ${cartQty}</span>` : '';

    const card = document.createElement('div');
    const isGridCardDisabled = isOutOfStock && !appConfig.allowZeroStock;
    card.className = `pos-grid-card ${isGridCardDisabled ? 'out-of-stock' : ''} ${inCartClass}`;

    let actionButtonsHtml = '';
    if (cartQty > 0) {
      actionButtonsHtml = `
        <div class="pos-grid-qty-controls" onclick="event.stopPropagation();">
          <button type="button" class="pos-grid-btn-qty minus" onclick="reduceProductFromGrid('${p.id}')" title="Kurangi 1">-</button>
          <span class="pos-grid-qty-num">${cartQty}</span>
          <button type="button" class="pos-grid-btn-qty plus" onclick="addToCart(products.find(pr => pr.id === '${p.id}')); playBeep();" title="Tambah 1">+</button>
        </div>
      `;
    } else {
      actionButtonsHtml = `
        <button type="button" class="pos-grid-add-btn" title="Tambah ke keranjang" tabindex="-1">+</button>
      `;
    }

    card.onclick = () => {
      if (!isOutOfStock || appConfig.allowZeroStock) {
        addToCart(p);
        playBeep();
      } else {
        alert(`Stok "${p.nama}" habis!`);
      }
    };

    const gridRackBadge = p.rak 
      ? `<div style="font-size: 0.72rem; color: var(--color-primary); font-weight: 600; margin-top: 0.15rem; display: flex; align-items: center; gap: 0.2rem;"><span>📍 ${p.rak}</span></div>` 
      : '';

    card.innerHTML = `
      <div class="pos-grid-img-wrap">
        <img src="${imgUrl}" alt="${p.nama}" class="pos-grid-img" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="handleImageError(this)">
        ${cartBadgeHtml}
        <span class="pos-grid-stock-badge ${stockBadgeClass}">${stockText}</span>
      </div>
      <div class="pos-grid-body">
        <div class="pos-grid-name" title="${p.nama}">${p.nama}</div>
        ${gridRackBadge}
        <div class="pos-grid-footer">
          <span class="pos-grid-price">Rp ${formatRupiah(p.harga_jual)}</span>
          ${actionButtonsHtml}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function reduceProductFromGrid(productId) {
  const itemIndex = cart.findIndex(it => it.id === productId && !it.isBox);
  if (itemIndex === -1) return;
  const item = cart[itemIndex];
  if (item.qty > 1) {
    updateCartQty(item.cartId, -1);
  } else {
    // Jika sisa 1 dan ditekan minus, langsung hapus dari keranjang
    cart.splice(itemIndex, 1);
    renderCart();
  }
}

// --- TAB POS: PENCARIAN & DROPDOWN ---
function filterProducts() {
  const searchInput = document.getElementById('search-input');
  const searchVal = searchInput.value.toLowerCase().trim();
  const dropdown = document.getElementById('floating-results');

  if (appConfig.posGridMode === true) {
    renderPosCatalogGrid();
    if (dropdown) closeFloatingResults();
    return;
  }
  
  if (searchVal === '') {
    closeFloatingResults();
    return;
  }
  
  // Barcode exact match logic dipindah ke handleSearchInputKeydowns saat Enter ditekan
  // untuk mencegah pemindaian sebagian jika scanner cepat.
  
  // Cari Produk Cocok
  let matchedProds = products.filter(p => {
    return String(p.nama).toLowerCase().includes(searchVal) || 
           String(p.id).toLowerCase().includes(searchVal) ||
           (p.barcode && String(p.barcode).toLowerCase().includes(searchVal)) ||
           (p.rak && String(p.rak).toLowerCase().includes(searchVal));
  });

  // Cari Paket Bundling Cocok (misal ketik 'bundling' atau nama paket atau barcode paket)
  let matchedBundles = bundles.filter(b => {
    return String(b.nama).toLowerCase().includes(searchVal) ||
           (b.barcode && String(b.barcode).toLowerCase().includes(searchVal)) ||
           searchVal.includes('bundle') || searchVal.includes('bundling') || searchVal.includes('paket');
  }).map(b => ({ ...b, isBundleItem: true }));

  matchedProds.sort((a, b) => {
    const aNameMatch = String(a.nama).toLowerCase().includes(searchVal);
    const bNameMatch = String(b.nama).toLowerCase().includes(searchVal);
    if (aNameMatch && !bNameMatch) return -1;
    if (!aNameMatch && bNameMatch) return 1;
    return String(a.nama).toLowerCase().localeCompare(String(b.nama).toLowerCase(), 'id');
  });

  // Gabungkan paket bundling di atas/bersama produk
  const combined = [...matchedBundles, ...matchedProds];
  filteredProducts = combined.slice(0, 15);
  
  if (filteredProducts.length === 0) {
    dropdown.innerHTML = '<div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.85rem;">Barang atau paket bundling tidak ditemukan...</div>';
    dropdown.classList.add('active');
    selectedFloatIndex = -1;
    return;
  }
  
  selectedFloatIndex = 0;
  renderFloatingDropdown();
}

function renderFloatingDropdown() {
  const dropdown = document.getElementById('floating-results');
  dropdown.innerHTML = '';
  dropdown.classList.add('active');
  
  filteredProducts.forEach((p, index) => {
    const isSelected = index === selectedFloatIndex;

    // Render khusus jika item adalah Paket Bundling
    if (p.isBundleItem) {
      const bDiv = document.createElement('div');
      bDiv.className = `floating-item floating-item-bundle ${isSelected ? 'selected' : ''}`;
      bDiv.onclick = () => {
        addBundleToCart(p);
        document.getElementById('search-input').value = '';
        closeFloatingResults();
        focusSearchInput();
      };

      const compText = (p.items || []).map(it => `${it.productName} (${it.qty}x)`).join(' + ');

      bDiv.innerHTML = `
        <div class="bundle-float-icon">
          🎁
        </div>
        <div class="floating-item-info">
          <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
            <span class="bundle-float-title">[PAKET HEMAT] ${p.nama}</span>
            <span class="bundle-float-tag">Paket Bundling</span>
          </div>
          <div class="bundle-float-comp">
            Isi: ${compText}
          </div>
          <div class="floating-item-meta" style="flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 3px;">
            <span class="bundle-float-price">Rp ${formatRupiah(p.harga)}</span>
            <span class="bundle-float-normal">Rp ${formatRupiah(p.totalNormal || 0)}</span>
          </div>
        </div>
      `;
      dropdown.appendChild(bDiv);
      return;
    }

    const isOutOfStock = p.stok <= 0;
    const isLowStock = p.stok > 0 && p.stok <= 5;
    
    let stockText = `Stok: ${p.stok}`;
    let stockClass = '';
    if (isOutOfStock) {
      stockText = 'Habis';
      stockClass = 'empty';
    } else if (isLowStock) {
      stockClass = 'low';
    }
    
    const div = document.createElement('div');
    const isDropdownItemDisabled = isOutOfStock && !appConfig.allowZeroStock;
    div.className = `floating-item ${isSelected ? 'selected' : ''} ${isDropdownItemDisabled ? 'out-of-stock' : ''}`;
    div.onclick = () => {
      if (!isOutOfStock || appConfig.allowZeroStock) {
        addToCart(p);
        document.getElementById('search-input').value = '';
        closeFloatingResults();
        focusSearchInput();
      } else {
        alert(`Stok "${p.nama}" habis!`);
      }
    };
    
    const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=100';
    
    let priceText = `<span class="badge-buy-price">Beli: Rp ${formatRupiah(p.harga_beli || 0)}</span><span class="badge-sell-price">Jual: Rp ${formatRupiah(p.harga_jual)}</span>`;
    let boxBtnHtml = '';
    if ((parseInt(p.isi_box) || 0) > 1 && (parseFloat(p.harga_box) || 0) > 0) {
      priceText += ` <span class="badge-box-price">📦 1 ${p.nama_box || 'Kotak'} (${p.isi_box} pcs): Rp ${formatRupiah(p.harga_box)}</span>`;
      const prodIndex = products.findIndex(pr => pr.id === p.id);
      boxBtnHtml = `<button type="button" class="btn btn-sm btn-box-add" onclick="event.stopPropagation(); addBoxToCartByProductIndex(${prodIndex}); document.getElementById('search-input').value=''; closeFloatingResults(); focusSearchInput();" title="Tambah 1 ${p.nama_box || 'Kotak'}">+ 1 ${p.nama_box || 'Kotak'}</button>`;
    }
    if (p.grosir_qty > 0 && p.grosir_harga > 0) {
      priceText += ` <span class="badge-grosir-price">🏷️ Grosir: ${p.grosir_qty} pcs = Rp ${formatRupiah(p.grosir_harga)}</span>`;
    }
    if (p.promo_beli_x > 0 && p.promo_gratis_y > 0) {
      priceText += ` <span class="badge-promo-buyget">🎁 Beli ${p.promo_beli_x} Gratis ${p.promo_gratis_y}</span>`;
    }

    const rackBadgeHtml = p.rak 
      ? `<span class="badge-prod-rack" style="display: inline-flex; align-items: center; gap: 0.25rem; background: #e0e7ff; color: #3730a3; padding: 0.15rem 0.5rem; border-radius: 6px; font-size: 0.76rem; font-weight: 700; border: 1px solid #c7d2fe;"><i data-lucide="map-pin" style="width: 12px; height: 12px; color: #4338ca;"></i> ${p.rak}</span>`
      : '';
    
    div.innerHTML = `
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="handleImageError(this)">
      <div class="floating-item-info">
        <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
          <span class="floating-item-name">${p.nama} (${p.id})</span>
          ${rackBadgeHtml}
        </div>
        <div class="floating-item-meta" style="flex-wrap: wrap; gap: 0.2rem; align-items: center;">
          <span class="floating-item-price">${priceText}</span>
          <span class="floating-item-stock ${stockClass}">${stockText}</span>
          ${boxBtnHtml}
        </div>
      </div>
    `;
    dropdown.appendChild(div);
  });
  
  const selectedEl = dropdown.querySelector('.floating-item.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

function closeFloatingResults() {
  const dropdown = document.getElementById('floating-results');
  if (dropdown) {
    dropdown.classList.remove('active');
  }
  filteredProducts = [];
  selectedFloatIndex = -1;
}

function handleSearchInputKeydowns(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const searchInput = document.getElementById('search-input');
    const searchVal = searchInput.value.toLowerCase().trim();
    if (!searchVal) return;
    
    // Cek Bundle exact match barcode atau nama paket
    const matchedBundle = bundles.find(b => 
      (b.barcode && String(b.barcode).toLowerCase() === searchVal) ||
      String(b.nama).toLowerCase() === searchVal
    );
    if (matchedBundle) {
      addBundleToCart(matchedBundle);
      searchInput.value = '';
      closeFloatingResults();
      return;
    }

    // 1. Cek exact match barcode eceran, multi-satuan, barcode kotak, atau ID terlebih dahulu (untuk scanner)
    let exactMatch = null;
    let isBoxScan = false;
    let matchedUnit = null;
    
    products.forEach(p => {
      if (p.barcode && String(p.barcode).toLowerCase() === searchVal) {
        exactMatch = p;
        isBoxScan = false;
      } else if (Array.isArray(p.units) && p.units.some(u => u.barcode && String(u.barcode).toLowerCase() === searchVal)) {
        exactMatch = p;
        isBoxScan = true;
        matchedUnit = p.units.find(u => u.barcode && String(u.barcode).toLowerCase() === searchVal);
      } else if (p.has_unit_box && p.barcode_box && String(p.barcode_box).toLowerCase() === searchVal) {
        exactMatch = p;
        isBoxScan = true;
      } else if (String(p.id).toLowerCase() === searchVal && !exactMatch) {
        exactMatch = p;
        isBoxScan = false;
      }
    });
    
    if (exactMatch) {
      const requiredPcs = isBoxScan ? (matchedUnit ? matchedUnit.ratio : (exactMatch.isi_box || 1)) : 1;
      if (exactMatch.stok >= requiredPcs || appConfig.allowZeroStock) {
        if (isBoxScan) {
          addBoxToCart(exactMatch, matchedUnit);
        } else {
          addToCart(exactMatch);
        }
        searchInput.value = '';
        closeFloatingResults();
      } else {
        alert(`Stok "${exactMatch.nama}" tidak mencukupi! Tersisa ${exactMatch.stok} pcs.`);
      }
      return;
    }
    
    // 2. Jika tidak ada exact match, gunakan hasil pilihan dropdown
    if (filteredProducts.length > 0 && selectedFloatIndex > -1 && selectedFloatIndex < filteredProducts.length) {
      const prod = filteredProducts[selectedFloatIndex];
      if (prod.isBundleItem) {
        addBundleToCart(prod);
        searchInput.value = '';
        closeFloatingResults();
        focusSearchInput();
        return;
      }
      if (prod.stok > 0 || appConfig.allowZeroStock) {
        addToCart(prod);
        searchInput.value = '';
        closeFloatingResults();
      } else {
        alert("Stok barang habis!");
      }
    }
    return;
  }
  
  // Cek apakah dropdown pencarian sedang terbuka
  const floatingDropdown = document.getElementById('floating-results');
  const isFloatingOpen = floatingDropdown && floatingDropdown.classList.contains('active') && filteredProducts.length > 0;
  
  if (isFloatingOpen) {
    // Navigasi dropdown pencarian produk (perilaku lama)
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedFloatIndex = (selectedFloatIndex + 1) % filteredProducts.length;
      renderFloatingDropdown();
    } 
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedFloatIndex = (selectedFloatIndex - 1 + filteredProducts.length) % filteredProducts.length;
      renderFloatingDropdown();
    }
  } else {
    // Dropdown tertutup -> navigasi keranjang dengan keyboard
    if (cart.length === 0) return;
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedCartIndex = Math.min(selectedCartIndex + 1, cart.length - 1);
      highlightSelectedCartItem();
    } 
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedCartIndex <= 0) {
        selectedCartIndex = -1;
        highlightSelectedCartItem();
      } else {
        selectedCartIndex = selectedCartIndex - 1;
        highlightSelectedCartItem();
      }
    } 
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (selectedCartIndex >= 0 && selectedCartIndex < cart.length) {
        const item = cart[selectedCartIndex];
        updateCartQty(item.cartId, 1);
        // Pastikan index masih valid setelah update
        if (selectedCartIndex >= cart.length) selectedCartIndex = cart.length - 1;
        highlightSelectedCartItem();
        focusSearchInput();
      }
    } 
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (selectedCartIndex >= 0 && selectedCartIndex < cart.length) {
        const item = cart[selectedCartIndex];
        updateCartQty(item.cartId, -1);
        // Setelah qty berkurang, cek apakah item terhapus
        if (cart.length === 0) {
          selectedCartIndex = -1;
        } else if (selectedCartIndex >= cart.length) {
          selectedCartIndex = cart.length - 1;
        }
        highlightSelectedCartItem();
        focusSearchInput();
      }
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedCartIndex >= 0 && selectedCartIndex < cart.length) {
        // Khusus Backspace: jangan hapus produk keranjang jika user sedang mengetik di kolom pencarian
        const searchInput = document.getElementById('search-input');
        if (e.key === 'Backspace' && searchInput.value.length > 0) {
          return;
        }
        
        e.preventDefault();
        const item = cart[selectedCartIndex];
        removeFromCart(item.cartId);
        
        if (cart.length === 0) {
          selectedCartIndex = -1;
        } else if (selectedCartIndex >= cart.length) {
          selectedCartIndex = cart.length - 1;
        }
        highlightSelectedCartItem();
        focusSearchInput();
      }
    }
  }
}

// Menandai item keranjang yang sedang dipilih secara visual
function highlightSelectedCartItem() {
  const cartItems = document.querySelectorAll('#cart-list .cart-item');
  cartItems.forEach((el, i) => {
    if (i === selectedCartIndex) {
      el.classList.add('cart-item-selected');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      el.classList.remove('cart-item-selected');
    }
  });
}

// --- TOAST NOTIFIKASI KASIR ---
function showPosToast(message, type = 'promo') {
  let container = document.getElementById('pos-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'pos-toast-container';
    container.className = 'pos-toast-container';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = `pos-toast ${type}`;
  toast.innerHTML = message;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => {
      if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 300);
  }, 3500);
}

// --- TAB POS: KERANJANG & ATURAN HARGA / PROMO ---
function calculateCartItemPricing(localProd, totalQty) {
  const result = {
    qty: totalQty,
    subtotal: 0,
    freeQty: 0,
    paidQty: totalQty,
    grosirPackages: 0,
    grosirRemaining: 0,
    grosirTotal: 0,
    savings: 0,
    badges: [],
    promoInfo: '',
    canClaimBonus: false,
    bonusToClaim: 0
  };
  
  if (!localProd || totalQty <= 0) return result;
  
  const basePrice = parseFloat(localProd.harga_jual) || 0;
  const standardTotal = totalQty * basePrice;
  
  // 1. Cek Aturan Promo Beli X Gratis Y (Buy X Get Y Free) - Selalu aktif, gratis otomatis
  const buyX = parseInt(localProd.promo_beli_x) || 0;
  const getY = parseInt(localProd.promo_gratis_y) || 0;
  const hasBuyGetPromo = buyX > 0 && getY > 0;
  
  let freeQty = 0;
  let paidQty = totalQty;
  
  if (hasBuyGetPromo) {
    const cycle = buyX + getY;
    const fullCycles = Math.floor(totalQty / cycle);
    const rem = totalQty % cycle;
    freeQty = (fullCycles * getY) + Math.max(0, rem - buyX);
    paidQty = totalQty - freeQty;
    
    result.freeQty = freeQty;
    result.paidQty = paidQty;
    result.buyX = buyX;
    result.getY = getY;
    
    // Hanya tampilkan badge jika sudah ada gratis (tidak tampilkan info / eligible)
    if (freeQty > 0) {
      result.promoInfo = `Beli ${buyX} Gratis ${getY} (${freeQty} gratis)`;
    }
  }
  
  // 2. Harga Bertingkat Dus/Kotak & Aturan Grosir
  let isBoxPackaging = false;
  let boxUnitName = "";
  let boxMinQty = 0;
  let boxPrice = 0;
  
  const isiBox = parseInt(localProd.isi_box) || 0;
  const hargaBox = parseFloat(localProd.harga_box) || 0;
  const grosirQty = parseInt(localProd.grosir_qty) || 0;
  const grosirHarga = parseFloat(localProd.grosir_harga) || 0;
  
  if (isiBox > 1 && hargaBox > 0) {
    // Produk memang memiliki fitur kemasan kotak/dus
    isBoxPackaging = true;
    boxUnitName = localProd.nama_box || "Dus";
    boxMinQty = isiBox;
    boxPrice = hargaBox;
  } else if (grosirQty > 1 && grosirHarga > 0) {
    // Murni aturan harga khusus / grosir per quantity (bukan kemasan dus)
    isBoxPackaging = false;
    boxUnitName = "Grosir";
    boxMinQty = grosirQty;
    boxPrice = grosirHarga;
  }
  
  result.isBoxPackaging = isBoxPackaging;
  result.boxUnitName = boxUnitName;
  result.boxMinQty = boxMinQty;
  
  const hasBoxTier = boxMinQty > 1 && boxPrice > 0;
  let subtotal = 0;
  
  if (hasBoxTier && paidQty >= boxMinQty) {
    const packages = Math.floor(paidQty / boxMinQty);
    const remaining = paidQty % boxMinQty;
    const boxTotal = packages * boxPrice;
    
    result.grosirPackages = packages;
    result.grosirRemaining = remaining;
    result.grosirTotal = boxTotal;
    
    // Remaining items unit pricing (cek promo diskon satuan jika ada)
    const hargaDiskon = parseFloat(localProd.harga_diskon) || 0;
    const kuotaDiskon = (parseInt(localProd.kuota_diskon) || 0) > 0 ? parseInt(localProd.kuota_diskon) : Infinity;
    let remTotal = 0;
    if (appConfig.enablePromo && hargaDiskon > 0 && remaining > 0) {
      const pQty = Math.min(remaining, kuotaDiskon);
      const rQty = remaining - pQty;
      remTotal = (pQty * hargaDiskon) + (rQty * basePrice);
    } else {
      remTotal = remaining * basePrice;
    }
    
    subtotal = boxTotal + remTotal;
    
    let pkgText = "";
    if (isBoxPackaging) {
      pkgText = packages > 1 ? `${packages} ${boxUnitName}` : `1 ${boxUnitName}`;
    } else {
      pkgText = `Grosir (${packages * boxMinQty} pcs)`;
    }
    const remText = remaining > 0 ? ` + ${remaining} pcs eceran` : '';
    
    result.badges.push({
      type: 'grosir',
      text: isBoxPackaging 
        ? `📦 Harga ${pkgText} (${packages * boxMinQty} pcs = Rp ${formatRupiah(boxTotal)})${remText}`
        : `🏷️ Harga Grosir (${packages * boxMinQty} pcs = Rp ${formatRupiah(boxTotal)})${remText}`
    });
    if (!result.promoInfo) {
      result.promoInfo = isBoxPackaging ? `${pkgText}${remText}` : `Grosir ${packages * boxMinQty} pcs${remText}`;
    }
  } else {
    // Belum mencapai kuota dus / grosir
    if (hasBoxTier && paidQty < boxMinQty) {
      const needMore = boxMinQty - paidQty;
      result.badges.push({
        type: 'info',
        text: isBoxPackaging
          ? `📦 1 ${boxUnitName} isi ${boxMinQty} = Rp ${formatRupiah(boxPrice)} (Kurang ${needMore} pcs lagi)`
          : `🏷️ Grosir min. ${boxMinQty} pcs = Rp ${formatRupiah(boxPrice)} (Kurang ${needMore} pcs lagi)`
      });
    }
    
    // Unit pricing dengan diskon langsung (jika ada)
    const hargaDiskon = parseFloat(localProd.harga_diskon) || 0;
    const kuotaDiskon = (parseInt(localProd.kuota_diskon) || 0) > 0 ? parseInt(localProd.kuota_diskon) : Infinity;
    if (appConfig.enablePromo && hargaDiskon > 0 && paidQty > 0) {
      const pQty = Math.min(paidQty, kuotaDiskon);
      const rQty = paidQty - pQty;
      subtotal = (pQty * hargaDiskon) + (rQty * basePrice);
      if (pQty > 0) {
        result.badges.push({
          type: 'active',
          text: `⚡ Diskon Promo: ${pQty}x @Rp ${formatRupiah(hargaDiskon)}`
        });
      }
    } else {
      subtotal = paidQty * basePrice;
    }
  }
  
  result.subtotal = subtotal;
  result.savings = Math.max(0, standardTotal - subtotal);
  return result;
}

function applyPricingToCartItem(item) {
  if (item.isBundle) {
    item.subtotal = item.qty * item.harga;
    item.paidQty = item.qty;
    item.freeQty = 0;
    return;
  }
  if (item.isBox) {
    item.subtotal = item.qty * item.harga;
    return;
  }
  const localProd = products.find(p => p.id === item.id);
  if (!localProd) return;
  const pricing = calculateCartItemPricing(localProd, item.qty);
  item.subtotal = pricing.subtotal;
  item.harga = item.qty > 0 ? Math.round(pricing.subtotal / item.qty) : localProd.harga_jual;
  item.baseHarga = localProd.harga_jual;
  item.freeQty = pricing.freeQty;
  item.paidQty = pricing.paidQty;
  item.grosirPackages = pricing.grosirPackages;
  item.isBoxPackaging = pricing.isBoxPackaging;
  item.boxUnitName = pricing.boxUnitName;
  item.savings = pricing.savings;
  item.badges = pricing.badges;
  item.promoInfo = pricing.promoInfo;
  item.canClaimBonus = pricing.canClaimBonus;
  item.bonusToClaim = pricing.bonusToClaim;
}

function addToCart(product) {
  lastTransactionChange = null;
  if (appConfig.strictShift && !activeShift) {
    alert("Wajib buka shift terlebih dahulu untuk melakukan transaksi!");
    return;
  }
  
  const buyX = parseInt(product.promo_beli_x) || 0;
  const getY = parseInt(product.promo_gratis_y) || 0;
  const hasBuyGet = buyX > 0 && getY > 0;
  const cycle = hasBuyGet ? (buyX + getY) : 0;
  
  let existingItem = cart.find(it => it.id === product.id && !it.isBox);
  if (existingItem) {
    // Hitung berapa qty seharusnya (tanpa gratis) sebelum penambahan
    const prevPaidQty = existingItem.paidQty || existingItem.qty;
    let newPaidQty = prevPaidQty + 1;
    
    // Hitung total qty nyata termasuk gratis otomatis
    let newQty;
    if (hasBuyGet) {
      const fullCycles = Math.floor(newPaidQty / buyX);
      const rem = newPaidQty % buyX;
      newQty = (fullCycles * cycle) + rem;
    } else {
      newQty = existingItem.qty + 1;
    }
    
    if (newQty > product.stok && !appConfig.allowZeroStock) {
      alert(`Stok tidak mencukupi! Hanya tersisa ${product.stok} pcs.`);
      focusSearchInput();
      return;
    }
    existingItem.qty = newQty;
    applyPricingToCartItem(existingItem);
  } else {
    if (product.stok <= 0 && !appConfig.allowZeroStock) {
      alert("Stok barang habis!");
      focusSearchInput();
      return;
    }
    const newItem = {
      cartId: product.id,
      id: product.id,
      nama: product.nama,
      harga: product.harga_jual,
      harga_beli: product.harga_beli || 0,
      qty: 1,
      isBox: false,
      gambar: product.gambar
    };
    applyPricingToCartItem(newItem);
    cart.unshift(newItem);
  }
  
  playBeep();
  renderCart();
  focusSearchInput();
}

// claimBonusItem tetap ada untuk kompatibilitas tapi tidak lagi dibutuhkan (gratis sudah otomatis)
function claimBonusItem(cartId, bonusQty = 1) {
  // No-op: gratis sudah otomatis masuk saat qty terpenuhi
}

function addBoxToCart(product, specificUnit = null) {
  lastTransactionChange = null;
  if (appConfig.strictShift && !activeShift) {
    alert("Wajib buka shift terlebih dahulu untuk melakukan transaksi!");
    return;
  }
  
  const boxQtyRequired = specificUnit ? (specificUnit.ratio || 1) : (product.isi_box || 12);
  const boxPrice = specificUnit ? (specificUnit.price || 0) : (product.harga_box || 0);
  const boxUnitName = specificUnit ? (specificUnit.name || 'Kotak') : (product.nama_box || 'Kotak');
  const cartId = product.id + '_box_' + boxUnitName.toLowerCase().replace(/\s+/g, '_');
  
  let totalPcsInCart = cart.reduce((sum, item) => {
    if (item.id === product.id) {
      return sum + (item.isBox ? item.qty * (item.isiBox || 12) : item.qty);
    }
    return sum;
  }, 0);
  
  if (totalPcsInCart + boxQtyRequired > product.stok && !appConfig.allowZeroStock) {
    alert(`Stok tidak mencukupi untuk 1 ${boxUnitName}! Membutuhkan ${boxQtyRequired} pcs, sedangkan stok tersisa ${product.stok} pcs.`);
    return;
  }
  
  const existingItem = cart.find(item => item.cartId === cartId);
  if (existingItem) {
    existingItem.qty += 1;
    existingItem.subtotal = existingItem.qty * existingItem.harga;
  } else {
    cart.push({
      cartId: cartId,
      id: product.id,
      nama: `${product.nama} (1 ${boxUnitName} @${boxQtyRequired} pcs)`,
      harga: boxPrice,
      subtotal: boxPrice,
      harga_beli: (product.harga_beli || 0) * boxQtyRequired,
      qty: 1,
      isBox: true,
      isiBox: boxQtyRequired,
      namaBox: boxUnitName,
      gambar: product.gambar,
      originalProduct: product
    });
  }
  
  playBeep();
  renderCart();
  focusSearchInput();
}

function addBoxToCartByProductIndex(index, unitIndex = -1) {
  const p = products[index];
  if (p) {
    let specificUnit = null;
    if (unitIndex >= 0 && Array.isArray(p.units) && p.units[unitIndex]) {
      specificUnit = p.units[unitIndex];
    }
    addBoxToCart(p, specificUnit);
  }
}

function updateCartQty(cartId, delta) {
  const itemIndex = cart.findIndex(item => item.cartId === cartId);
  if (itemIndex === -1) return;
  const item = cart[itemIndex];
  
  if (item.isBundle) {
    const newQty = item.qty + delta;
    if (newQty < 1) {
      focusSearchInput();
      return;
    }
    if (!appConfig.allowZeroStock && Array.isArray(item.bundleItems)) {
      for (const comp of item.bundleItems) {
        const p = products.find(x => x.id === comp.productId);
        const req = (comp.qty || 1) * newQty;
        if (p && p.stok < req) {
          alert(`Stok komponen "${comp.productName}" tidak mencukupi untuk ${newQty} paket!`);
          focusSearchInput();
          return;
        }
      }
    }
    item.qty = newQty;
    item.subtotal = item.qty * item.harga;
    item.paidQty = item.qty;
    renderCart();
    focusSearchInput();
    return;
  }
  
  if (item.isBox) {
    const newQty = item.qty + delta;
    if (newQty < 1) {
      // Tidak boleh kosong/kurang dari 1. Jika ingin hapus gunakan tombol Delete / ikon Hapus.
      focusSearchInput();
      return;
    }
    
    const localProd = products.find(p => p.id === item.id);
    if (localProd && !appConfig.allowZeroStock) {
      const totalPcsInCart = cart.reduce((sum, it) => {
        if (it.id === item.id) {
          const q = it.cartId === cartId ? newQty : it.qty;
          return sum + (it.isBox ? q * (it.isiBox || 12) : it.qty);
        }
        return sum;
      }, 0);
      
      if (totalPcsInCart > localProd.stok) {
        alert(`Stok tidak mencukupi! Hanya tersisa ${localProd.stok} pcs.`);
        focusSearchInput();
        return;
      }
    }
    item.qty = newQty;
    item.subtotal = item.qty * item.harga;
    renderCart();
    focusSearchInput();
    return;
  }
  
  // Hitung qty baru untuk item non-box, dengan auto-gratis
  const localProd = products.find(p => p.id === item.id);
  const buyX = localProd ? (parseInt(localProd.promo_beli_x) || 0) : 0;
  const getY = localProd ? (parseInt(localProd.promo_gratis_y) || 0) : 0;
  const hasBuyGet = buyX > 0 && getY > 0;
  const cycle = hasBuyGet ? (buyX + getY) : 0;
  
  // Paid qty sebelum perubahan (qty nyata dikurangi gratis sebelumnya)
  const prevPaidQty = item.paidQty !== undefined ? item.paidQty : item.qty;
  let newPaidQty = prevPaidQty + delta;
  if (newPaidQty < 1) {
    // Tidak boleh kosong/kurang dari 1. Jika ingin hapus gunakan tombol Delete / ikon Hapus.
    focusSearchInput();
    return;
  }
  
  let newQty;
  if (hasBuyGet) {
    const fullCycles = Math.floor(newPaidQty / buyX);
    const rem = newPaidQty % buyX;
    newQty = (fullCycles * cycle) + rem;
  } else {
    newQty = newPaidQty;
  }
  
  if (localProd && !appConfig.allowZeroStock) {
    const boxPcs = cart.filter(it => it.id === item.id && it.isBox).reduce((sum, it) => sum + (it.qty * (it.isiBox || 12)), 0);
    if (newQty + boxPcs > localProd.stok) {
      alert(`Stok tidak mencukupi! Hanya tersisa ${localProd.stok - boxPcs} pcs.`);
      focusSearchInput();
      return;
    }
  }
  
  item.qty = newQty;
  applyPricingToCartItem(item);
  renderCart();
  focusSearchInput();
}

function removeFromCart(cartId, askConfirm = true) {
  const itemIndex = cart.findIndex(item => item.cartId === cartId);
  if (itemIndex === -1) return;
  const itemToRemove = cart[itemIndex];
  
  if (askConfirm) {
    if (!confirm(`Apakah Anda yakin ingin menghapus "${itemToRemove.nama}" dari keranjang?`)) {
      focusSearchInput();
      return;
    }
  }
  
  cart.splice(itemIndex, 1);
  renderCart();
  focusSearchInput();
}

function setCartQtyDirect(cartId, value) {
  let inputPaidQty = parseInt(value);
  const itemIndex = cart.findIndex(it => it.cartId === cartId);
  if (itemIndex === -1) return;
  const item = cart[itemIndex];
  
  // Jika input kosong atau < 1, kembalikan ke minimal 1
  if (isNaN(inputPaidQty) || inputPaidQty < 1) {
    inputPaidQty = 1;
  }
  
  if (item.isBundle) {
    if (!appConfig.allowZeroStock && Array.isArray(item.bundleItems)) {
      for (const comp of item.bundleItems) {
        const p = products.find(x => x.id === comp.productId);
        const req = (comp.qty || 1) * inputPaidQty;
        if (p && p.stok < req) {
          alert(`Stok komponen "${comp.productName}" tidak mencukupi untuk ${inputPaidQty} paket!`);
          renderCart();
          focusSearchInput();
          return;
        }
      }
    }
    item.qty = inputPaidQty;
    item.subtotal = item.qty * item.harga;
    item.paidQty = item.qty;
    renderCart();
    focusSearchInput();
    return;
  }
  
  if (item.isBox) {
    const localProd = products.find(p => p.id === item.id);
    if (localProd && !appConfig.allowZeroStock) {
      const totalPcsInCart = cart.reduce((sum, it) => {
        if (it.id === item.id) {
          const q = it.cartId === cartId ? inputPaidQty : it.qty;
          return sum + (it.isBox ? q * (it.isiBox || 12) : it.qty);
        }
        return sum;
      }, 0);
      
      if (totalPcsInCart > localProd.stok) {
        alert(`Stok tidak mencukupi! Hanya tersisa ${localProd.stok} pcs.`);
        renderCart();
        focusSearchInput();
        return;
      }
    }
    item.qty = inputPaidQty;
    item.subtotal = item.qty * item.harga;
    renderCart();
    focusSearchInput();
    return;
  }
  
  // Untuk item non-box: input user = qty yang DIBAYAR, hitung total qty dengan gratis otomatis
  const localProd = products.find(p => p.id === item.id);
  const buyX = localProd ? (parseInt(localProd.promo_beli_x) || 0) : 0;
  const getY = localProd ? (parseInt(localProd.promo_gratis_y) || 0) : 0;
  const hasBuyGet = buyX > 0 && getY > 0;
  const cycle = hasBuyGet ? (buyX + getY) : 0;
  
  let newQty;
  if (hasBuyGet) {
    const fullCycles = Math.floor(inputPaidQty / buyX);
    const rem = inputPaidQty % buyX;
    newQty = (fullCycles * cycle) + rem;
  } else {
    newQty = inputPaidQty;
  }
  
  if (localProd && !appConfig.allowZeroStock) {
    const boxPcs = cart.filter(it => it.id === item.id && it.isBox).reduce((sum, it) => sum + (it.qty * (it.isiBox || 12)), 0);
    if (newQty + boxPcs > localProd.stok) {
      alert(`Stok tidak mencukupi! Hanya tersisa ${localProd.stok - boxPcs} pcs.`);
      const safePaid = Math.max(1, localProd.stok - boxPcs);
      const sfCycles = hasBuyGet ? Math.floor(safePaid / buyX) : 0;
      const sfRem = hasBuyGet ? (safePaid % buyX) : safePaid;
      item.qty = hasBuyGet ? (sfCycles * cycle) + sfRem : safePaid;
      applyPricingToCartItem(item);
      renderCart();
      focusSearchInput();
      return;
    }
  }
  
  item.qty = newQty;
  applyPricingToCartItem(item);
  renderCart();
  focusSearchInput();
}

function checkPromoBanner() {
  const container = document.getElementById('promo-carousel-container');
  const marqueeContent = document.getElementById('promo-marquee-content');
  if (!container || !marqueeContent) return;
  
  if (appConfig.showPromoBanner === false) {
    container.style.display = 'none';
    marqueeContent.innerHTML = '';
    return;
  }
  
  // Beli X Gratis Y selalu tampil meskipun enablePromo off
  const promos = products.filter(p => {
    const hasBuyGet = (parseInt(p.promo_beli_x) || 0) > 0 && (parseInt(p.promo_gratis_y) || 0) > 0;
    const hasDiskon = appConfig.enablePromo && parseFloat(p.harga_diskon) > 0;
    const hasGrosir = appConfig.enablePromo && (parseInt(p.grosir_qty) || 0) > 0 && (parseFloat(p.grosir_harga) || 0) > 0;
    return hasBuyGet || hasDiskon || hasGrosir;
  });
  
  if (promos.length === 0) {
    container.style.display = 'none';
    marqueeContent.innerHTML = '';
    return;
  }
  
  container.style.display = 'block';
  let html = '';
  
  promos.forEach((p, i) => {
    const imgUrl = p.gambar || '';
    const imgTag = imgUrl
      ? `<img src="${imgUrl}" class="promo-banner-thumb" alt="${p.nama}" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="this.style.display='none'">`
      : '';
    
    let labelHtml = '';
    if ((parseInt(p.promo_beli_x) || 0) > 0 && (parseInt(p.promo_gratis_y) || 0) > 0) {
      labelHtml = `
        <div class="promo-banner-text">
          <span class="promo-banner-name">${p.nama}</span>
          <span class="promo-banner-tag gift">🎁 Beli ${p.promo_beli_x} Gratis ${p.promo_gratis_y}</span>
        </div>
      `;
    } else if (parseFloat(p.harga_diskon) > 0) {
      labelHtml = `
        <div class="promo-banner-text">
          <span class="promo-banner-name">${p.nama}</span>
          <span class="promo-banner-tag sale">🏷️ Harga Promo Rp ${formatRupiah(p.harga_diskon)}</span>
        </div>
      `;
    } else if ((parseInt(p.grosir_qty) || 0) > 0 && (parseFloat(p.grosir_harga) || 0) > 0) {
      labelHtml = `
        <div class="promo-banner-text">
          <span class="promo-banner-name">${p.nama}</span>
          <span class="promo-banner-tag bulk">📦 ${p.grosir_qty} pcs = Rp ${formatRupiah(p.grosir_harga)}</span>
        </div>
      `;
    }
    
    html += `
      <div class="promo-marquee-item ${i === 0 ? 'active' : ''}">
        ${imgTag}
        ${labelHtml}
      </div>
    `;
  });
  
  marqueeContent.innerHTML = html;
  
  if (window.promoCarouselInterval) {
    clearInterval(window.promoCarouselInterval);
  }
  
  if (promos.length > 1) {
    let currentIndex = 0;
    const items = marqueeContent.querySelectorAll('.promo-marquee-item');
    window.promoCarouselInterval = setInterval(() => {
      items[currentIndex].classList.remove('active');
      currentIndex = (currentIndex + 1) % items.length;
      items[currentIndex].classList.add('active');
    }, 3000);
  }
}

function saveCart() {
  localStorage.setItem('kasir_active_cart', JSON.stringify(cart));
}

function clearCart() {
  if (cart.length === 0 && lastTransactionChange === null) return;
  if (cart.length > 0 && !confirm("Apakah Anda yakin ingin mengosongkan keranjang belanja?")) return;
  cart = [];
  lastTransactionChange = null;
  selectedCartIndex = -1;
  renderCart();
}

function renderCart() {
  saveCart();
  const container = document.getElementById('cart-list');
  container.innerHTML = '';
  
  const totalLabel = document.getElementById('total-label-text');
  const totalRowContainer = document.getElementById('total-row-container');
  
  if (cart.length === 0) {
    container.innerHTML = `
      <div class="empty-cart-state">
        <svg viewBox="0 0 24 24" class="icon-empty"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>
        <p>Keranjang kosong. Cari barang atau gunakan tombol scan kamera di atas.</p>
      </div>
    `;
    
    document.getElementById('subtotal-val').textContent = 'Rp 0';
    
    if (lastTransactionChange !== null && lastTransactionChange !== undefined) {
      if (totalLabel) {
        totalLabel.style.display = 'block';
        totalLabel.textContent = 'KEMBALIAN';
      }
      if (totalRowContainer) totalRowContainer.classList.add('is-change');
      document.getElementById('total-val').textContent = `Rp ${formatRupiah(lastTransactionChange)}`;
    } else {
      if (totalLabel) totalLabel.style.display = 'none';
      if (totalRowContainer) totalRowContainer.classList.remove('is-change');
      document.getElementById('total-val').textContent = 'Rp 0';
    }
    
    document.getElementById('btn-proceed').disabled = true;
    return;
  }
  
  lastTransactionChange = null;
  if (totalLabel) totalLabel.style.display = 'none';
  if (totalRowContainer) totalRowContainer.classList.remove('is-change');
  
  cart.forEach(item => {
    applyPricingToCartItem(item);
    
    // Label "Bayar X, Gratis Y" jika ada gratis
    const freeQty = item.freeQty || 0;
    const paidQty = item.paidQty !== undefined ? item.paidQty : item.qty;
    const freeLabel = freeQty > 0
      ? `<span class="qty-free-label">Bayar ${paidQty}, Gratis ${freeQty}</span>`
      : '';
    
    // Label dus/kotak atau grosir jika harga bertingkat aktif
    let boxLabel = '';
    if (!item.isBox) {
      const localProd = products.find(p => p.id === item.id) || {};
      const isiBox = parseInt(localProd.isi_box) || 0;
      const hargaBox = parseFloat(localProd.harga_box) || 0;
      const grosirQty = parseInt(localProd.grosir_qty) || 0;
      const grosirHarga = parseFloat(localProd.grosir_harga) || 0;
      
      const isBoxPackaging = (isiBox > 1 && hargaBox > 0);
      const boxMinQty = isBoxPackaging ? isiBox : (grosirQty > 1 && grosirHarga > 0 ? grosirQty : 0);
      const unitName = isBoxPackaging ? (localProd.nama_box || 'Dus') : '';
      
      if (boxMinQty > 0 && paidQty >= boxMinQty) {
        const packages = Math.floor(paidQty / boxMinQty);
        const remaining = paidQty % boxMinQty;
        if (isBoxPackaging) {
          const pkgText = packages > 1 ? `${packages} ${unitName}` : `1 ${unitName}`;
          const remText = remaining > 0 ? ` + ${remaining} pcs` : '';
          boxLabel = `<span class="qty-box-label">📦 ${pkgText}${remText}</span>`;
        } else {
          const remText = remaining > 0 ? ` + ${remaining} pcs` : '';
          boxLabel = `<span class="qty-box-label" style="background: rgba(37, 99, 235, 0.1); color: #2563eb; border-color: rgba(37, 99, 235, 0.2);">🏷️ Grosir (${packages * boxMinQty} pcs)${remText}</span>`;
        }
      }
    }
    
    const subLabel = freeLabel || boxLabel;
    const isBoxItem = !!item.isBox;
    const isBundleItem = !!item.isBundle;
    const isiBoxCount = (item.isiBox || 1) * Math.max(item.qty, 1);
    let unitPrice = 0;
    if (isBundleItem) {
      unitPrice = Number(item.harga) || 0;
      item.subtotal = item.qty * unitPrice;
    } else if (isBoxItem) {
      unitPrice = Math.round((Number(item.subtotal) || 0) / Math.max(isiBoxCount, 1));
    } else if (item.qty > 1) {
      const safePaid = Number(paidQty) > 0 ? Number(paidQty) : item.qty;
      unitPrice = Math.round((Number(item.subtotal) || 0) / Math.max(safePaid, 1));
    } else {
      unitPrice = Number(item.subtotal) || Number(item.harga) || 0;
    }
    
    let priceSubDetailHtml = '';
    if (isBoxItem) {
      priceSubDetailHtml = `<span class="cart-item-unit-price">(Bayar ${isiBoxCount} pcs = Rp ${formatRupiah(item.subtotal)})</span>`;
    } else if (!isBundleItem && item.qty > 1) {
      priceSubDetailHtml = `<span class="cart-item-unit-price">(Bayar ${paidQty} pcs = Rp ${formatRupiah(item.subtotal)})</span>`;
    } else if (isBundleItem && item.qty > 1) {
      priceSubDetailHtml = `<span class="cart-item-unit-price">(${item.qty} paket x Rp ${formatRupiah(unitPrice)} = Rp ${formatRupiah(item.subtotal)})</span>`;
    }

    // Detail khusus Paket Bundling di Keranjang
    let bundleCartDetailHtml = '';
    if (item.isBundle || (Array.isArray(item.bundleItems) && item.bundleItems.length > 0)) {
      let bItems = item.bundleItems || [];
      let totalNormalPerSet = Number(item.totalNormal) || 0;
      if (totalNormalPerSet <= 0 && Array.isArray(bItems)) {
        totalNormalPerSet = bItems.reduce((acc, it) => acc + ((Number(it.normalPrice) || 0) * (Number(it.qty) || 1)), 0);
      }
      if (totalNormalPerSet <= 0 && typeof bundles !== 'undefined' && Array.isArray(bundles)) {
        const bObj = bundles.find(b => b.id === item.id);
        if (bObj && bObj.totalNormal) {
          totalNormalPerSet = bObj.totalNormal;
          if (!bItems || bItems.length === 0) bItems = bObj.items || [];
        }
      }

      const totalNormalCart = totalNormalPerSet * item.qty;
      const totalItemPrice = item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty);
      const hematCart = Math.max(0, totalNormalCart - totalItemPrice);
      const hematPct = totalNormalCart > 0 ? Math.round((hematCart / totalNormalCart) * 100) : 0;

      const compSummary = (bItems || []).map(bi => `${bi.productName} (${(Number(bi.qty) || 1) * item.qty}x)`).join(', ');

      bundleCartDetailHtml = `
        <div class="cart-bundle-box">
          <div class="cart-bundle-header">
            <span>📦 Isi Paket:</span>
            <span class="cart-bundle-items">${compSummary}</span>
          </div>
          ${totalNormalCart > totalItemPrice ? `
            <div class="cart-bundle-pricing">
              <span class="cart-bundle-normal">Normal: Rp ${formatRupiah(totalNormalCart)}</span>
              <span class="cart-bundle-savings">Hemat: Rp ${formatRupiah(hematCart)} (${hematPct}%)</span>
            </div>
          ` : ''}
        </div>
      `;
    }

    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div class="cart-item-info">
        <div class="cart-item-name">${item.nama}</div>
        <div class="cart-item-price-row">
          <span class="cart-item-price">Rp ${formatRupiah(unitPrice)}</span>
          ${priceSubDetailHtml}
        </div>
        ${bundleCartDetailHtml}
      </div>
      <div class="cart-item-controls">
        <button class="qty-btn" onclick="updateCartQty('${item.cartId}', -1)">-</button>
        <div class="qty-input-wrap">
          <input type="number" class="qty-input" value="${item.qty}" min="1" onchange="setCartQtyDirect('${item.cartId}', this.value)">
          ${subLabel}
        </div>
        <button class="qty-btn" onclick="updateCartQty('${item.cartId}', 1)">+</button>
        <button class="remove-item-btn" onclick="removeFromCart('${item.cartId}')" title="Hapus">
          <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </div>
    `;
    container.appendChild(div);
  });
  
  // Ensure selected index is valid and highlight
  if (cart.length === 0) {
    selectedCartIndex = -1;
  } else if (cart.length === 1) {
    // Hanya 1 item → otomatis terpilih (warna orange)
    selectedCartIndex = 0;
  } else if (selectedCartIndex >= cart.length) {
    selectedCartIndex = cart.length - 1;
  }
  highlightSelectedCartItem();
  
  calculateTotal();
  updateMobileCartBadge();
}

let globalTotal = 0;
function calculateTotal() {
  let subtotal = 0;
  cart.forEach(item => {
    subtotal += (item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty));
  });
  
  const discountRowWrapper = document.getElementById('discount-row-wrapper');
  if (discountRowWrapper) {
    discountRowWrapper.style.display = appConfig.showDiscountPos ? 'flex' : 'none';
  }
  
  const discountInput = document.getElementById('discount-input');
  let discountPercent = parseInt(discountInput.value) || 0;
  if (!appConfig.showDiscountPos) discountPercent = 0;
  if (discountPercent < 0) discountPercent = 0;
  if (discountPercent > 100) discountPercent = 100;
  
  const discountAmount = (discountPercent / 100) * subtotal;
  globalTotal = subtotal - discountAmount;
  
  document.getElementById('subtotal-val').textContent = `Rp ${formatRupiah(subtotal)}`;
  document.getElementById('total-val').textContent = `Rp ${formatRupiah(globalTotal)}`;
  
  // Render Keterangan Gratis — hanya tampil jika sudah ada barang gratis
  const promoContainer = document.getElementById('cart-promo-summary-container');
  if (promoContainer) {
    if (cart.length === 0) {
      promoContainer.innerHTML = '';
      promoContainer.style.display = 'none';
    } else {
      let promoCardsHtml = '';
      cart.forEach(item => {
        const localProd = products.find(p => p.id === item.id) || {};
        const imgUrl = item.gambar || localProd.gambar || '';
        const imgTag = imgUrl
          ? `<img src="${imgUrl}" class="cart-promo-thumb" alt="${item.nama}" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(item.nama)}')" onerror="this.style.display='none'">`
          : '';
        
        // Hanya tampilkan jika ada freeQty aktif (bukan eligible/info)
        if ((item.freeQty || 0) > 0) {
          promoCardsHtml += `
            <div class="cart-promo-summary-card">
              ${imgTag}
              <div class="cart-promo-content">
                <div class="cart-promo-title">🎁 Gratis ${item.freeQty} pcs (${item.nama})</div>
              </div>
            </div>
          `;
        }
        
        // Dus/Grosir tier
        if ((item.grosirPackages || 0) > 0) {
          const isBox = item.isBoxPackaging !== undefined 
            ? item.isBoxPackaging 
            : ((parseInt(localProd.isi_box) || 0) > 1 && (parseFloat(localProd.harga_box) || 0) > 0);
          
          let titleText = '';
          if (isBox) {
            const unitName = item.boxUnitName || localProd.nama_box || 'Dus';
            titleText = `📦 Harga ${item.grosirPackages} ${unitName} (${item.nama})`;
          } else {
            const minQty = (parseInt(localProd.grosir_qty) || 0);
            titleText = `🏷️ Harga Grosir (${(item.grosirPackages || 1) * minQty} pcs) - ${item.nama}`;
          }

          promoCardsHtml += `
            <div class="cart-promo-summary-card box">
              ${imgTag}
              <div class="cart-promo-content">
                <div class="cart-promo-title">${titleText}</div>
              </div>
            </div>
          `;
        }
      });
      
      if (promoCardsHtml) {
        promoContainer.innerHTML = promoCardsHtml;
        promoContainer.style.display = 'flex';
      } else {
        promoContainer.innerHTML = '';
        promoContainer.style.display = 'none';
      }
    }
  }
  
  document.getElementById('btn-proceed').disabled = cart.length === 0;
}

// --- MODAL PEMBAYARAN (STEP 2) ---
function openPaymentModal() {
  if (cart.length === 0) return;
  closeMobileCheckout();
  
  document.getElementById('pay-total-amount').textContent = `Rp ${formatRupiah(globalTotal)}`;
  
  // Reset payment method and status
  const methodSelect = document.getElementById('payment-method-select');
  const statusSelect = document.getElementById('payment-status-select');
  
  methodSelect.value = 'Tunai';
  methodSelect.disabled = false;
  statusSelect.value = 'Lunas';
  statusSelect.disabled = false;
  
  // Populate Customer Datalist
  const datalist = document.getElementById('customer-list');
  if (datalist) {
    datalist.innerHTML = customers.map(c => `<option value="${c.nama}">`).join('');
  }
  
  const customerNameGroup = document.getElementById('customer-name-group');
  if (appConfig.customerMode) {
    customerNameGroup.style.display = 'block';
    const custInput = document.getElementById('customer-name-input');
    if (custInput) custInput.value = '';
    const clearBtn = document.getElementById('btn-clear-customer');
    if (clearBtn) clearBtn.style.display = 'none';
    const infoDiv = document.getElementById('customer-points-info');
    if (infoDiv) infoDiv.style.display = 'none';
    const redeemInput = document.getElementById('redeem-points-input');
    if (redeemInput) redeemInput.value = '';
    closeCustomerDropdown();
  } else {
    customerNameGroup.style.display = 'none';
  }
  
  const cashInput = document.getElementById('cash-received');
  cashInput.value = '';
  document.getElementById('cash-received-group').style.display = 'block';
  document.getElementById('quick-cash-grid-container').style.display = 'grid';
  document.getElementById('cash-received-label').textContent = "Uang Diterima dari Konsumen (Rp)*";
  
  // Reset opsi ganti uang cash untuk non-tunai
  const replaceCont = document.getElementById('noncash-cash-replace-container');
  const replaceChk = document.getElementById('chk-replace-with-cash');
  if (replaceCont) replaceCont.style.display = 'none';
  if (replaceChk) replaceChk.checked = appConfig.autoCashNonCash === true;

  calculateChange();
  
  document.getElementById('payment-modal').classList.add('active');
  setTimeout(() => {
    if (appConfig.customerMode) {
      const custInput = document.getElementById('customer-name-input');
      if (custInput) {
        custInput.focus();
        custInput.select();
      }
    } else {
      cashInput.focus();
    }
  }, 120);
}

function onReplaceWithCashChange() {
  calculateChange();
}

function onPaymentMethodChange(val) {
  const cashInput = document.getElementById('cash-received');
  const cashGroup = document.getElementById('cash-received-group');
  const quickCashGrid = document.getElementById('quick-cash-grid-container');
  const statusSelect = document.getElementById('payment-status-select');
  const replaceCont = document.getElementById('noncash-cash-replace-container');
  const replaceChk = document.getElementById('chk-replace-with-cash');
  
  if (val !== 'Tunai') {
    // Non-tunai otomatis Lunas dan Uang Pas
    statusSelect.value = 'Lunas';
    onPaymentStatusChange('Lunas');
    statusSelect.disabled = true; // non-tunai tidak bisa Bon
    
    cashInput.value = formatRupiah(globalTotal);
    cashGroup.style.display = 'none';
    quickCashGrid.style.display = 'none';

    // Tampilkan opsi penggantian cash untuk non-tunai (QRIS / Transfer / Debit)
    if (replaceCont) {
      replaceCont.style.display = 'block';
      if (replaceChk) {
        replaceChk.checked = appConfig.autoCashNonCash === true;
      }
    }
  } else {
    statusSelect.disabled = false;
    cashInput.value = '';
    cashGroup.style.display = 'block';
    quickCashGrid.style.display = 'grid';
    if (replaceCont) replaceCont.style.display = 'none';
  }
  calculateChange();
}

function onPaymentStatusChange(val) {
  const cashInput = document.getElementById('cash-received');
  const cashLabel = document.getElementById('cash-received-label');
  const quickCashGrid = document.getElementById('quick-cash-grid-container');
  const debtContainer = document.getElementById('debt-details-container');
  const dueDateInput = document.getElementById('debt-due-date-input');
  
  if (val === 'Bon') {
    cashLabel.textContent = "Uang Muka / DP dibayarkan (Rp)";
    cashInput.placeholder = "Bisa dikosongkan (Rp 0)...";
    cashInput.value = '';
    quickCashGrid.style.display = 'none'; // sembunyikan quick cash karena bayar bebas/DP
    if (debtContainer) debtContainer.style.display = 'block';
    if (dueDateInput && !dueDateInput.value) {
      // Default jatuh tempo 7 hari ke depan
      const d = new Date();
      d.setDate(d.getDate() + 7);
      dueDateInput.value = getLocalISODate(d).slice(0, 10);
    }
  } else {
    cashLabel.textContent = "Uang Diterima dari Konsumen (Rp)*";
    cashInput.placeholder = "Masukkan jumlah uang...";
    cashInput.value = '';
    quickCashGrid.style.display = 'grid';
    if (debtContainer) debtContainer.style.display = 'none';
  }
  calculateChange();
}

function closePaymentModal() {
  document.getElementById('payment-modal').classList.remove('active');
  closeCustomerDropdown();
  focusSearchInput();
}

function formatAndCalculateChange() {
  const input = document.getElementById('cash-received');
  const cleanVal = input.value.replace(/\D/g, "");
  if (cleanVal === "") {
    input.value = "";
  } else {
    input.value = new Intl.NumberFormat('id-ID').format(cleanVal);
  }
  calculateChange();
}

function calculateChange() {
  const cashInput = document.getElementById('cash-received');
  const changeVal = document.getElementById('change-val');
  const btnSubmit = document.getElementById('btn-submit-payment');
  const method = document.getElementById('payment-method-select').value;
  const status = document.getElementById('payment-status-select').value;
  
  const cashText = cashInput.value.replace(/\./g, ""); // Hapus titik ribuan
  const cash = parseFloat(cashText) || 0;

  const isVoucherMode = (loyaltySettings.rewardMode === 'voucher');
  const selectedCustomerName = document.getElementById('customer-name-input').value.trim();
  const customer = customers.find(c => c.nama === selectedCustomerName);

  let pointDiscount = 0;
  let voucherDiscount = 0;
  let redeemPoints = 0;
  let redeemVouchers = 0;

  if (isVoucherMode) {
    // Mode Voucher
    const redeemVoucherInput = document.getElementById('redeem-voucher-count');
    redeemVouchers = Math.max(0, parseInt(redeemVoucherInput ? redeemVoucherInput.value : 0) || 0);
    if (redeemVoucherInput && parseInt(redeemVoucherInput.value) < 0) {
      redeemVoucherInput.value = '0';
    }
    
    const vStats = getCustomerMonthlyVoucherStats(customer);
    if (redeemVouchers > vStats.remaining) {
      redeemVouchers = vStats.remaining;
      if (redeemVoucherInput) redeemVoucherInput.value = redeemVouchers;
    }

    const rpPerVoucher = parseInt(loyaltySettings.voucherRpValue) || 10000;
    voucherDiscount = redeemVouchers * rpPerVoucher;

    // Diskon tidak boleh melebihi total belanja
    if (voucherDiscount > globalTotal) {
      voucherDiscount = globalTotal;
    }

    if (document.getElementById('redeem-voucher-discount')) {
      document.getElementById('redeem-voucher-discount').textContent = `Rp ${formatRupiah(voucherDiscount)}`;
    }

    // Update ringkasan pembayaran voucher vs tunai
    const vSummaryEl = document.getElementById('voucher-payment-summary');
    const finalTotalWithVoucher = Math.max(0, globalTotal - voucherDiscount);
    if (vSummaryEl) {
      if (voucherDiscount > 0) {
        vSummaryEl.style.display = 'block';
        if (finalTotalWithVoucher === 0) {
          vSummaryEl.innerHTML = `🎉 <b>LUNAS DENGAN VOUCHER!</b> (${redeemVouchers} Voucher). Tidak perlu uang tunai.`;
          vSummaryEl.style.color = '#059669';
        } else {
          vSummaryEl.innerHTML = `🎟️ Dipotong ${redeemVouchers} Voucher: <b>-Rp ${formatRupiah(voucherDiscount)}</b> &bull; Sisa Tunai yang Harus Dibayar: <b style="color:#dc2626;">Rp ${formatRupiah(finalTotalWithVoucher)}</b>`;
          vSummaryEl.style.color = '#b45309';
        }
      } else {
        vSummaryEl.style.display = 'none';
      }
    }
  } else {
    // Mode Poin
    const redeemInput = document.getElementById('redeem-points-input');
    redeemPoints = Math.max(0, parseInt(redeemInput ? redeemInput.value : 0) || 0);
    if (redeemInput && parseInt(redeemInput.value) < 0) {
      redeemInput.value = '0';
    }
    
    // Validasi max poin
    if (customer && redeemPoints > customer.poin) {
      redeemPoints = customer.poin;
      if (redeemInput) redeemInput.value = redeemPoints;
    }
    
    pointDiscount = redeemPoints * (loyaltySettings.rpPerPoint || 100);
    
    // Jangan biarkan diskon poin melebihi total belanja
    if (pointDiscount > globalTotal) {
      pointDiscount = globalTotal;
      redeemPoints = Math.floor(globalTotal / (loyaltySettings.rpPerPoint || 100));
      if (redeemInput) redeemInput.value = redeemPoints;
    }
    
    if (document.getElementById('redeem-points-discount')) {
      document.getElementById('redeem-points-discount').textContent = `Rp ${formatRupiah(pointDiscount)}`;
    }
    
    const finalTotalWithPoints = Math.max(0, globalTotal - pointDiscount);
    const summaryEl = document.getElementById('points-payment-summary');
    if (summaryEl) {
      if (pointDiscount > 0) {
        summaryEl.style.display = 'block';
        if (finalTotalWithPoints === 0) {
          summaryEl.innerHTML = `✅ <b>LUNAS DENGAN POIN!</b> Tidak perlu uang tunai.`;
          summaryEl.style.color = '#059669';
        } else {
          summaryEl.innerHTML = `💡 Dipotong Poin: <b>Rp ${formatRupiah(pointDiscount)}</b> &bull; Sisa Tunai yang Harus Dibayar: <b style="color:#dc2626;">Rp ${formatRupiah(finalTotalWithPoints)}</b>`;
          summaryEl.style.color = '#1e40af';
        }
      } else {
        summaryEl.style.display = 'none';
      }
    }
  }
  
  const totalDiscount = isVoucherMode ? voucherDiscount : pointDiscount;
  const finalTotalToPay = Math.max(0, globalTotal - totalDiscount);
  document.getElementById('pay-total-amount').textContent = `Rp ${formatRupiah(finalTotalToPay)}`;
  
  const change = cash - finalTotalToPay;
  
  const changeBox = changeVal.parentElement;
  const changeLabel = changeBox.querySelector('.bill-label');
  
  if (status === 'Bon') {
    if (changeLabel) changeLabel.textContent = "SISA BON PIUTANG (DEBT)";
    
    if (change >= 0) {
      changeVal.textContent = 'Rp 0 (Lunas)';
      changeVal.className = 'bill-amount change-ok';
      if (changeBox) changeBox.className = 'payment-bill-box change-box-large change-ok';
      btnSubmit.disabled = false;
    } else {
      const sisaPiutang = Math.abs(change);
      changeVal.textContent = `Rp ${formatRupiah(sisaPiutang)}`;
      changeVal.className = 'bill-amount change-neutral';
      if (changeBox) changeBox.className = 'payment-bill-box change-box-large change-neutral';
      btnSubmit.disabled = false; // Bon diperbolehkan bayar kurang atau Rp 0
    }
  } else {
    if (changeLabel) changeLabel.textContent = "KEMBALIAN";
    
    if (cashInput.value === '' && method === 'Tunai') {
      changeVal.textContent = 'Rp 0';
      changeVal.className = 'bill-amount change-neutral';
      if (changeBox) changeBox.className = 'payment-bill-box change-box-large change-neutral';
      btnSubmit.disabled = true;
    } else if (change >= 0) {
      changeVal.textContent = `Rp ${formatRupiah(change)}`;
      changeVal.className = 'bill-amount change-ok';
      if (changeBox) changeBox.className = 'payment-bill-box change-box-large change-ok';
      btnSubmit.disabled = false;
    } else {
      changeVal.textContent = `Kurang Rp ${formatRupiah(Math.abs(change))}`;
      changeVal.className = 'bill-amount change-insufficient';
      if (changeBox) changeBox.className = 'payment-bill-box change-box-large change-insufficient';
      btnSubmit.disabled = true;
    }
  }
}

function setQuickCash(amount) {
  const cashInput = document.getElementById('cash-received');
  if (amount === 'pass') {
    cashInput.value = new Intl.NumberFormat('id-ID').format(globalTotal);
  } else {
    cashInput.value = new Intl.NumberFormat('id-ID').format(amount);
  }
  calculateChange();
  cashInput.focus();
}

// --- PROSES CHECKOUT TRANSAKSI ---
let isCheckingOut = false; // Flag untuk mencegah klik ganda pada tombol bayar

async function processCheckout() {
  if (cart.length === 0) return;
  // Cegah double-submit jika tombol diklik dua kali cepat
  if (isCheckingOut) return;
  isCheckingOut = true;

  // Disable tombol submit selama proses
  const btnSubmit = document.getElementById('btn-submit-payment') || document.getElementById('btn-checkout-submit');
  if (btnSubmit) btnSubmit.disabled = true;

  try {
  const method = document.getElementById('payment-method-select').value;
  const status = document.getElementById('payment-status-select').value;
  const customerName = document.getElementById('customer-name-input').value.trim();
  
  if (status === 'Bon' && customerName === '') {
    alert("Untuk pembayaran Bon / Piutang, Nama Pelanggan wajib dipilih!");
    const custInput = document.getElementById('customer-name-input');
    if (custInput) { custInput.focus(); }
    if (btnSubmit) btnSubmit.disabled = false;
    isCheckingOut = false;
    return;
  }

  // Wajibkan memilih pelanggan jika fitur CRM Pelanggan diaktifkan di pengaturan sistem
  if (appConfig.customerMode) {
    if (!customerName) {
      alert("⚠️ Fitur Pelanggan & CRM sedang Aktif.\nHarap cari dan pilih pelanggan terlebih dahulu sebelum menyelesaikan pembayaran!");
      const custInput = document.getElementById('customer-name-input');
      if (custInput) { custInput.focus(); openCustomerDropdown(); }
      if (btnSubmit) btnSubmit.disabled = false;
      isCheckingOut = false;
      return;
    }
    const matchedCustomer = customers.find(c => c.nama.toLowerCase() === customerName.toLowerCase());
    if (!matchedCustomer) {
      alert(`⚠️ Pelanggan "${customerName}" belum terdaftar di database member toko!\nSilakan pilih dari daftar member atau tambahkan member baru di tab Pelanggan.`);
      const custInput = document.getElementById('customer-name-input');
      if (custInput) { custInput.focus(); openCustomerDropdown(); }
      if (btnSubmit) btnSubmit.disabled = false;
      isCheckingOut = false;
      return;
    }
  }
  
  // Ambil data pelanggan (jika ada)
  const customer = customers.find(c => c.nama.toLowerCase() === customerName.toLowerCase());
  const isVoucherMode = (loyaltySettings.rewardMode === 'voucher');
  
  let pointDiscount = 0;
  let voucherDiscount = 0;
  let redeemPoints = 0;
  let redeemVouchers = 0;
  const currentMonth = getCurrentMonthKey();

  if (isVoucherMode) {
    const redeemVoucherInput = document.getElementById('redeem-voucher-count');
    redeemVouchers = Math.max(0, parseInt(redeemVoucherInput ? redeemVoucherInput.value : 0) || 0);
    
    if (customer) {
      const vStats = getCustomerMonthlyVoucherStats(customer, currentMonth);
      if (redeemVouchers > vStats.remaining) {
        redeemVouchers = vStats.remaining;
      }
    } else {
      redeemVouchers = 0;
    }

    const rpPerVoucher = parseInt(loyaltySettings.voucherRpValue) || 10000;
    voucherDiscount = redeemVouchers * rpPerVoucher;
    if (voucherDiscount > globalTotal) {
      voucherDiscount = globalTotal;
    }
  } else {
    // Mode Poin
    const redeemInput = document.getElementById('redeem-points-input');
    redeemPoints = Math.max(0, parseInt(redeemInput ? redeemInput.value : 0) || 0);
    if (customer && redeemPoints > customer.poin) redeemPoints = customer.poin;
    pointDiscount = redeemPoints * (loyaltySettings.rpPerPoint || 100);
    if (pointDiscount > globalTotal) {
      pointDiscount = globalTotal;
      redeemPoints = Math.floor(globalTotal / (loyaltySettings.rpPerPoint || 100));
    }
  }
  
  const totalRewardDiscount = isVoucherMode ? voucherDiscount : pointDiscount;
  const finalTotalToPay = Math.max(0, globalTotal - totalRewardDiscount);
  
  const cashInput = document.getElementById('cash-received');
  const cashText = cashInput.value.replace(/\./g, ""); // Hapus titik ribuan
  const cash = parseFloat(cashText) || 0;
  
  if (status === 'Bon') {
    const custName = (document.getElementById('customer-name-input')?.value || '').trim();
    if (!custName || custName === 'Pelanggan Umum') {
      alert("⚠️ Transaksi Bon (Hutang) WAJIB memilih atau mengisi Nama Pelanggan terdaftar agar dapat ditagih!");
      const custInput = document.getElementById('customer-name-input');
      if (custInput) custInput.focus();
      return;
    }
  } else if (cash < finalTotalToPay) {
    alert("Pembayaran kurang!");
    return;
  }
  
  const change = status === 'Bon' ? (cash >= finalTotalToPay ? cash - finalTotalToPay : 0) : cash - finalTotalToPay;
  const sisaPiutang = status === 'Bon' ? (cash < finalTotalToPay ? finalTotalToPay - cash : 0) : 0;
  
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const yy = now.getFullYear().toString().slice(-2);
  // Format: jam(2) + menit(2) + detik(2) + tanggal(2) + bulan(2) + tahun(2) -> 12 digit (misal: 1353141026)
  const txId = `${hh}${mm}${ss}${dd}${MM}${yy}`;
  
  let jatuhTempo = null;
  let catatanBon = '';
  if (status === 'Bon') {
    jatuhTempo = document.getElementById('debt-due-date-input')?.value || null;
    catatanBon = (document.getElementById('debt-note-input')?.value || '').trim();
  }

  // Cek apakah pembayaran non-tunai ini diganti dengan uang cash ke laci
  const nonCashMethodsList = ['QRIS', 'Transfer', 'Debit'];
  const isNonCashMethod = nonCashMethodsList.includes(method);
  const replaceWithCash = isNonCashMethod 
    ? (document.getElementById('chk-replace-with-cash')?.checked === true) 
    : false;

  const transaction = {
    id: txId,
    waktu: now.toISOString(),
    items: [...cart],
    total: globalTotal,
    reward_mode: isVoucherMode ? 'voucher' : 'points',
    diskon_poin: pointDiscount, // Track diskon poin
    poin_ditukar: redeemPoints, // Track poin ditukar
    diskon_voucher: voucherDiscount, // Track diskon voucher
    voucher_ditukar: redeemVouchers, // Track voucher ditukar
    bayar: cash,
    kembalian: change,
    metode_pembayaran: method,
    diganti_cash: replaceWithCash, // Flag penggantian cash ke laci
    kasir: activeCashier,
    status_pembayaran: sisaPiutang > 0 ? 'Bon' : 'Lunas',
    nama_pelanggan: customerName, // Selalu catat jika ada
    sisa_piutang: sisaPiutang,
    jatuh_tempo: jatuhTempo,
    catatan_bon: catatanBon,
    riwayat_pelunasan: cash > 0 && status === 'Bon' ? [{
      waktu: now.toISOString(),
      bayar: Math.min(cash, finalTotalToPay),
      metode: method,
      kasir: activeCashier,
      catatan: 'Uang Muka / DP awal'
    }] : [],
    id_shift: activeShift ? activeShift.id_shift : null
  };
  
  // Update data reward pelanggan (Poin atau Voucher)
  if (customer) {
    if (isVoucherMode) {
      if (redeemVouchers > 0) {
        if (!customer.voucherUsage) customer.voucherUsage = {};
        if (!customer.voucherUsage[currentMonth]) {
          customer.voucherUsage[currentMonth] = { used: 0, transactions: [] };
        }
        customer.voucherUsage[currentMonth].used = (customer.voucherUsage[currentMonth].used || 0) + redeemVouchers;
        if (!Array.isArray(customer.voucherUsage[currentMonth].transactions)) {
          customer.voucherUsage[currentMonth].transactions = [];
        }
        customer.voucherUsage[currentMonth].transactions.push(txId);
      }
      // Catat sisa voucher bulan ini pada snapshot transaksi untuk struk
      const vStats = getCustomerMonthlyVoucherStats(customer, currentMonth);
      transaction.sisa_voucher_bulan_ini = vStats.remaining;
      transaction.kuota_voucher_bulan_ini = vStats.quota;
    } else {
      customer.poin = (customer.poin || 0) - redeemPoints; // Kurangi poin
      // Tambah poin baru berdasarkan total bayar
      const earnedPoints = Math.floor(finalTotalToPay / (loyaltySettings.pointsPerRp || 50000));
      customer.poin += earnedPoints;
      transaction.poin_didapat = earnedPoints; // Track poin didapat
    }
    
    saveCustomersLocally();
    saveCustomerCloud(customer);
    renderCustomersTable(); // Refresh tabel pelanggan di background
  }
  
  // Ambil snapshot produk dan pelanggan sebelum transaksi untuk proteksi rollback jika terjadi kegagalan sistem
  const productsSnapshot = JSON.parse(JSON.stringify(products));
  const customersSnapshot = JSON.parse(JSON.stringify(customers));

  // 1. Kurangi stok produk secara lokal (termasuk komponen dalam paket bundling)
  cart.forEach(cartItem => {
    if (cartItem.isBundle && Array.isArray(cartItem.bundleItems)) {
      cartItem.bundleItems.forEach(bComp => {
        const compProd = products.find(p => p.id === bComp.productId);
        if (compProd) {
          const totalCompPcs = (bComp.qty || 1) * (cartItem.qty || 1);
          compProd.stok = Math.max(0, compProd.stok - totalCompPcs);
        }
      });
    } else {
      const localProd = products.find(p => p.id === cartItem.id);
      if (localProd) {
        const pcsToDeduct = cartItem.isBox ? (cartItem.qty * (cartItem.isiBox || 1)) : (cartItem.isGrosir ? (cartItem.qty * (cartItem.grosirQty || 1)) : cartItem.qty);
        localProd.stok = Math.max(0, localProd.stok - pcsToDeduct);
        if (cartItem.isPromo && !cartItem.isBonus) {
          let prevKuota = parseInt(localProd.kuota_diskon) || 0;
          if (prevKuota > 0) {
            localProd.kuota_diskon = Math.max(0, prevKuota - cartItem.qty);
            if (localProd.kuota_diskon === 0) {
              localProd.harga_diskon = 0; // Disable promo once quota runs out
            }
          }
        }
      }
    }
  });

  // 2. Simpan transaksi ke riwayat lokal (unshift di awal agar ada di paling atas)
  transactions.unshift(transaction);

  try {
    saveProductsLocally();
    saveTransactionsLocally();
  } catch (storageErr) {
    // ROLLBACK ATOMIK: Kembalikan kondisi stok, pelanggan/poin, dan batalkan transaksi dari array
    products = productsSnapshot;
    customers = customersSnapshot;
    transactions.shift();
    saveProductsLocally();
    saveCustomersLocally();
    console.error("Gagal menyimpan transaksi/stok ke LocalStorage. Transaksi di-rollback:", storageErr);
    alert("⚠️ Gagal memproses transaksi: Penyimpanan perangkat mengalami error. Stok barang tidak dipotong.");
    return;
  }

  checkPromoBanner();
  renderTransactionsTable();
  updateAnalytics();

  // Bersihkan cache analitik lokal agar data analitik terbaru langsung diperbarui
  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('kasir_analytics_cache_')) {
        localStorage.removeItem(key);
      }
    });
  } catch (e) {}

  // Sync ke weeklyTrendData agar grafik 7 hari tetap akurat secara real-time
  if (weeklyTrendData.length > 0) {
    weeklyTrendData.push(transaction);
  }
  
  // 3. Tutup modal pembayaran & Kosongkan keranjang
  document.getElementById('payment-modal').classList.remove('active');
  const lastCart = [...cart];
  lastTransactionChange = change;
  cart = [];
  renderCart();
  
  // Reset input diskon
  document.getElementById('discount-input').value = 0;
  
  // 4. Tampilkan struk
  showReceipt(transaction, lastCart);
  
  // 5. Kirim langsung ke Firebase Realtime Database
  if (firebaseDb) {
    updateSyncStatus('syncing', 'Mengunggah transaksi...');
    try {
      const cleanTx = JSON.parse(JSON.stringify(transaction));
      const cloudUpdates = {};
      cloudUpdates[getStorePath('transactions/' + cleanTx.id)] = cleanTx;

      // Update stok produk & komponen paket bundling di RTDB toko
      if (Array.isArray(cleanTx.items)) {
        cleanTx.items.forEach(it => {
          if (it.isBundle && Array.isArray(it.bundleItems)) {
            it.bundleItems.forEach(bComp => {
              const compProd = products.find(p => String(p.id) === String(bComp.productId));
              if (compProd) {
                cloudUpdates[getStorePath('products/' + compProd.id + '/stok')] = compProd.stok;
              }
            });
          } else if (it.id) {
            const p = products.find(prod => String(prod.id) === String(it.id));
            if (p) {
              cloudUpdates[getStorePath('products/' + p.id + '/stok')] = p.stok;
              cloudUpdates[getStorePath('products/' + p.id + '/kuota_diskon')] = p.kuota_diskon || 0;
            }
          }
        });
      }

      await firebaseDb.ref('/').update(cloudUpdates);
      console.log('✅ Transaksi & stok berhasil masuk RTDB:', cleanTx.id, cleanTx.waktu);
      updateSyncStatus('online', 'Database Terhubung');
    } catch (syncErr) {
      console.error('❌ GAGAL simpan transaksi ke RTDB:', syncErr.message);
      updateSyncStatus('offline', 'Gagal: ' + syncErr.message);
    }
  } else {
    console.warn('⚠️ Firebase tidak terhubung. Transaksi hanya tersimpan lokal.');
    updateSyncStatus('offline', 'Firebase tidak terhubung');
  }

  } catch (err) {
    console.error('[Checkout] Error tidak terduga:', err);
    alert('Terjadi kesalahan saat memproses pembayaran. Silakan coba lagi.');
  } finally {
    // Reset flag dan aktifkan kembali tombol setelah proses selesai
    isCheckingOut = false;
    const btnSubmitFinal = document.getElementById('btn-submit-payment') || document.getElementById('btn-checkout-submit');
    if (btnSubmitFinal) btnSubmitFinal.disabled = false;
  }
}

// (Logika Countdown Struk Belanja Dihilangkan)

// --- RENDER STRUK TEKS POLOS (PLAIN TEXT) ---
function wrapText(text, maxChars) {
  if (!text) return [""];
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";
  
  words.forEach(word => {
    if ((currentLine + " " + word).trim().length <= maxChars) {
      currentLine = (currentLine + " " + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
      while (currentLine.length > maxChars) {
        lines.push(currentLine.substring(0, maxChars));
        currentLine = currentLine.substring(maxChars);
      }
    }
  });
  if (currentLine) lines.push(currentLine);
  return lines;
}

function centerText(text, width = 25) {
  if (!text) return " ".repeat(width);
  if (text.length >= width) return text.substring(0, width);
  const leftPadding = Math.floor((width - text.length) / 2);
  return " ".repeat(leftPadding) + text;
}

function formatLine(left, right, width = 25) {
  left = left || "";
  right = right || "";
  const spaceNeeded = width - left.length - right.length;
  if (spaceNeeded <= 0) {
    return left + " " + right;
  }
  return left + " ".repeat(spaceNeeded) + right;
}

function formatReceiptItemDisplay(item) {
  const itemTotal = item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty);

  // Deteksi Paket Bundling
  if (item.isBundle || (Array.isArray(item.bundleItems) && item.bundleItems.length > 0)) {
    const qty = item.qty || 1;
    let bItems = item.bundleItems || [];
    let totalNormalPerSet = Number(item.totalNormal) || 0;

    // Jika totalNormal belum tersimpan di item, hitung dari data bundle master atau produk
    if (totalNormalPerSet <= 0 && Array.isArray(bItems)) {
      totalNormalPerSet = bItems.reduce((acc, it) => acc + ((Number(it.normalPrice) || 0) * (Number(it.qty) || 1)), 0);
    }
    if (totalNormalPerSet <= 0 && typeof bundles !== 'undefined' && Array.isArray(bundles)) {
      const bObj = bundles.find(b => b.id === item.id);
      if (bObj && bObj.totalNormal) {
        totalNormalPerSet = bObj.totalNormal;
        if (!bItems || bItems.length === 0) bItems = bObj.items || [];
      }
    }

    const totalNormalAll = totalNormalPerSet * qty;
    const hematAll = Math.max(0, totalNormalAll - itemTotal);
    const hematPercent = totalNormalAll > 0 ? Math.round((hematAll / totalNormalAll) * 100) : 0;

    const compLines = (bItems || []).map(bi => {
      const perSetQty = Number(bi.qty) || 1;
      const totalCompQty = perSetQty * qty;
      const normalPr = Number(bi.normalPrice) || 0;
      return {
        name: bi.productName || 'Komponen',
        qty: totalCompQty,
        normalPrice: normalPr,
        subNormal: normalPr * totalCompQty
      };
    });

    const unitPrice = qty > 0 ? Math.round(itemTotal / qty) : item.harga;
    const lineDetail = `${qty} Paket @Rp ${formatRupiah(unitPrice)} = Rp ${formatRupiah(itemTotal)}`;

    return {
      isBundle: true,
      isBox: false,
      cleanName: item.nama || 'Paket Bundling',
      boxLabel: '',
      displayName: item.nama || 'Paket Bundling',
      totalPcs: qty,
      unitPcsPrice: unitPrice,
      itemTotal: itemTotal,
      lineDetail: lineDetail,
      totalNormal: totalNormalAll,
      totalHemat: hematAll,
      hematPercent: hematPercent,
      bundleComponents: compLines
    };
  }
  
  // Deteksi kemasan dus/kotak:
  // HANYA jika item memang dibeli sebagai kemasan dus/kotak (item.isBox === true, via scan barcode dus atau tombol +1 Dus).
  // JANGAN otomatis mengubah pembelian eceran (pcs) menjadi dus hanya karena produk memiliki data isi_box di master produk!
  let isBox = !!item.isBox;
  let isiBox = parseInt(item.isiBox) || 0;
  let namaBox = item.namaBox || '';
  let cleanName = item.nama || '';
  
  if (isBox) {
    // Bersihkan sufiks otomatis seperti "(1 Kotak @12 pcs)" jika ada
    cleanName = cleanName.replace(/\s*\(\d+\s*[^@)]+@\d+\s*pcs\)/gi, '').trim();
    if (!namaBox) {
      const localProd = (typeof products !== 'undefined' && Array.isArray(products)) 
        ? products.find(p => p.id === item.id) 
        : null;
      namaBox = (localProd && localProd.nama_box) ? localProd.nama_box : 'Dus';
    }
    if (!isiBox) {
      const localProd = (typeof products !== 'undefined' && Array.isArray(products)) 
        ? products.find(p => p.id === item.id) 
        : null;
      isiBox = (localProd && parseInt(localProd.isi_box)) || 1;
    }
  }

  if (isBox && isiBox > 0) {
    const boxQty = item.qty || 1;
    const totalPcs = boxQty * isiBox;
    const unitPcsPrice = totalPcs > 0 ? Math.round(itemTotal / totalPcs) : itemTotal;
    const boxLabel = `[${boxQty} ${namaBox}]`;
    const lineDetail = `${totalPcs}x @Rp ${formatRupiah(unitPcsPrice)} = Rp ${formatRupiah(itemTotal)}`;
    
    return {
      isBox: true,
      cleanName: cleanName,
      boxLabel: boxLabel,
      displayName: `${cleanName} ${boxLabel}`,
      totalPcs: totalPcs,
      unitPcsPrice: unitPcsPrice,
      itemTotal: itemTotal,
      lineDetail: lineDetail
    };
  }

  // Regular / Eceran
  const unitPrice = item.qty > 0 ? Math.round(itemTotal / item.qty) : item.harga;
  let dispName = item.nama || '';
  if (item.promoInfo) {
    dispName += ` [${item.promoInfo}]`;
  }
  const lineDetail = `${item.qty}x @Rp ${formatRupiah(unitPrice)} = Rp ${formatRupiah(itemTotal)}`;

  return {
    isBox: false,
    cleanName: item.nama || '',
    boxLabel: '',
    displayName: dispName,
    totalPcs: item.qty,
    unitPcsPrice: unitPrice,
    itemTotal: itemTotal,
    lineDetail: lineDetail
  };
}

function generatePlainTextReceipt(tx, items) {
  let width = receiptSettings.textWidth || 25; // Default 25 karakter
  document.documentElement.style.setProperty('--print-text-width', width);
  let text = "";
  
  // 1. Header: Nama Toko, Alamat & Telp Toko
  if (receiptSettings.showName && receiptSettings.name) {
    const nameLines = wrapText(receiptSettings.name.toUpperCase(), width);
    nameLines.forEach(line => {
      let indent = 0;
      if (receiptSettings.nameMarginLR > 0) {
        indent = Math.min(width - line.length, Math.round(receiptSettings.nameMarginLR / 2));
      }
      text += (indent > 0 ? " ".repeat(indent) + line : centerText(line, width)) + "\n";
    });
  }
  
  if (receiptSettings.showAddress && receiptSettings.address) {
    const addrLines = wrapText(receiptSettings.address, width);
    addrLines.forEach(line => {
      let indent = 0;
      if (receiptSettings.addressMarginLR > 0) {
        indent = Math.min(width - line.length, Math.round(receiptSettings.addressMarginLR / 2));
      }
      text += (indent > 0 ? " ".repeat(indent) + line : centerText(line, width)) + "\n";
    });
  }
  
  if (receiptSettings.showPhone && receiptSettings.phone) {
    const phoneStr = "Telp: " + receiptSettings.phone;
    const phoneLines = wrapText(phoneStr, width);
    phoneLines.forEach(line => {
      let indent = 0;
      if (receiptSettings.phoneMarginLR > 0) {
        indent = Math.min(width - line.length, Math.round(receiptSettings.phoneMarginLR / 2));
      }
      text += (indent > 0 ? " ".repeat(indent) + line : centerText(line, width)) + "\n";
    });
  }

  text += centerText("=".repeat(width), width) + "\n";
  
  // 2. Detail Transaksi
  text += formatLine("No.", tx.id, width) + "\n";
  
  const dateObj = new Date(tx.waktu);
  const dateStr = dateObj.toLocaleDateString('id-ID');
  const timeStr = dateObj.toLocaleTimeString('id-ID', { hour12: false });
  text += formatLine("Waktu", dateStr + " " + timeStr, width) + "\n";
  
  if (receiptSettings.showCashier) {
    text += formatLine("Kasir", tx.kasir || 'Kasir Utama', width) + "\n";
  }
  text += centerText("-".repeat(width), width) + "\n";
  
  // 3. Daftar Barang
  let subtotal = 0;
  items.forEach((item, index) => {
    const info = formatReceiptItemDisplay(item);
    subtotal += info.itemTotal;
    
    const nameLines = wrapText(info.displayName, width);
    nameLines.forEach(line => {
      text += line + "\n";
    });

    // Rincian Komponen, Harga Normal & Hemat untuk Paket Bundling
    if (info.isBundle && Array.isArray(info.bundleComponents) && info.bundleComponents.length > 0) {
      info.bundleComponents.forEach(comp => {
        const compLine = ` - ${comp.name} (${comp.qty}x)`;
        wrapText(compLine, width).forEach(cl => text += cl + "\n");
      });
      if (info.totalNormal > info.itemTotal) {
        text += formatLine(" Normal", "Rp " + formatRupiah(info.totalNormal), width) + "\n";
        text += formatLine(" Hemat", "-Rp " + formatRupiah(info.totalHemat) + ` (${info.hematPercent}%)`, width) + "\n";
      }
    }

    const qtyPriceStr = `${info.totalPcs}x @Rp ${formatRupiah(info.unitPcsPrice)} =`;
    const totalItemStr = `Rp ${formatRupiah(info.itemTotal)}`;
    const plainLineText = qtyPriceStr + " " + totalItemStr;
    const leftPadding = Math.floor((width - plainLineText.length) / 2);
    const paddedLine = " ".repeat(Math.max(0, leftPadding)) + qtyPriceStr + " <b>" + totalItemStr + "</b>";
    text += paddedLine + "\n";
    
    if (index < items.length - 1) {
      text += centerText("-".repeat(width), width) + "\n";
    }
  });
  text += centerText("-".repeat(width), width) + "\n";
  
  // 4. Kalkulasi Total
  if (receiptSettings.showSubtotal) {
    text += formatLine("Subtotal", "Rp " + formatRupiah(subtotal), width) + "\n";
  }
  if (receiptSettings.showDiscount) {
    const discountPercent = subtotal > 0 ? Math.round(((subtotal - tx.total) / subtotal) * 100) : 0;
    text += formatLine("Diskon", discountPercent + "%", width) + "\n";
  }
  if (tx.diskon_poin > 0) {
    text += formatLine("Tukar Poin", "-Rp " + formatRupiah(tx.diskon_poin), width) + "\n";
  }
  if (tx.diskon_voucher > 0) {
    text += formatLine("Tukar Voucher", "-Rp " + formatRupiah(tx.diskon_voucher), width) + "\n";
  }
  
  text += formatLine("Total", "Rp " + formatRupiah(tx.total), width) + "\n";
  text += formatLine("Bayar", "Rp " + formatRupiah(tx.bayar), width) + "\n";
  text += formatLine("Kembalian", "Rp " + formatRupiah(tx.kembalian), width) + "\n";
  
  if (receiptSettings.showMethod) {
    let methodStr = tx.metode_pembayaran || 'Tunai';
    if (tx.status_pembayaran === 'Bon') {
      methodStr += ' (Bon)';
    }
    text += formatLine("Metode", methodStr, width) + "\n";
  }
  
  if (tx.sisa_piutang > 0) {
    text += formatLine("Sisa Bon (Hutang)", "Rp " + formatRupiah(tx.sisa_piutang), width) + "\n";
  }
  
  // CRM Loyalitas (Poin atau Voucher)
  if (tx.nama_pelanggan) {
    text += centerText("-".repeat(width), width) + "\n";
    text += formatLine("Pelanggan", tx.nama_pelanggan, width) + "\n";
    
    if (tx.reward_mode === 'voucher' || tx.diskon_voucher > 0 || typeof tx.sisa_voucher_bulan_ini !== 'undefined') {
      let remainingVouchers = tx.sisa_voucher_bulan_ini;
      if (typeof remainingVouchers === 'undefined' && typeof customers !== 'undefined') {
        const customer = customers.find(c => c.nama === tx.nama_pelanggan);
        if (customer) {
          const vStats = getCustomerMonthlyVoucherStats(customer);
          remainingVouchers = vStats.remaining;
        }
      }
      if (tx.voucher_ditukar > 0) {
        text += formatLine("Voucher Dipakai", "" + tx.voucher_ditukar, width) + "\n";
      }
      text += formatLine("Sisa Voucher Bln Ini", "" + (remainingVouchers !== undefined ? remainingVouchers : 0), width) + "\n";
    } else {
      text += formatLine("Poin Didapat", "+" + (tx.poin_didapat || 0), width) + "\n";
      let customerPoinTotal = tx.poin_didapat || 0;
      if (typeof customers !== 'undefined') {
        const customer = customers.find(c => c.nama === tx.nama_pelanggan);
        if (customer) customerPoinTotal = customer.poin || 0;
      }
      text += formatLine("Total Poin", "" + customerPoinTotal, width) + "\n";
    }
  }
  
  text += centerText("=".repeat(width), width) + "\n";
  
  // 5. Footer
  const footerLines = [
    "Terima kasih atas kunjungan Anda!",
    "Barang yang sudah dibeli tidak dapat ditukar/dikembalikan"
  ];
  footerLines.forEach(line => {
    const wrapped = wrapText(line, width);
    wrapped.forEach(wLine => {
      text += centerText(wLine, width) + "\n";
    });
  });
  
  return text;
}

// Tampilkan Struk Belanja
function showReceipt(tx, items) {
  currentActiveReceiptTx = tx;
  currentActiveReceiptItems = items || tx.items || [];

  document.getElementById('rec-id').textContent = tx.id;
  
  const dateObj = new Date(tx.waktu);
  const timeStr = dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID', { hour12: false });
  document.getElementById('rec-time').textContent = timeStr;
  
  const cashierEl = document.getElementById('rec-cashier');
  if (cashierEl) cashierEl.textContent = tx.kasir || 'Kasir Utama';
  
  const recItems = document.getElementById('rec-items');
  recItems.innerHTML = '';
  
  let subtotal = 0;
  items.forEach((item, index) => {
    const info = formatReceiptItemDisplay(item);
    subtotal += info.itemTotal;
    const row = document.createElement('div');
    row.className = 'receipt-item-row';
    
    if (index < items.length - 1) {
      row.style.borderBottom = '1px dashed #ddd';
      row.style.paddingBottom = '0.4rem';
      row.style.marginBottom = '0.4rem';
    }
    
    let bundleDetailHtml = '';
    if (info.isBundle && Array.isArray(info.bundleComponents) && info.bundleComponents.length > 0) {
      const compItemsHtml = info.bundleComponents.map(c => `
        <div style="display:flex; justify-content:space-between; font-size:0.82rem; color:#475569; padding-left:0.5rem;">
          <span>• ${c.name} (${c.qty}x)</span>
          <span style="color:#64748b;">@Rp ${formatRupiah(c.normalPrice)}</span>
        </div>
      `).join('');

      let savingsHtml = '';
      if (info.totalNormal > info.itemTotal) {
        savingsHtml = `
          <div style="display:flex; justify-content:space-between; font-size:0.82rem; color:#059669; font-weight:700; padding-left:0.5rem; margin-top:2px;">
            <span style="text-decoration:line-through; color:#94a3b8; font-weight:normal;">Normal Rp ${formatRupiah(info.totalNormal)}</span>
            <span>Hemat Rp ${formatRupiah(info.totalHemat)} (${info.hematPercent}%)</span>
          </div>
        `;
      }

      bundleDetailHtml = `
        <div style="background:rgba(234,88,12,0.05); border:1px dashed rgba(234,88,12,0.25); border-radius:6px; padding:0.35rem 0.5rem; margin:0.3rem 0;">
          <div style="font-size:0.75rem; font-weight:700; color:#ea580c; margin-bottom:2px;">📦 Rincian Komponen Paket:</div>
          ${compItemsHtml}
          ${savingsHtml}
        </div>
      `;
    }

    row.innerHTML = `
      <div class="receipt-item-row-top" style="align-items: flex-start; justify-content: space-between;">
        <span style="flex: 1; padding-right: 0.5rem; word-break: break-word;">
          ${info.cleanName}${info.boxLabel ? ` <span style="font-weight: 700; color: #1e293b;">${info.boxLabel}</span>` : ''}${item.promoInfo ? ` <small style="color:#059669; font-weight:600;">[${item.promoInfo}]</small>` : ''}
        </span>
        <span style="font-weight: 700; white-space: nowrap;">Rp ${formatRupiah(info.itemTotal)}</span>
      </div>
      ${bundleDetailHtml}
      <div class="receipt-item-row-bottom" style="display: flex; justify-content: flex-end; font-size: 0.9em; font-weight: 500; color: #444; margin-top: 2px;">
        <span>${info.totalPcs}x @Rp ${formatRupiah(info.unitPcsPrice)} = Rp ${formatRupiah(info.itemTotal)}</span>
      </div>
    `;
    recItems.appendChild(row);
  });
  
  const discountPercent = subtotal > 0 ? Math.round(((subtotal - tx.total) / subtotal) * 100) : 0;
  
  document.getElementById('rec-subtotal').textContent = `Rp ${formatRupiah(subtotal)}`;
  document.getElementById('rec-discount').textContent = `${discountPercent}%`;
  document.getElementById('rec-total').textContent = `Rp ${formatRupiah(tx.total)}`;
  document.getElementById('rec-cash').textContent = `Rp ${formatRupiah(tx.bayar)}`;
  document.getElementById('rec-change').textContent = `Rp ${formatRupiah(tx.kembalian)}`;
  
  // Rincian Metode & Piutang (Fitur Baru)
  const ptRow = document.getElementById('rec-point-discount-row');
  if (ptRow) {
    if (tx.diskon_poin > 0) {
      document.getElementById('rec-point-discount').textContent = `-Rp ${formatRupiah(tx.diskon_poin)}`;
      ptRow.style.display = 'flex';
    } else {
      ptRow.style.display = 'none';
    }
  }

  const vcRow = document.getElementById('rec-voucher-discount-row');
  if (vcRow) {
    if (tx.diskon_voucher > 0) {
      document.getElementById('rec-voucher-discount').textContent = `-Rp ${formatRupiah(tx.diskon_voucher)}`;
      vcRow.style.display = 'flex';
    } else {
      vcRow.style.display = 'none';
    }
  }
  
  const crmInfo = document.getElementById('rec-crm-info');
  if (crmInfo) {
    if (tx.nama_pelanggan) {
      crmInfo.style.display = 'block';
      const customer = customers.find(c => c.nama === tx.nama_pelanggan);
      const isVoucherTx = (tx.reward_mode === 'voucher' || tx.diskon_voucher > 0 || typeof tx.sisa_voucher_bulan_ini !== 'undefined');
      
      const ptsBlock = document.getElementById('rec-crm-points-block');
      const vchBlock = document.getElementById('rec-crm-voucher-block');

      if (isVoucherTx) {
        if (ptsBlock) ptsBlock.style.display = 'none';
        if (vchBlock) {
          vchBlock.style.display = 'block';
          let remainingVouchers = tx.sisa_voucher_bulan_ini;
          if (typeof remainingVouchers === 'undefined' && customer) {
            remainingVouchers = getCustomerMonthlyVoucherStats(customer).remaining;
          }
          const usedEl = document.getElementById('rec-vouchers-used');
          const remEl = document.getElementById('rec-vouchers-remaining');
          if (usedEl) usedEl.textContent = `${tx.voucher_ditukar || 0} Voucher`;
          if (remEl) remEl.textContent = `${remainingVouchers !== undefined ? remainingVouchers : 0} Voucher`;
        }
      } else {
        if (vchBlock) vchBlock.style.display = 'none';
        if (ptsBlock) {
          ptsBlock.style.display = 'block';
          document.getElementById('rec-points-earned').textContent = tx.poin_didapat || 0;
          document.getElementById('rec-points-total').textContent = customer ? (customer.poin || 0) : (tx.poin_didapat || 0);
        }
      }
    } else {
      crmInfo.style.display = 'none';
    }
  }
  const methodEl = document.getElementById('rec-method');
  if (methodEl) {
    methodEl.textContent = tx.metode_pembayaran || 'Tunai';
    if (tx.status_pembayaran === 'Bon') {
      methodEl.textContent += ' (Bon)';
    }
  }
  
  const debtRow = document.getElementById('rec-debt-row');
  const debtVal = document.getElementById('rec-debt');
  if (debtRow && debtVal) {
    if (tx.sisa_piutang > 0) {
      debtVal.textContent = `Rp ${formatRupiah(tx.sisa_piutang)}`;
      debtRow.style.display = 'flex';
    } else {
      debtRow.style.display = 'none';
    }
  }
  
  // Render Plain Text Receipt Header & Body
  const textLogoContainer = document.getElementById('rec-text-logo-container');
  if (textLogoContainer) {
    if (receiptSettings.logo && receiptSettings.showLogo) {
      textLogoContainer.innerHTML = `<img src="${receiptSettings.logo}" alt="Logo" class="receipt-logo-img">`;
      textLogoContainer.style.display = 'flex';
    } else {
      textLogoContainer.innerHTML = '';
      textLogoContainer.style.display = 'none';
    }
  }
  
  const textBody = document.getElementById('rec-text-body');
  if (textBody) {
    textBody.innerHTML = generatePlainTextReceipt(tx, items);
  }
  
  document.getElementById('receipt-modal').classList.add('active');
  
  const cardPrint = document.getElementById('receipt-card-print');
  if (cardPrint) cardPrint.scrollTop = 0;
  
  // Set default pemilihan tombol struk ke "Cetak Nota" (index 0)
  selectedReceiptButtonIndex = 0;
  updateReceiptButtonsHighlight();
}

function updateReceiptButtonsHighlight() {
  const btnPrint = document.getElementById('btn-print-receipt');
  const btnWa = document.getElementById('btn-share-wa-receipt');
  const btnSkip = document.getElementById('btn-skip-receipt');
  if (!btnPrint || !btnSkip) return;
  
  // Reset style highlight
  btnPrint.style.outline = 'none';
  if (btnWa) btnWa.style.outline = 'none';
  btnSkip.style.outline = 'none';

  if (selectedReceiptButtonIndex === 0) {
    btnPrint.className = 'btn btn-primary';
    btnPrint.style.outline = '2px solid #2563eb';
    btnPrint.focus({ preventScroll: true });
  } else if (selectedReceiptButtonIndex === 1) {
    if (btnWa) {
      btnWa.style.outline = '2px solid #ffffff';
      btnWa.focus({ preventScroll: true });
    }
  } else {
    btnSkip.className = 'btn btn-secondary';
    btnSkip.style.outline = '2px solid #64748b';
    btnSkip.focus({ preventScroll: true });
  }
}

function closeReceiptModal() {
  document.getElementById('receipt-modal').classList.remove('active');
  focusSearchInput();
}

// Format dan bagikan nota belanja ke WhatsApp
function shareReceiptToWhatsApp(tx, items) {
  if (!tx) {
    alert('Data nota tidak ditemukan.');
    return;
  }
  const itemList = items || tx.items || [];
  const storeName = (receiptSettings.name || 'TOKO KASIR').trim();
  const storeAddress = (receiptSettings.address || '').trim();
  const storePhone = (receiptSettings.phone || '').trim();

  let msg = `🧾 *NOTA PEMBAYARAN*\n`;
  msg += `*${storeName.toUpperCase()}*\n`;
  if (storeAddress) msg += `${storeAddress}\n`;
  if (storePhone) msg += `Telp: ${storePhone}\n`;
  msg += `--------------------------------\n`;
  msg += `No. Nota : *${tx.id}*\n`;
  
  const dateObj = new Date(tx.waktu || Date.now());
  const dateStr = dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID', { hour12: false });
  msg += `Waktu    : ${dateStr}\n`;
  msg += `Kasir    : ${tx.kasir || 'Kasir Utama'}\n`;
  if (tx.nama_pelanggan) {
    msg += `Pelanggan: *${tx.nama_pelanggan}*\n`;
  }
  msg += `--------------------------------\n`;
  msg += `*DAFTAR PESANAN:*\n`;

  let subtotal = 0;
  itemList.forEach(it => {
    const info = formatReceiptItemDisplay(it);
    subtotal += info.itemTotal;
    const boxTag = info.boxLabel ? ` *${info.boxLabel}*` : '';
    msg += `• *${info.cleanName}*${boxTag}\n`;
    if (info.isBundle && Array.isArray(info.bundleComponents) && info.bundleComponents.length > 0) {
      info.bundleComponents.forEach(c => {
        msg += `   └ ${c.name} (${c.qty}x)\n`;
      });
      if (info.totalNormal > info.itemTotal) {
        msg += `   _Harga Normal: Rp ${formatRupiah(info.totalNormal)}_ (Hemat Rp ${formatRupiah(info.totalHemat)})\n`;
      }
    }
    msg += `   ${info.lineDetail}\n`;
  });

  msg += `--------------------------------\n`;
  if (subtotal !== tx.total) {
    msg += `Subtotal  : Rp ${formatRupiah(subtotal)}\n`;
  }
  if (tx.diskon_poin > 0) {
    msg += `Tukar Poin: -Rp ${formatRupiah(tx.diskon_poin)}\n`;
  }
  if (tx.diskon_voucher > 0) {
    msg += `Tukar Voucher: -Rp ${formatRupiah(tx.diskon_voucher)}\n`;
  }
  msg += `*TOTAL*    : *Rp ${formatRupiah(tx.total)}*\n`;
  msg += `Bayar     : Rp ${formatRupiah(tx.bayar)}\n`;
  
  if (tx.status_pembayaran === 'Bon') {
    msg += `Sisa Bon  : *Rp ${formatRupiah(tx.sisa_piutang)} (Belum Lunas)*\n`;
  } else {
    msg += `Kembalian : Rp ${formatRupiah(tx.kembalian)}\n`;
  }
  msg += `Metode    : ${tx.metode_pembayaran || 'Tunai'}\n`;

  if (tx.nama_pelanggan) {
    if (tx.reward_mode === 'voucher' || tx.diskon_voucher > 0 || typeof tx.sisa_voucher_bulan_ini !== 'undefined') {
      let remainingVouchers = tx.sisa_voucher_bulan_ini;
      if (typeof remainingVouchers === 'undefined' && typeof customers !== 'undefined') {
        const customer = customers.find(c => c.nama === tx.nama_pelanggan);
        if (customer) {
          remainingVouchers = getCustomerMonthlyVoucherStats(customer).remaining;
        }
      }
      if (tx.voucher_ditukar > 0) {
        msg += `Voucher Dipakai: ${tx.voucher_ditukar} Voucher\n`;
      }
      msg += `Sisa Voucher Bulan Ini: ${remainingVouchers !== undefined ? remainingVouchers : 0} Voucher\n`;
    } else if (tx.poin_didapat > 0) {
      msg += `Poin Baru : +${tx.poin_didapat}\n`;
    }
  }
  msg += `--------------------------------\n`;
  msg += `Terima kasih telah berbelanja di *${storeName}*! 🙏\n`;

  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

// Helper untuk tombol nota aktif
function shareCurrentReceiptToWhatsApp() {
  if (currentActiveReceiptTx) {
    shareReceiptToWhatsApp(currentActiveReceiptTx, currentActiveReceiptItems);
  } else {
    alert('Tidak ada nota transaksi yang sedang terbuka.');
  }
}

// Cetak Surat Jalan / Surat Pengiriman Barang untuk Transaksi Kasir
function printDeliveryNoteFromCurrentReceipt() {
  if (!currentActiveReceiptTx) {
    alert('Tidak ada nota transaksi yang sedang terbuka.');
    return;
  }
  printDeliveryNoteForTransaction(currentActiveReceiptTx, currentActiveReceiptItems);
}

// Fungsi reusable mencetak Surat Jalan Resmi
function printDeliveryNoteForTransaction(tx, items) {
  const itemList = items || tx.items || [];
  const storeName = (receiptSettings && receiptSettings.name) || 'KASIR POS';
  const storeAddress = (receiptSettings && receiptSettings.address) || '';
  const storePhone = (receiptSettings && receiptSettings.phone) || '';
  const customerName = tx.nama_pelanggan || 'Pelanggan Umum';
  const customerPhone = tx.telepon_pelanggan || '-';
  const txDate = tx.waktu ? parseTxDate(tx.waktu).toLocaleString('id-ID', { hour12: false }) : '-';

  let itemsRows = '';
  let totalQty = 0;
  itemList.forEach((item, idx) => {
    const qty = Number(item.qty) || 1;
    totalQty += qty;

    // Bersihkan nama produk dan tentukan satuan yang tepat
    let displayName = item.nama || 'Produk';
    let unit = 'pcs';

    if (item.isBox) {
      // Jika memang item kemasan box/dus
      unit = item.namaBox || item.boxUnitName || 'Dus';
      // Bersihkan teks sufiks redundan jika nama sudah mencakup (1 Dus @12 pcs)
      displayName = displayName.replace(/\s*\(\d+\s*[^@)]+@\d+\s*pcs\)/gi, '').trim();
      if (item.isiBox && item.isiBox > 1) {
        displayName += ` <span style="font-size: 11px; color: #475569; font-weight: normal;">(Isi ${item.isiBox} pcs/${unit})</span>`;
      }
    } else {
      // Eceran biasa
      unit = 'pcs';
    }

    itemsRows += `
      <tr>
        <td style="padding: 7px 8px; border: 1px solid #000; text-align: center;">${idx + 1}</td>
        <td style="padding: 7px 8px; border: 1px solid #000;">
          <strong>${displayName}</strong>
          ${item.promoInfo ? `<div style="font-size: 10px; color: #555;">${item.promoInfo}</div>` : ''}
        </td>
        <td style="padding: 7px 8px; border: 1px solid #000; text-align: center; font-weight: bold; font-size: 13px;">${qty} ${unit}</td>
        <td style="padding: 7px 8px; border: 1px solid #000; font-size: 11px;">[ &nbsp; ] Baik</td>
      </tr>
    `;
  });

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Surat Jalan Pengiriman - #${tx.id}</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, Helvetica, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #000; font-size: 12px; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 12px; }
        .store-info h2 { margin: 0 0 4px 0; font-size: 18px; text-transform: uppercase; }
        .doc-title { text-align: right; }
        .doc-title h3 { margin: 0 0 4px 0; font-size: 18px; color: #1e293b; letter-spacing: 0.05em; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; background: #f8fafc; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 6px; }
        table { width: 100%; border-collapse: collapse; margin-top: 5px; }
        th { background: #f1f5f9; padding: 8px; border: 1px solid #000; font-size: 11px; text-transform: uppercase; }
        .signatures { display: grid; grid-template-columns: 1fr 1fr 1fr; text-align: center; margin-top: 35px; font-size: 11px; }
        .sign-box { height: 60px; }
        @media print { body { padding: 5px; max-width: 100%; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="store-info">
          <h2>${storeName}</h2>
          <div>${storeAddress}</div>
          <div>Telp/WA: ${storePhone}</div>
        </div>
        <div class="doc-title">
          <h3>SURAT JALAN</h3>
          <div><b>No. DO:</b> SJ-${tx.id}</div>
          <div><b>Tanggal:</b> ${txDate}</div>
        </div>
      </div>

      <div class="info-grid">
        <div>
          <div style="font-weight: bold; margin-bottom: 3px; color: #475569;">TUJUAN PENGIRIMAN:</div>
          <div style="font-size: 13px; font-weight: bold;">${customerName}</div>
          <div>Telp/WA: ${customerPhone}</div>
          <div>Status Bayar: <b>${tx.status_pembayaran || 'Tunai'}</b></div>
        </div>
        <div>
          <div style="font-weight: bold; margin-bottom: 3px; color: #475569;">REFERENSI TRANSAKSI:</div>
          <div>No. Transaksi: <b>#${tx.id}</b></div>
          <div>Kasir: ${tx.kasir || 'Admin'}</div>
          <div>Metode: ${tx.metode_pembayaran || 'Tunai'}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width: 35px;">No</th>
            <th>Nama Barang / Deskripsi</th>
            <th style="width: 120px;">Jumlah / Kuantitas</th>
            <th style="width: 120px;">Kondisi Barang</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
          <tr>
            <td colspan="2" style="padding: 8px; border: 1px solid #000; text-align: right; font-weight: bold;">TOTAL JUMLAH FISIK BARANG:</td>
            <td style="padding: 8px; border: 1px solid #000; text-align: center; font-weight: bold; font-size: 13px;">${totalQty} Unit</td>
            <td style="border: 1px solid #000;"></td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top: 15px; font-size: 11px; color: #475569; line-height: 1.4;">
        <b>Catatan Pengiriman:</b> Mohon periksa jumlah dan kondisi fisik barang saat diterima. Barang yang telah diterima dengan tanda tangan pada surat jalan ini dinyatakan sah dan dalam kondisi baik.
      </div>

      <div class="signatures">
        <div>
          Pengirim / Toko:<br>
          <div class="sign-box"></div>
          ( ..................................... )
        </div>
        <div>
          Sopir / Kurir Antar:<br>
          <div class="sign-box"></div>
          ( ..................................... )
        </div>
        <div>
          Penerima / Pelanggan:<br>
          <div class="sign-box"></div>
          ( ..................................... )
        </div>
      </div>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 450);
  }
}

// Bagikan Rekap Penghasilan / Laporan Keuangan ke WhatsApp
function shareRevenueToWhatsApp() {
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  const filteredTxs = getAnalyticsFilteredTxs();

  let periodText = 'Hari Ini';
  if (filterType === 'hari') {
    const dateVal = document.getElementById('analytics-filter-date')?.value;
    periodText = dateVal ? `Hari Ini (${dateVal})` : 'Hari Ini';
  } else if (filterType === 'bulan') {
    const monthVal = document.getElementById('analytics-filter-month')?.value;
    periodText = monthVal ? `Bulan (${monthVal})` : 'Bulan Ini';
  } else if (filterType === 'tahun') {
    const yearVal = document.getElementById('analytics-filter-year')?.value;
    periodText = yearVal ? `Tahun ${yearVal}` : 'Tahun Ini';
  } else {
    periodText = 'Semua Waktu';
  }

  let revenue = 0;
  let netProfit = 0;
  const methodsBreakdown = { 'Tunai': 0, 'QRIS': 0, 'Debit': 0, 'Transfer': 0 };
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];

  filteredTxs.forEach(tx => {
    const metode = tx.metode_pembayaran || 'Tunai';
    const isNonCash = nonCashMethods.includes(metode);

    let txSubtotal = 0;
    let txNetProfitBeforeDiscount = 0;
    (tx.items || []).forEach(item => {
      const buyPrice = item.harga_beli || 0;
      const sellPrice = item.harga || 0;
      txNetProfitBeforeDiscount += (sellPrice - buyPrice) * item.qty;
      txSubtotal += sellPrice * item.qty;
    });

    const txDiscount = Math.max(0, txSubtotal - tx.total);
    const txNetProfit = txNetProfitBeforeDiscount - txDiscount;
    netProfit += txNetProfit;

    if (!isNonCash || tx.diganti_cash === true) {
      revenue += tx.total;
    }
    methodsBreakdown[metode] = (methodsBreakdown[metode] || 0) + tx.total;
  });

  let totalDebt = 0;
  transactions.forEach(tx => {
    totalDebt += (tx.sisa_piutang || 0);
  });

  const totalPenjualan = revenue - netProfit;
  const totalOmsetSemuaMetode = Object.values(methodsBreakdown).reduce((a, b) => a + b, 0);
  const storeName = (receiptSettings.name || 'TOKO KASIR').trim();

  let msg = `📊 *LAPORAN REKAP PENGHASILAN*\n`;
  msg += `*${storeName.toUpperCase()}*\n`;
  msg += `Periode : *${periodText}*\n`;
  msg += `Waktu   : ${new Date().toLocaleString('id-ID', { hour12: false })}\n`;
  msg += `--------------------------------\n`;
  msg += `💰 *RINGKASAN KEUANGAN:*\n`;
  msg += `• Total Transaksi : *${filteredTxs.length} Transaksi*\n`;
  msg += `• Penghasilan Tunai: *Rp ${formatRupiah(revenue)}*\n`;
  msg += `• Total Omset (Semua): *Rp ${formatRupiah(totalOmsetSemuaMetode)}*\n`;
  msg += `• Modal/HPP Penjualan : Rp ${formatRupiah(totalPenjualan)}\n`;
  msg += `• Laba Bersih : *Rp ${formatRupiah(netProfit)}*\n`;
  if (totalDebt > 0) {
    msg += `• Sisa Piutang (Bon) Aktif : Rp ${formatRupiah(totalDebt)}\n`;
  }
  msg += `--------------------------------\n`;
  msg += `💳 *RINCIAN METODE PEMBAYARAN:*\n`;
  Object.keys(methodsBreakdown).forEach(m => {
    if (methodsBreakdown[m] > 0) {
      msg += `• ${m}: Rp ${formatRupiah(methodsBreakdown[m])}\n`;
    }
  });
  msg += `--------------------------------\n`;
  msg += `_Laporan otomatis dibuat dari Sistem Kasir Toko._`;

  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

async function syncTransactionToCloud(tx) {
  if (firebaseDb) {
    try {
      await syncSingleTransactionToCloud(tx);
    } catch (e) {
      queueOfflineTransaction(tx);
    }
  } else {
    queueOfflineTransaction(tx);
  }
}

function queueOfflineTransaction(tx) {
  const alreadyQueued = offlineQueue.some(q => q.id === tx.id);
  if (alreadyQueued) {
    console.warn('[OfflineQueue] Transaksi sudah ada di antrean, dilewati:', tx.id);
    return;
  }
  offlineQueue.push(tx);
  saveOfflineQueue();
  updateSyncStatus('offline', `Offline (${offlineQueue.length} transaksi tertunda)`);
}

function saveOfflineQueue() {
  localStorage.setItem('kasir_offline_queue', JSON.stringify(offlineQueue));
}

let isProcessingOfflineQueue = false;

async function processOfflineQueue() {
  if (offlineQueue.length === 0 || !firebaseDb) return;
  if (isProcessingOfflineQueue) return;
  isProcessingOfflineQueue = true;
  
  updateSyncStatus('syncing', `Mengirim ${offlineQueue.length} antrean...`);
  
  const queueToProcess = [...offlineQueue];
  let successCount = 0;
  
  for (let i = 0; i < queueToProcess.length; i++) {
    const tx = queueToProcess[i];
    try {
      await syncSingleTransactionToCloud(tx);
      successCount++;
    } catch (e) {
      break;
    }
  }
  
  offlineQueue.splice(0, successCount);
  saveOfflineQueue();
  isProcessingOfflineQueue = false;
  
  if (offlineQueue.length === 0) {
    updateSyncStatus('online', 'Database Terhubung');
  } else {
    updateSyncStatus('offline', `Offline (${offlineQueue.length} transaksi tertunda)`);
  }
}

// --- TAB 3: FITUR KULAK (RESTOCK BARANG DATANG) ---

function filterKulakSearch() {
  const input = document.getElementById('kulak-search-input');
  const val = input.value.toLowerCase().trim();
  const dropdown = document.getElementById('kulak-floating-results');
  
  if (val === '') {
    closeKulakFloatingResults();
    return;
  }
  
  // Cek barcode match langsung
  const barcodeMatch = products.find(p => p.barcode && String(p.barcode).toLowerCase() === val);
  if (barcodeMatch) {
    openKulakForm(barcodeMatch);
    input.value = '';
    closeKulakFloatingResults();
    return;
  }
  
  let matched = products.filter(p => {
    return String(p.nama).toLowerCase().includes(val) || 
           String(p.id).toLowerCase().includes(val) ||
           (p.barcode && String(p.barcode).toLowerCase().includes(val));
  });
  
  matched.sort((a, b) => {
    const aNameMatch = String(a.nama).toLowerCase().includes(val);
    const bNameMatch = String(b.nama).toLowerCase().includes(val);
    if (aNameMatch && !bNameMatch) return -1;
    if (!aNameMatch && bNameMatch) return 1;
    return 0;
  });
  
  kulakFilteredProducts = matched.slice(0, 15);
  
  if (kulakFilteredProducts.length === 0) {
    dropdown.innerHTML = '<div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.85rem;">Barang tidak ditemukan...</div>';
    dropdown.classList.add('active');
    selectedKulakFloatIndex = -1;
    return;
  }
  
  selectedKulakFloatIndex = 0;
  renderKulakFloatingDropdown();
}

function renderKulakFloatingDropdown() {
  const dropdown = document.getElementById('kulak-floating-results');
  dropdown.innerHTML = '';
  dropdown.classList.add('active');
  
  kulakFilteredProducts.forEach((p, index) => {
    const isSelected = index === selectedKulakFloatIndex;
    const div = document.createElement('div');
    div.className = `floating-item ${isSelected ? 'selected' : ''}`;
    div.onclick = () => {
      openKulakForm(p);
    };
    
    const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=100';
    
    const rackBadgeHtml = p.rak 
      ? `<span style="display: inline-flex; align-items: center; gap: 0.2rem; background: rgba(79, 70, 229, 0.09); color: var(--color-primary); padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600;">📍 ${p.rak}</span>`
      : '';

    div.innerHTML = `
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="handleImageError(this)">
      <div class="floating-item-info">
        <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
          <span class="floating-item-name">${p.nama} (${p.id})</span>
          ${rackBadgeHtml}
        </div>
        <div class="floating-item-meta">
          <span class="floating-item-price">Beli: Rp ${formatRupiah(p.harga_beli)} | Jual: Rp ${formatRupiah(p.harga_jual)}</span>
          <span class="floating-item-stock">Stok: ${p.stok}</span>
        </div>
      </div>
    `;
    dropdown.appendChild(div);
  });
  
  const selectedEl = dropdown.querySelector('.floating-item.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function closeKulakFloatingResults() {
  const dropdown = document.getElementById('kulak-floating-results');
  if (dropdown) dropdown.classList.remove('active');
  kulakFilteredProducts = [];
  selectedKulakFloatIndex = -1;
}

function handleKulakSearchInputKeydowns(e) {
  if (kulakFilteredProducts.length === 0) return;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedKulakFloatIndex = (selectedKulakFloatIndex + 1) % kulakFilteredProducts.length;
    renderKulakFloatingDropdown();
  } 
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedKulakFloatIndex = (selectedKulakFloatIndex - 1 + kulakFilteredProducts.length) % kulakFilteredProducts.length;
    renderKulakFloatingDropdown();
  } 
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedKulakFloatIndex > -1 && selectedKulakFloatIndex < kulakFilteredProducts.length) {
      openKulakForm(kulakFilteredProducts[selectedKulakFloatIndex]);
    }
  }
}

// Buka form pengisian Kulak produk
function openKulakForm(p) {
  document.getElementById('kulak-edit-id').value = p.id;
  document.getElementById('kulak-prod-name').textContent = p.nama;
  document.getElementById('kulak-prod-id').textContent = `ID: ${p.id} | Barcode: ${p.barcode || '-'}`;
  document.getElementById('kulak-prod-current-stock').textContent = `Stok Saat Ini: ${p.stok} pcs`;
  
  const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=100';
  document.getElementById('kulak-prod-img').src = imgUrl;
  
  // Reset mode ke tambah stok default
  const addRadio = document.querySelector('input[name="kulak-mode"][value="add"]');
  if (addRadio) addRadio.checked = true;
  updateKulakModeUI();
  
  // Set default values form
  document.getElementById('kulak-qty-add').value = '';
  document.getElementById('kulak-price-buy').value = p.harga_beli;
  document.getElementById('kulak-price-sell').value = p.harga_jual;
  document.getElementById('kulak-date-expiry').value = p.tanggal_kadaluarsa || '';
  
  calculateKulakFinalStockPreview();
  
  document.getElementById('kulak-form-card').style.display = 'block';
  closeKulakFloatingResults();
  document.getElementById('kulak-search-input').value = '';
  
  // Fokuskan kursor ke input Stok
  setTimeout(() => {
    document.getElementById('kulak-qty-add').focus();
  }, 100);
}

function selectKulakMode(mode) {
  const radio = document.querySelector(`input[name="kulak-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  updateKulakModeUI();
  const inputEl = document.getElementById('kulak-qty-add');
  if (inputEl) inputEl.focus();
}

function updateKulakModeUI() {
  const mode = document.querySelector('input[name="kulak-mode"]:checked')?.value || 'add';
  const labelEl = document.getElementById('kulak-qty-label');
  const inputEl = document.getElementById('kulak-qty-add');
  
  // Update class active pada kartu pilihan
  const cardAdd = document.getElementById('card-mode-add');
  const cardSet = document.getElementById('card-mode-set');
  
  if (cardAdd && cardSet) {
    if (mode === 'add') {
      cardAdd.classList.add('active');
      cardSet.classList.remove('active');
    } else {
      cardSet.classList.add('active');
      cardAdd.classList.remove('active');
    }
  }
  
  if (mode === 'add') {
    if (labelEl) labelEl.textContent = 'Stok Tambahan Masuk*';
    if (inputEl) inputEl.placeholder = 'Misal: 24';
  } else {
    if (labelEl) labelEl.textContent = 'Total Stok Fisik di Rak Sekarang*';
    if (inputEl) inputEl.placeholder = 'Misal: 50';
  }
  calculateKulakFinalStockPreview();
}

function calculateKulakFinalStockPreview() {
  const id = document.getElementById('kulak-edit-id').value;
  const p = products.find(prod => prod.id === id);
  const currentStock = p ? (parseInt(p.stok) || 0) : 0;
  
  const mode = document.querySelector('input[name="kulak-mode"]:checked')?.value || 'add';
  const inputVal = parseInt(document.getElementById('kulak-qty-add').value);
  const previewEl = document.getElementById('kulak-final-stock-preview');
  if (!previewEl) return;
  
  if (isNaN(inputVal)) {
    previewEl.innerHTML = `Stok saat ini di sistem: <strong>${currentStock} pcs</strong>`;
    return;
  }
  
  if (mode === 'add') {
    const finalStock = currentStock + inputVal;
    previewEl.innerHTML = `Stok akhir di sistem: <strong>${finalStock} pcs</strong> <span style="color:var(--text-muted); font-size:0.8rem;">(${currentStock} + ${inputVal})</span>`;
  } else {
    const diff = inputVal - currentStock;
    const diffText = diff >= 0 ? `+${diff}` : `${diff}`;
    const diffColor = diff >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
    previewEl.innerHTML = `Stok diubah menjadi: <strong>${inputVal} pcs</strong> (<span style="color:${diffColor}; font-weight:700;">${diffText} pcs</span> dari stok lama)`;
  }
}

function closeKulakForm() {
  document.getElementById('kulak-form-card').style.display = 'none';
  document.getElementById('kulak-search-input').value = '';
  focusKulakSearch();
}

function saveKulak(e) {
  e.preventDefault();
  
  const id = document.getElementById('kulak-edit-id').value;
  const inputQty = parseInt(document.getElementById('kulak-qty-add').value);
  if (isNaN(inputQty) || inputQty < 0) {
    alert('Jumlah stok tidak boleh kosong atau negatif.');
    return;
  }
  
  const mode = document.querySelector('input[name="kulak-mode"]:checked')?.value || 'add';
  const newBuyPrice = parseFloat(document.getElementById('kulak-price-buy').value) || 0;
  const newSellPrice = parseFloat(document.getElementById('kulak-price-sell').value) || 0;
  const newExpiry = document.getElementById('kulak-date-expiry').value;
  
  const p = products.find(prod => prod.id === id);
  if (p) {
    const oldPrice = p.harga_jual;
    const isPriceIncreased = newSellPrice > oldPrice;
    
    if (mode === 'add') {
      p.stok = p.stok + inputQty;
    } else {
      p.stok = inputQty; // Set langsung stok di rak
    }
    
    p.harga_beli = newBuyPrice;
    p.harga_jual = newSellPrice;
    p.tanggal_kadaluarsa = newExpiry;
    
    saveProductsLocally();
    alert(`Berhasil memperbarui stok! Stok "${p.nama}" sekarang menjadi ${p.stok} pcs.`);
    closeKulakForm();
    
    // Sinkronkan ke cloud secara individual (Incremental)
    if (firebaseDb) {
      saveProductCloud(p);
    }

    if (isPriceIncreased) {
      showPriceChangeNotification(p, oldPrice, newSellPrice);
    }
  }
}

// Sinkronisasi diam-diam di background (Kulak / Edit barang)
async function syncProductsToCloudBackground() {
  if (!firebaseDb) return;
  try {
    const updates = {};
    products.forEach(p => { updates[getStorePath('products/' + p.id)] = JSON.parse(JSON.stringify(p)); });
    await firebaseDb.ref('/').update(updates);
  } catch (err) {
    console.warn('Gagal sync background produk ke RTDB:', err);
  }
}

// =============================================
// FITUR: EDIT SEMUA STOK & HARGA (BULK EDIT)
// =============================================

function openBulkEdit() {
  document.getElementById('kulak-bulk-edit-card').style.display = 'block';
  document.getElementById('bulk-edit-search').value = '';
  renderBulkEditTable();
  // Scroll ke card bulk edit
  setTimeout(() => {
    document.getElementById('kulak-bulk-edit-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

function closeBulkEdit() {
  document.getElementById('kulak-bulk-edit-card').style.display = 'none';
}

function renderBulkEditTable() {
  const tbody = document.getElementById('bulk-edit-table-body');
  if (!tbody) return;
  
  const modeSelect = document.getElementById('bulk-edit-mode');
  const mode = modeSelect ? modeSelect.value : 'add';
  
  const thStock = document.getElementById('bulk-edit-th-stock');
  if (thStock) {
    thStock.textContent = mode === 'add' ? '➕ Tambah Stok' : '📝 Set Stok di Rak';
  }
  
  const searchVal = (document.getElementById('bulk-edit-search').value || '').toLowerCase().trim();
  
  const filtered = products.filter(p =>
    String(p.nama).toLowerCase().includes(searchVal) ||
    String(p.id).toLowerCase().includes(searchVal) ||
    (p.kategori && String(p.kategori).toLowerCase().includes(searchVal))
  );
  
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">Tidak ada produk ditemukan.</td></tr>`;
    return;
  }
  
  filtered.forEach(p => {
    const tr = document.createElement('tr');
    tr.dataset.productId = p.id;
    
    const qtyDefaultVal = mode === 'add' ? '0' : p.stok;
    const qtyPlaceholder = mode === 'add' ? '+0' : `${p.stok}`;
    
    tr.innerHTML = `
      <td><strong style="font-size: 0.8rem;">${p.id}</strong></td>
      <td style="font-weight: 600;">${p.nama}</td>
      <td><span class="cat-btn" style="cursor:default; margin:0; font-size:0.75rem;">${p.kategori || 'Umum'}</span></td>
      <td style="text-align: center; font-weight: 700; color: ${p.stok <= 2 ? 'var(--color-danger)' : p.stok <= 10 ? '#b45309' : 'var(--color-success)'};">
        ${p.stok} pcs
      </td>
      <td>
        <input type="number" class="bulk-edit-qty" data-id="${p.id}" min="0" value="${qtyDefaultVal}"
          placeholder="${qtyPlaceholder}"
          style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-family: var(--font-main); font-size: 0.85rem; background: var(--bg-card); color: var(--text-main); outline: none; text-align: center;"
          onfocus="this.select()">
      </td>
      <td>
        <input type="number" class="bulk-edit-buy" data-id="${p.id}" min="0" value="${p.harga_beli}"
          style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-family: var(--font-main); font-size: 0.85rem; background: var(--bg-card); color: var(--text-main); outline: none;"
          onfocus="this.select()">
      </td>
      <td>
        <input type="number" class="bulk-edit-sell" data-id="${p.id}" min="0" value="${p.harga_jual}"
          style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-family: var(--font-main); font-size: 0.85rem; background: var(--bg-card); color: var(--text-main); outline: none;"
          onfocus="this.select()">
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveBulkEdit() {
  const modeSelect = document.getElementById('bulk-edit-mode');
  const mode = modeSelect ? modeSelect.value : 'add';
  
  let changedCount = 0;
  
  // Ambil semua baris di tabel bulk edit
  const qtyInputs = document.querySelectorAll('.bulk-edit-qty');
  
  qtyInputs.forEach(input => {
    const id = input.dataset.id;
    const p = products.find(prod => prod.id === id);
    if (!p) return;
    
    const qtyVal = parseInt(input.value);
    const buyRow = document.querySelector(`.bulk-edit-buy[data-id="${id}"]`);
    const sellRow = document.querySelector(`.bulk-edit-sell[data-id="${id}"]`);
    
    const newBuy = parseFloat(buyRow ? buyRow.value : p.harga_beli) || p.harga_beli;
    const newSell = parseFloat(sellRow ? sellRow.value : p.harga_jual) || p.harga_jual;
    
    let isStockChanged = false;
    let newStock = p.stok;
    
    if (!isNaN(qtyVal)) {
      if (mode === 'add' && qtyVal !== 0) {
        newStock = Math.max(0, p.stok + qtyVal);
        isStockChanged = true;
      } else if (mode === 'set' && qtyVal !== p.stok) {
        newStock = Math.max(0, qtyVal);
        isStockChanged = true;
      }
    }
    
    const validBuy = Math.max(0, newBuy);
    const validSell = Math.max(0, newSell);
    const isPriceChanged = validBuy !== p.harga_beli || validSell !== p.harga_jual;
    
    if (isStockChanged || isPriceChanged) {
      p.stok = newStock;
      p.harga_beli = validBuy;
      p.harga_jual = validSell;
      changedCount++;
    }
  });
  
  if (changedCount === 0) {
    alert('Tidak ada perubahan yang terdeteksi.');
    return;
  }
  
  saveProductsLocally();
  renderBulkEditTable(); // Refresh tabel agar stok sekarang terupdate
  
  // Sync ke cloud RTDB
  if (firebaseDb) {
    updateSyncStatus('syncing', 'Menyimpan perubahan ke database...');
    const updates = {};
    products.forEach(p => {
      updates[getStorePath('products/' + p.id)] = JSON.parse(JSON.stringify(p));
    });
    firebaseDb.ref('/').update(updates).then(() => {
      updateSyncStatus('online', 'Database Terhubung');
    }).catch(err => {
      console.error('Gagal simpan massal ke RTDB:', err);
      updateSyncStatus('offline', 'Koneksi Gagal');
    });
  }
  alert(`✅ Berhasil menyimpan perubahan pada ${changedCount} produk!`);
}

let currentProductPage = 1;

// Render Tabel Produk (Mendukung filter pencarian lokal & pembatasan render)
function renderProductsTable(highlightProductId = null) {
  const tbody = document.getElementById('products-table-body');
  tbody.innerHTML = '';
  
  if (highlightProductId) {
    lastScannedProductId = highlightProductId;
  }
  
  // Reset checkbox master awal
  const selectAllCb = document.getElementById('select-all-products');
  if (selectAllCb) selectAllCb.checked = false;
  
  const searchVal = document.getElementById('product-list-search').value.toLowerCase().trim();
  const catFilterEl = document.getElementById('product-list-category-filter');
  const catFilterVal = catFilterEl ? catFilterEl.value : 'All';
  const rackFilterEl = document.getElementById('product-list-rack-filter');
  const rackFilterVal = rackFilterEl ? rackFilterEl.value : 'All';
  
  if (searchVal !== '') {
    lastScannedProductId = null;
  }
  
  let targetProduct = (searchVal === '' && catFilterVal === 'All' && rackFilterVal === 'All' && lastScannedProductId) ? products.find(p => p.id === lastScannedProductId) : null;
  if (lastScannedProductId && !targetProduct && searchVal === '') {
    lastScannedProductId = null;
  }
  
  let matched = [];
  if (targetProduct) {
    matched = [targetProduct];
  } else {
    matched = products.filter(p => {
      // Filter kategori
      if (catFilterVal !== 'All') {
        const prodCat = (p.kategori || 'Umum').toLowerCase();
        if (prodCat !== catFilterVal.toLowerCase()) return false;
      }

      // Filter lokasi rak
      if (rackFilterVal !== 'All') {
        const prodRack = (p.rak || '').trim();
        if (rackFilterVal === '__NONE__') {
          if (prodRack !== '') return false;
        } else {
          if (prodRack.toLowerCase() !== rackFilterVal.toLowerCase()) return false;
        }
      }

      // Filter search teks / barcode / rak
      if (!searchVal) return true;
      return String(p.nama).toLowerCase().includes(searchVal) || 
             String(p.id).toLowerCase().includes(searchVal) ||
             (p.barcode && String(p.barcode).toLowerCase().includes(searchVal)) ||
             (p.rak && String(p.rak).toLowerCase().includes(searchVal)) ||
             (p.kategori && String(p.kategori).toLowerCase().includes(searchVal));
    });
  }
  
  // Sort produk jika bukan hasil tunggal dari scan barcode
  const sortSelect = document.getElementById('product-list-sort');
  if (sortSelect && !targetProduct) {
    const sortValue = sortSelect.value;
    matched.sort((a, b) => {
      if (sortValue === 'rack_asc') {
        const rackA = a.rak || 'ZZZZ';
        const rackB = b.rak || 'ZZZZ';
        const cmp = rackA.localeCompare(rackB);
        return cmp !== 0 ? cmp : a.nama.localeCompare(b.nama);
      } else if (sortValue === 'rack_desc') {
        const rackA = a.rak || '';
        const rackB = b.rak || '';
        const cmp = rackB.localeCompare(rackA);
        return cmp !== 0 ? cmp : a.nama.localeCompare(b.nama);
      } else if (sortValue === 'name_asc') {
        return a.nama.localeCompare(b.nama);
      } else if (sortValue === 'name_desc') {
        return b.nama.localeCompare(a.nama);
      } else if (sortValue === 'category_asc') {
        const catA = a.kategori || 'ZZZ';
        const catB = b.kategori || 'ZZZ';
        return catA.localeCompare(catB);
      } else if (sortValue === 'category_desc') {
        const catA = a.kategori || 'ZZZ';
        const catB = b.kategori || 'ZZZ';
        return catB.localeCompare(catA);
      } else if (sortValue === 'stock_asc') {
        return a.stok - b.stok;
      } else if (sortValue === 'stock_desc') {
        return b.stok - a.stok;
      } else if (sortValue === 'price_asc') {
        return a.harga_jual - b.harga_jual;
      } else if (sortValue === 'price_desc') {
        return b.harga_jual - a.harga_jual;
      }
      
      if (searchVal) {
        const aNameMatch = String(a.nama).toLowerCase().includes(searchVal);
        const bNameMatch = String(b.nama).toLowerCase().includes(searchVal);
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
      }
      
      return 0;
    });
    
    if (sortValue === 'newest') {
      matched.reverse();
    }
  }
  
  const totalCount = matched.length;
  
  // Tampilkan keterangan hasil filter
  const countHelpEl = document.getElementById('table-search-count');
  
  // Logika Pagination
  const ITEMS_PER_PAGE = 10;
  const paginationEl = document.getElementById('products-pagination');
  
  let itemsToRender;
  
  if (targetProduct) {
    // Jika hasil scan barcode, tampilkan 1 produk saja, sembunyikan pagination
    itemsToRender = matched;
    if (paginationEl) paginationEl.style.display = 'none';
    countHelpEl.innerHTML = `<span style="color:var(--color-success); font-weight:600;">✓ Hasil scan barcode: ${targetProduct.nama} (ID: ${targetProduct.id} | Stok: ${targetProduct.stok} pcs | Barcode: ${targetProduct.barcode || '-'})</span>`;
  } else if (searchVal !== '') {
    // Saat ada pencarian, tampilkan semua hasil (max 50), sembunyikan pagination
    itemsToRender = matched.slice(0, 50);
    if (paginationEl) paginationEl.style.display = 'none';
    if (totalCount > 50) {
      countHelpEl.textContent = `Ditemukan ${totalCount} barang yang cocok. Menampilkan 50 barang teratas (ketik kata kunci lebih spesifik untuk mempersempit).`;
    } else {
      countHelpEl.textContent = `Ditemukan ${totalCount} barang yang cocok.`;
    }
  } else {
    // Mode default: pagination 10 per halaman
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
    // Pastikan currentProductPage valid
    if (typeof currentProductPage === 'undefined' || currentProductPage < 1) currentProductPage = 1;
    if (currentProductPage > totalPages) currentProductPage = totalPages || 1;
    
    const startIdx = (currentProductPage - 1) * ITEMS_PER_PAGE;
    const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, totalCount);
    itemsToRender = matched.slice(startIdx, endIdx);
    
    countHelpEl.textContent = `Menampilkan ${startIdx + 1}–${endIdx} dari total ${totalCount} barang.`;
    
    // Render pagination
    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.style.display = 'none';
      } else {
        paginationEl.style.display = 'flex';
        renderProductsPagination(totalPages, currentProductPage);
      }
    }
  }
  
  if (itemsToRender.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;">Barang tidak ditemukan.</td></tr>`;
    return;
  }
  
  itemsToRender.forEach((p, index) => {
    // Cari index asli produk di array
    const originalIndex = products.findIndex(prod => prod.id === p.id);
    const tr = document.createElement('tr');
    if (targetProduct && p.id === targetProduct.id) {
      tr.classList.add('tr-scan-highlight');
      setTimeout(() => {
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
    
    const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=100';
    
    // Tampilkan label kadaluarsa merah jika lewat tanggal, atau orange jika kurang dari 30 hari
    let expBadge = p.tanggal_kadaluarsa || '-';
    if (p.tanggal_kadaluarsa) {
      const expDate = new Date(p.tanggal_kadaluarsa);
      const diffDays = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) {
        expBadge = `<span style="color:var(--color-danger); font-weight:700;">${p.tanggal_kadaluarsa} (KADALUARSA)</span>`;
      } else if (diffDays <= 30) {
        expBadge = `<span style="color:#b45309; font-weight:700;">${p.tanggal_kadaluarsa} (${diffDays} hari lagi)</span>`;
      }
    }
    
    let barcodeDisplay = `<span style="font-family: monospace;">${p.barcode || '-'}</span>`;
    if (p.barcode_box) {
      barcodeDisplay += `<br><span style="font-size:0.75rem; color:var(--color-primary); font-weight:600; display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="package" style="width:12px; height:12px;"></i> ${p.barcode_box} (${p.nama_box || 'Kotak'})</span>`;
    }
    
    let rackDisplay = p.rak 
      ? `<span style="font-weight:600; color:var(--color-primary); background:rgba(79,70,229,0.08); padding:0.15rem 0.45rem; border-radius:4px; font-size:0.82rem; white-space:nowrap; display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="map-pin" style="width:12px; height:12px;"></i> ${p.rak}</span>`
      : `<span style="color:var(--text-muted); font-size:0.8rem;">-</span>`;
    
    let hargaJualDisplay = `Rp ${formatRupiah(p.harga_jual)}`;
    if ((parseInt(p.isi_box) || 0) > 1 && (parseFloat(p.harga_box) || 0) > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:var(--color-primary); font-weight:600; background:rgba(79,70,229,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-flex; align-items:center; gap:0.25rem; margin-top:0.2rem;"><i data-lucide="package" style="width:12px; height:12px;"></i> 1 ${p.nama_box || 'Kotak'} (${p.isi_box} pcs): Rp ${formatRupiah(p.harga_box)}</span>`;
    }
    if (p.grosir_qty > 0 && p.grosir_harga > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:#2563eb; font-weight:600; background:rgba(37,99,235,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-flex; align-items:center; gap:0.25rem; margin-top:0.2rem;"><i data-lucide="tag" style="width:12px; height:12px;"></i> Grosir: ${p.grosir_qty} pcs = Rp ${formatRupiah(p.grosir_harga)}</span>`;
    }
    if (p.promo_beli_x > 0 && p.promo_gratis_y > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:#059669; font-weight:600; background:rgba(16,185,129,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-flex; align-items:center; gap:0.25rem; margin-top:0.2rem;"><i data-lucide="gift" style="width:12px; height:12px;"></i> Beli ${p.promo_beli_x} Gratis ${p.promo_gratis_y}</span>`;
    }
    
    tr.innerHTML = `
      <td style="text-align: center; padding: 0.5rem;">
        <input type="checkbox" class="product-select-checkbox" data-id="${p.id}" onclick="toggleProductSelection('${p.id}', this)" ${selectedProductIds.has(p.id) ? 'checked' : ''} style="cursor: pointer; transform: scale(1.15);">
      </td>
      <td>
        <img src="${imgUrl}" alt="${p.nama}" class="prod-table-img" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="handleImageError(this)">
      </td>
      <td><strong>${p.id}</strong></td>
      <td>${p.nama}</td>
      <td><span class="cat-btn" style="cursor:default; margin:0;">${p.kategori || 'Umum'}</span></td>
      <td>Rp ${formatRupiah(p.harga_beli)}</td>
      <td>${hargaJualDisplay}</td>
      <td>${p.stok}</td>
      <td>${barcodeDisplay}</td>
      <td>${rackDisplay}</td>
      <td>${expBadge}</td>
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="action-icon-btn btn-edit" onclick="editProduct(${originalIndex})" title="Edit">
            <i data-lucide="edit-3" class="icon-sm"></i>
          </button>
          <button class="action-icon-btn btn-edit" onclick="openPrintLabelModal('${p.id}')" title="Cetak Label Harga" style="color: var(--color-success); background-color: rgba(16,185,129,0.1);">
            <i data-lucide="printer" class="icon-sm"></i>
          </button>
          <button class="action-icon-btn btn-delete" onclick="deleteProduct(${originalIndex})" title="Hapus">
            <i data-lucide="trash-2" class="icon-sm"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  // Sinkronkan tombol cetak massal dan checkbox master berdasarkan item yang baru saja di-render
  updateBulkActionButtonState();
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

// Render tombol-tombol pagination
function renderProductsPagination(totalPages, currentPage) {
  const paginationEl = document.getElementById('products-pagination');
  if (!paginationEl) return;
  paginationEl.innerHTML = '';

  const btnStyle = (active) => `
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 2.1rem; height: 2.1rem; padding: 0 0.5rem;
    border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border-color);
    background: ${active ? '#ea580c' : 'var(--bg-card, #fff)'};
    color: ${active ? '#fff' : 'var(--text-main)'};
    transition: all 0.15s;
    font-family: var(--font-main);
  `;

  const makeBtn = (label, page, active = false, disabled = false) => {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.style.cssText = btnStyle(active);
    if (disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    }
    if (!disabled && !active) {
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-body, #f1f5f9)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-card, #fff)'; });
    }
    if (!disabled) {
      btn.onclick = () => { currentProductPage = page; renderProductsTable(); };
    }
    return btn;
  };

  // Tombol « Sebelumnya
  paginationEl.appendChild(makeBtn('&#8249;', currentPage - 1, false, currentPage === 1));

  // Nomor halaman dengan ellipsis
  const pageRange = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageRange.push(i);
  } else {
    pageRange.push(1);
    if (currentPage > 4) pageRange.push('...');
    const start = Math.max(2, currentPage - 2);
    const end = Math.min(totalPages - 1, currentPage + 2);
    for (let i = start; i <= end; i++) pageRange.push(i);
    if (currentPage < totalPages - 3) pageRange.push('...');
    pageRange.push(totalPages);
  }

  pageRange.forEach(item => {
    if (item === '...') {
      const ellipsis = document.createElement('span');
      ellipsis.textContent = '...';
      ellipsis.style.cssText = 'padding: 0 0.25rem; color: var(--text-muted); font-weight: 600;';
      paginationEl.appendChild(ellipsis);
    } else {
      paginationEl.appendChild(makeBtn(item, item, item === currentPage));
    }
  });

  // Tombol » Berikutnya
  paginationEl.appendChild(makeBtn('&#8250;', currentPage + 1, false, currentPage === totalPages));
}

function handleProductListSearchKeydowns(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = document.getElementById('product-list-search');
    const searchVal = input.value.trim();
    if (!searchVal) return;
    
    // Cari produk berdasarkan barcode eceran, barcode kotak, atau ID
    const exactMatch = products.find(p => 
      (p.barcode && String(p.barcode).toLowerCase() === searchVal.toLowerCase()) || 
      (p.has_unit_box && p.barcode_box && String(p.barcode_box).toLowerCase() === searchVal.toLowerCase()) ||
      String(p.id).toLowerCase() === searchVal.toLowerCase()
    );
    
    if (exactMatch) {
      playBeep();
      input.value = ''; // Hilangkan teks setelah produk ditemukan
      renderProductsTable(exactMatch.id);
      focusProductListSearch();
    } else {
      const matched = products.filter(p => 
        String(p.nama).toLowerCase().includes(searchVal.toLowerCase()) || 
        (p.kategori && String(p.kategori).toLowerCase().includes(searchVal.toLowerCase()))
      );
      if (matched.length === 1) {
        playBeep();
        input.value = ''; // Hilangkan teks setelah produk ditemukan
        renderProductsTable(matched[0].id);
        focusProductListSearch();
      } else if (matched.length > 1) {
        renderProductsTable();
        focusProductListSearch();
      } else {
        alert(`Barcode/Produk "${searchVal}" tidak terdaftar di inventaris!`);
        focusProductListSearch();
      }
    }
  }
}

let productListSearchTimeout;
function filterProductListTable() {
  clearTimeout(productListSearchTimeout);
  productListSearchTimeout = setTimeout(() => {
    const inputVal = document.getElementById('product-list-search').value.trim();
    if (inputVal !== '') {
      lastScannedProductId = null;
    }
    currentProductPage = 1; // Reset ke halaman pertama saat filter berubah
    renderProductsTable();
  }, 250);
}

function saveProduct(event) {
  event.preventDefault();
  
  const editIndex = parseInt(document.getElementById('edit-index').value);
  const idInput = document.getElementById('prod-id').value.trim();
  const nameInput = document.getElementById('prod-name').value.trim();
  const categoryInput = document.getElementById('prod-category').value.trim() || 'Umum';
  const priceBuyInput = parseFloat(document.getElementById('prod-price-buy').value) || 0;
  const priceSellInput = parseFloat(document.getElementById('prod-price-sell').value) || 0;
  const stockInput = parseInt(document.getElementById('prod-stock').value) || 0;
  const barcodeInput = document.getElementById('prod-barcode').value.trim();
  const rackInput = document.getElementById('prod-rack') ? document.getElementById('prod-rack').value.trim() : '';
  const expiryInput = document.getElementById('prod-expiry').value;
  const imageInput = document.getElementById('prod-image').value.trim();
  const promoPriceInput = parseFloat(document.getElementById('prod-promo-price').value) || 0;
  const promoQuotaEl = document.getElementById('prod-promo-quota');
  const promoQuotaInput = promoQuotaEl ? (parseInt(promoQuotaEl.value) || 0) : 0;
  const chkGrosir = document.getElementById('chk-prod-enable-grosir');
  const isGrosirActive = chkGrosir ? chkGrosir.checked : false;
  const grosirQtyInput = isGrosirActive ? ((parseInt(document.getElementById('prod-grosir-qty') ? document.getElementById('prod-grosir-qty').value : 0) || 0)) : 0;
  const grosirPriceInput = isGrosirActive ? ((parseFloat(document.getElementById('prod-grosir-price') ? document.getElementById('prod-grosir-price').value : 0) || 0)) : 0;

  const chkBuyGet = document.getElementById('chk-prod-enable-buy-get');
  const isBuyGetActive = chkBuyGet ? chkBuyGet.checked : false;
  const promoBuyXInput = isBuyGetActive ? ((parseInt(document.getElementById('prod-promo-buy-x') ? document.getElementById('prod-promo-buy-x').value : 0) || 0)) : 0;
  const promoGetYInput = isBuyGetActive ? ((parseInt(document.getElementById('prod-promo-get-y') ? document.getElementById('prod-promo-get-y').value : 0) || 0)) : 0;

  // 1. Validasi Stok Tidak Boleh Negatif
  if (stockInput < 0) {
    alert("⛔ Stok produk tidak boleh berupa angka minus / negatif!");
    const stockEl = document.getElementById('prod-stock');
    if (stockEl) {
      stockEl.value = '0';
      stockEl.focus();
    }
    return;
  }

  // 2. Validasi & Peringatan Jual Rugi (Harga Modal / Beli > Harga Jual)
  if (priceBuyInput > priceSellInput && priceSellInput > 0) {
    const selisihRugi = priceBuyInput - priceSellInput;
    const confirmRugi = confirm(
      `⚠️ PERINGATAN POTENSI RUGI:\n\n` +
      `Harga Modal (Beli): Rp ${formatRupiah(priceBuyInput)}\n` +
      `Harga Jual: Rp ${formatRupiah(priceSellInput)}\n\n` +
      `Harga modal LEBIH BESAR daripada harga jual (Potensi Rugi Rp ${formatRupiah(selisihRugi)} per pcs)!\n\n` +
      `Apakah Anda yakin ingin tetap menyimpan produk ini?`
    );
    if (!confirmRugi) {
      const sellPriceEl = document.getElementById('prod-price-sell');
      if (sellPriceEl) sellPriceEl.focus();
      return;
    }
  }
  
  // Cari index produk target secara akurat berdasarkan ID atau editIndex
  let targetIndex = -1;
  if (editIndex > -1 && editIndex < products.length && products[editIndex].id.toLowerCase() === idInput.toLowerCase()) {
    targetIndex = editIndex;
  } else {
    targetIndex = products.findIndex(p => p && p.id && p.id.toLowerCase() === idInput.toLowerCase());
  }

  if (targetIndex === -1 && editIndex === -1) {
    const isDuplicate = products.some(p => p && p.id && p.id.toLowerCase() === idInput.toLowerCase());
    if (isDuplicate) {
      alert(`Gagal! ID Produk "${idInput}" sudah digunakan.`);
      return;
    }
  }
  
  let isPriceIncreased = false;
  let oldPrice = 0;
  if (targetIndex > -1 && products[targetIndex]) {
    const oldProduct = products[targetIndex];
    if (oldProduct && priceSellInput > oldProduct.harga_jual) {
      isPriceIncreased = true;
      oldPrice = oldProduct.harga_jual;
    }
  }
  
  // Fitur Kemasan Multi-Unit (Didukung Array Multi-Satuan Bertingkat: Pcs / Renteng / Pack / Dus)
  const productUnits = getProductMultiUnitsFromForm();
  const hasBox = productUnits.length > 0;
  const firstUnit = productUnits[0] || {};
  const barcodeBox = firstUnit.barcode || '';
  const unitBoxName = firstUnit.name || 'Kotak';
  const qtyBox = firstUnit.ratio || 0;
  const priceBox = firstUnit.price || 0;

  const productData = {
    id: idInput,
    nama: nameInput,
    kategori: categoryInput,
    harga_beli: priceBuyInput,
    harga_jual: priceSellInput,
    stok: stockInput,
    barcode: barcodeInput,
    rak: rackInput,
    tanggal_kadaluarsa: expiryInput,
    gambar: imageInput,
    harga_diskon: promoPriceInput,
    kuota_diskon: promoQuotaInput,
    
    // Fitur Harga Khusus Grosir & Promo Beli X Gratis Y
    grosir_qty: grosirQtyInput,
    grosir_harga: grosirPriceInput,
    promo_beli_x: promoBuyXInput,
    promo_gratis_y: promoGetYInput,
    
    // Kemasan Multi-Satuan (Single backwards-compatible fallback + Array)
    has_unit_box: hasBox,
    barcode_box: barcodeBox,
    nama_box: unitBoxName,
    isi_box: qtyBox,
    harga_box: priceBox,
    units: productUnits,
    createdAt: (targetIndex > -1 && products[targetIndex]?.createdAt) ? products[targetIndex].createdAt : new Date().toISOString()
  };
  
  if (targetIndex > -1) {
    products[targetIndex] = productData;
  } else {
    products.push(productData);
  }
  
  saveProductsLocally();
  if (rackInput && !customRacks.some(r => r.toLowerCase() === rackInput.toLowerCase())) {
    customRacks.push(rackInput);
    localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
    saveCustomRacksCloud();
  }
  updateCategoriesList();
  updateRacksList();
  renderProductsTable();
  
  checkPromoBanner();
  
  alert("Produk berhasil disimpan!");
  closeProductModal(); // This will also reset the form
  
  if (firebaseDb) {
    saveProductCloud(productData);
  }
  
  if (isPriceIncreased) {
    showPriceChangeNotification(productData, oldPrice, priceSellInput);
  }
}

// ─── FITUR MULTI-SATUAN BERTINGKAT (Pcs / Renteng / Pack / Dus) ───────────

function toggleMultiUnitFields() {
  const chk = document.getElementById('chk-prod-enable-box');
  const fields = document.getElementById('prod-box-fields');
  const addBtn = document.getElementById('btn-add-unit-tier');
  const container = document.getElementById('multi-units-container');
  const isEnabled = chk ? chk.checked : false;

  if (fields) fields.style.display = isEnabled ? 'flex' : 'none';
  if (addBtn) addBtn.style.display = isEnabled ? 'inline-block' : 'none';

  if (isEnabled && container && container.children.length === 0) {
    addMultiUnitRow('Dus', 12, 0, '');
  }
}

function toggleBoxPackagingFields() {
  toggleMultiUnitFields();
}

function addMultiUnitRow(name = '', ratio = '', price = '', barcode = '') {
  const container = document.getElementById('multi-units-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'multi-unit-row';
  row.style.background = 'var(--bg-surface-elevated, #ffffff)';
  row.style.padding = '0.65rem 0.75rem';
  row.style.borderRadius = '8px';
  row.style.border = '1px solid var(--border-color)';
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '1.2fr 1fr 1fr 1.2fr auto';
  row.style.gap = '0.45rem';
  row.style.alignItems = 'center';

  row.innerHTML = `
    <div>
      <label style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px;">Nama Satuan</label>
      <input type="text" class="unit-name-input" placeholder="Renteng / Dus" value="${name}" style="width:100%; padding:0.4rem; font-size:0.85rem; border:1px solid var(--border-color); border-radius:6px;">
    </div>
    <div>
      <label style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px;">Isi (Pcs)</label>
      <input type="number" class="unit-ratio-input" placeholder="10" min="2" value="${ratio}" style="width:100%; padding:0.4rem; font-size:0.85rem; border:1px solid var(--border-color); border-radius:6px;">
    </div>
    <div>
      <label style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px;">Harga (Rp)</label>
      <input type="number" class="unit-price-input" placeholder="18000" min="0" value="${price}" style="width:100%; padding:0.4rem; font-size:0.85rem; border:1px solid var(--border-color); border-radius:6px;">
    </div>
    <div>
      <label style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px;">Barcode Satuan</label>
      <input type="text" class="unit-barcode-input" placeholder="Scan Barcode" value="${barcode}" style="width:100%; padding:0.4rem; font-size:0.85rem; border:1px solid var(--border-color); border-radius:6px;">
    </div>
    <div style="padding-top:14px;">
      <button type="button" onclick="this.closest('.multi-unit-row').remove()" title="Hapus Satuan" style="background:#fee2e2; border:1px solid #fca5a5; color:#dc2626; border-radius:6px; width:28px; height:28px; display:flex; align-items:center; justify-content:center; cursor:pointer;">&times;</button>
    </div>
  `;

  container.appendChild(row);
}

function getProductMultiUnitsFromForm() {
  const chk = document.getElementById('chk-prod-enable-box');
  if (!chk || !chk.checked) return [];

  const rows = document.querySelectorAll('#multi-units-container .multi-unit-row');
  const units = [];

  rows.forEach(r => {
    const name = r.querySelector('.unit-name-input')?.value.trim() || 'Kemasan';
    const ratio = parseInt(r.querySelector('.unit-ratio-input')?.value) || 0;
    const price = parseFloat(r.querySelector('.unit-price-input')?.value) || 0;
    const barcode = r.querySelector('.unit-barcode-input')?.value.trim() || '';

    if (ratio > 1 && price > 0) {
      units.push({ name, ratio, price, barcode });
    }
  });

  return units;
}

function renderProductMultiUnitsInForm(p) {
  const container = document.getElementById('multi-units-container');
  if (!container) return;
  container.innerHTML = '';

  let units = [];
  if (Array.isArray(p.units) && p.units.length > 0) {
    units = p.units;
  } else if (p.has_unit_box && p.isi_box > 0) {
    units = [{
      name: p.nama_box || 'Kotak',
      ratio: p.isi_box,
      price: p.harga_box || 0,
      barcode: p.barcode_box || ''
    }];
  }

  const isEnabled = units.length > 0;
  const chk = document.getElementById('chk-prod-enable-box');
  if (chk) chk.checked = isEnabled;
  toggleMultiUnitFields();

  if (units.length > 0) {
    units.forEach(u => addMultiUnitRow(u.name, u.ratio, u.price, u.barcode));
  }
}

function toggleGrosirFields() {
  const chk = document.getElementById('chk-prod-enable-grosir');
  const fields = document.getElementById('prod-grosir-fields');
  if (fields) {
    fields.style.display = (chk && chk.checked) ? 'block' : 'none';
  }
}

function toggleBuyGetFields() {
  const chk = document.getElementById('chk-prod-enable-buy-get');
  const fields = document.getElementById('prod-buyget-fields');
  if (fields) {
    fields.style.display = (chk && chk.checked) ? 'block' : 'none';
  }
}

function openProductModal() {
  populateCategorySelect();
  populateRackSelect();
  document.getElementById('product-edit-modal').classList.add('active');
}

function closeProductModal() {
  document.getElementById('product-edit-modal').classList.remove('active');
  resetProductForm();
  if (activeTab === 'products') focusProductListSearch();
}

function editProduct(index) {
  const p = products[index];
  
  document.getElementById('edit-index').value = index;
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-id').disabled = true;
  document.getElementById('prod-name').value = p.nama;
  populateCategorySelect(p.kategori || 'Umum');
  populateRackSelect(p.rak || '');
  document.getElementById('prod-price-buy').value = p.harga_beli || 0;
  document.getElementById('prod-price-sell').value = p.harga_jual || 0;
  document.getElementById('prod-stock').value = p.stok;
  document.getElementById('prod-barcode').value = p.barcode || '';
  document.getElementById('prod-expiry').value = p.tanggal_kadaluarsa || '';
  document.getElementById('prod-image').value = p.gambar || '';
  document.getElementById('prod-promo-price').value = p.harga_diskon || '';
  document.getElementById('prod-promo-quota').value = p.kuota_diskon || '';
  document.getElementById('prod-grosir-qty').value = p.grosir_qty || '';
  document.getElementById('prod-grosir-price').value = p.grosir_harga || '';
  document.getElementById('prod-promo-buy-x').value = p.promo_beli_x || '';
  document.getElementById('prod-promo-get-y').value = p.promo_gratis_y || '';
  
  const hasBuyGet = Boolean(p.promo_beli_x > 0 && p.promo_gratis_y > 0);
  const chkBuyGet = document.getElementById('chk-prod-enable-buy-get');
  if (chkBuyGet) chkBuyGet.checked = hasBuyGet;
  toggleBuyGetFields();
  
  // Render Multi-Satuan Bertingkat
  renderProductMultiUnitsInForm(p);
  
  document.getElementById('form-title').textContent = "Edit Produk";
  document.getElementById('btn-save-product').textContent = "Perbarui Produk";
  
  openProductModal();
}

function generateNextProductId() {
  if (products.length === 0) {
    return "P001"; // Format standar berawalan P
  }
  
  let maxNum = 0;
  let prefix = "P";
  let maxDigits = 3;
  
  products.forEach(p => {
    if (p && p.id) {
      const matches = p.id.match(/(\d+)/);
      if (matches) {
        const num = parseInt(matches[1]);
        if (num > maxNum) {
          maxNum = num;
          const pre = p.id.substring(0, p.id.indexOf(matches[1]));
          if (pre) prefix = pre;
          if (matches[1].length > maxDigits) maxDigits = matches[1].length;
        }
      }
    }
  });
  
  const nextNum = maxNum + 1;
  const nextNumStr = nextNum.toString().padStart(maxDigits, '0');
  return prefix + nextNumStr;
}

function resetProductForm() {
  document.getElementById('edit-index').value = "-1";
  
  const nextId = generateNextProductId();
  const idInput = document.getElementById('prod-id');
  idInput.value = nextId;
  idInput.disabled = false;
  
  document.getElementById('prod-name').value = "";
  populateCategorySelect('Umum');
  populateRackSelect('');
  document.getElementById('prod-price-buy').value = "";
  document.getElementById('prod-price-sell').value = "";
  document.getElementById('prod-stock').value = "";
  document.getElementById('prod-barcode').value = "";
  document.getElementById('prod-expiry').value = "";
  document.getElementById('prod-image').value = "";
  document.getElementById('prod-promo-price').value = "";
  document.getElementById('prod-promo-quota').value = "";
  document.getElementById('prod-grosir-qty').value = "";
  document.getElementById('prod-grosir-price').value = "";
  document.getElementById('prod-promo-buy-x').value = "";
  document.getElementById('prod-promo-get-y').value = "";

  const chkGrosir = document.getElementById('chk-prod-enable-grosir');
  if (chkGrosir) chkGrosir.checked = false;
  toggleGrosirFields();

  const chkBuyGet = document.getElementById('chk-prod-enable-buy-get');
  if (chkBuyGet) chkBuyGet.checked = false;
  toggleBuyGetFields();
  
  const chkBox = document.getElementById('chk-prod-enable-box');
  if (chkBox) chkBox.checked = false;
  const selectHasBox = document.getElementById('prod-has-box');
  if (selectHasBox) selectHasBox.value = 'no';
  const unitContainer = document.getElementById('multi-units-container');
  if (unitContainer) unitContainer.innerHTML = '';
  toggleMultiUnitFields();
  
  document.getElementById('form-title').textContent = "Tambah Produk Baru";
  document.getElementById('btn-save-product').textContent = "Simpan Produk";
}

function deleteProduct(index) {
  const p = products[index];
  if (!p) return;

  // Cek apakah produk ini sedang digunakan sebagai komponen paket bundling
  if (Array.isArray(bundles) && bundles.length > 0) {
    const usedInBundles = bundles.filter(b => Array.isArray(b.items) && b.items.some(it => String(it.productId) === String(p.id)));
    if (usedInBundles.length > 0) {
      const bundleNames = usedInBundles.map(b => `"${b.nama}"`).join(', ');
      if (!confirm(`⚠️ PERINGATAN:\nProduk "${p.nama}" saat ini terdaftar sebagai komponen dalam paket bundling: ${bundleNames}.\n\nJika dihapus, paket tersebut mungkin tidak dapat dijual dengan normal.\nTetap hapus produk ini?`)) {
        return;
      }
    }
  }

  if (confirm(`Apakah Anda yakin ingin menghapus produk "${p.nama}"?`)) {
    selectedProductIds.delete(p.id);
    products.splice(index, 1);
    saveProductsLocally();
    updateCategoriesList();
    updateRacksList();
    renderProductsTable();
    if (activeTab === 'products') focusProductListSearch();
    if (firebaseDb) {
      deleteProductCloud(p.id);
    }
  }
}

// Export Tabel ke Excel (Format CSV)
function exportToCSV() {
  if (products.length === 0) {
    alert("Daftar produk kosong.");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "ID,Nama Produk,Kategori,Harga Beli,Harga Jual,Stok,Barcode,Rak,Gambar,Tanggal Kadaluarsa\n";
  
  products.forEach(p => {
    const row = [
      `"${p.id}"`,
      `"${p.nama}"`,
      `"${p.kategori || 'Umum'}"`,
      p.harga_beli || 0,
      p.harga_jual || 0,
      p.stok,
      `"${p.barcode || ''}"`,
      `"${p.rak || ''}"`,
      `"${p.gambar || ''}"`,
      `"${p.tanggal_kadaluarsa || ''}"`
    ].join(",");
    csvContent += row + "\n";
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Data_Produk_Toko Sahil POS_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  
  link.click();
  document.body.removeChild(link);
}

// ─── FITUR IMPORT EXCEL & CONTOH TEMPLATE EXCEL ──────────────────────────────────

// 1. Unduh Contoh Template File Excel (.xlsx)
function downloadProductExcelTemplate() {
  const sampleData = [
    {
      "ID Produk": "P1001",
      "Nama Produk": "Kopi Susu Gula Aren",
      "Kategori": "Minuman",
      "Harga Beli": 10000,
      "Harga Jual": 15000,
      "Stok": 50,
      "Barcode": "8991234567890",
      "Rak": "Rak A1",
      "Tanggal Kadaluarsa": "2026-12-31",
      "Gambar": "https://images.unsplash.com/photo-1541167760496-1628856ab772?w=200"
    },
    {
      "ID Produk": "P1002",
      "Nama Produk": "Roti Bakar Coklat Keju",
      "Kategori": "Makanan",
      "Harga Beli": 12000,
      "Harga Jual": 18000,
      "Stok": 30,
      "Barcode": "8999876543210",
      "Rak": "Rak B2",
      "Tanggal Kadaluarsa": "",
      "Gambar": ""
    },
    {
      "ID Produk": "P1003",
      "Nama Produk": "Keripik Singkong Renyah",
      "Kategori": "Snack",
      "Harga Beli": 5000,
      "Harga Jual": 8000,
      "Stok": 100,
      "Barcode": "8995551234567",
      "Rak": "Etalase Depan",
      "Tanggal Kadaluarsa": "2027-06-30",
      "Gambar": ""
    }
  ];

  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(sampleData);
    // Atur lebar kolom agar rapi
    ws['!cols'] = [
      { wch: 12 }, // ID Produk
      { wch: 28 }, // Nama Produk
      { wch: 15 }, // Kategori
      { wch: 14 }, // Harga Beli
      { wch: 14 }, // Harga Jual
      { wch: 10 }, // Stok
      { wch: 18 }, // Barcode
      { wch: 14 }, // Rak
      { wch: 18 }, // Tanggal Kadaluarsa
      { wch: 35 }  // Gambar (URL / Path)
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Produk");
    XLSX.writeFile(wb, "Contoh_Format_Import_Produk.xlsx");
  } else {
    // Fallback jika lib XLSX sedang loading
    let csv = "ID Produk,Nama Produk,Kategori,Harga Beli,Harga Jual,Stok,Barcode,Tanggal Kadaluarsa,Gambar\n";
    sampleData.forEach(r => {
      csv += `"${r["ID Produk"]}","${r["Nama Produk"]}","${r["Kategori"]}",${r["Harga Beli"]},${r["Harga Jual"]},${r["Stok"]},"${r["Barcode"]}","${r["Tanggal Kadaluarsa"]}","${r["Gambar"]}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", "Contoh_Format_Import_Produk.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

// 2. Trigger dialog pilih file Excel
function triggerImportExcel() {
  const fileInput = document.getElementById('excel-product-file-input');
  if (fileInput) {
    fileInput.value = '';
    fileInput.click();
  }
}

// 3. Baca file Excel yang diunggah dan masukkan produk ke sistem
function handleProductExcelUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (typeof XLSX === 'undefined') {
    alert('❌ Library pembaca Excel belum siap. Pastikan terhubung internet saat pertama kali membuka halaman.');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

      if (!rows || rows.length === 0) {
        alert("⚠️ File Excel kosong atau tidak memiliki baris data!");
        return;
      }

      let addedCount = 0;
      let updatedCount = 0;
      const updatesCloud = {};

      rows.forEach((row, idx) => {
        // Normalisasi key object agar tidak terpengaruh huruf besar/kecil atau spasi
        const normalizedRow = {};
        Object.keys(row).forEach(k => {
          normalizedRow[k.trim().toLowerCase()] = row[k];
        });

        // Toleransi nama kolom Bahasa Indonesia & Inggris
        const rawName = row['Nama Produk'] || row['Nama'] || row['nama'] || row['Product Name'] || row['nama_produk'] ||
                        normalizedRow['nama produk'] || normalizedRow['nama'] || normalizedRow['product name'] || normalizedRow['nama_produk'];
        if (!rawName) return; // Lewati baris tanpa nama

        let rawId = String(row['ID Produk'] || row['ID'] || row['id'] || row['Id'] || normalizedRow['id produk'] || normalizedRow['id'] || '').trim();
        const rawCat = String(row['Kategori'] || row['kategori'] || row['Category'] || normalizedRow['kategori'] || normalizedRow['category'] || 'Umum').trim() || 'Umum';
        const rawBuy = parseFloat(row['Harga Beli'] || row['harga_beli'] || row['Beli'] || row['Buy Price'] || normalizedRow['harga beli'] || normalizedRow['harga_beli'] || normalizedRow['beli']) || 0;
        const rawSell = parseFloat(row['Harga Jual'] || row['harga_jual'] || row['Jual'] || row['Sell Price'] || normalizedRow['harga jual'] || normalizedRow['harga_jual'] || normalizedRow['jual']) || 0;
        const rawStock = parseInt(row['Stok'] || row['stok'] || row['Stock'] || row['Jumlah'] || normalizedRow['stok'] || normalizedRow['stock'] || normalizedRow['jumlah']) || 0;
        const rawBarcode = String(row['Barcode'] || row['barcode'] || normalizedRow['barcode'] || '').trim();
        const rawRack = String(row['Rak'] || row['rak'] || row['Lokasi Rak'] || row['lokasi_rak'] || row['Rack'] || normalizedRow['rak'] || normalizedRow['lokasi rak'] || normalizedRow['lokasi_rak'] || normalizedRow['rack'] || '').trim();
        const rawExpiry = String(row['Tanggal Kadaluarsa'] || row['tanggal_kadaluarsa'] || row['Kadaluarsa'] || row['Expiry'] || normalizedRow['tanggal kadaluarsa'] || normalizedRow['tanggal_kadaluarsa'] || normalizedRow['kadaluarsa'] || normalizedRow['expired'] || '').trim();
        const rawImage = String(row['Gambar'] || row['gambar'] || row['Image'] || row['Foto'] || row['image'] || normalizedRow['gambar'] || normalizedRow['image'] || normalizedRow['foto'] || '').trim();

        // Jika ID kosong di file Excel, generate ID otomatis sesuai urutan (P001, P002, dst)
        if (!rawId) {
          rawId = generateNextProductId();
        }

        const existingIdx = products.findIndex(p => p.id === rawId || (rawBarcode && p.barcode === rawBarcode));
        
        const prodData = {
          id: rawId,
          nama: String(rawName).trim(),
          kategori: rawCat,
          harga_beli: rawBuy,
          harga_jual: rawSell,
          stok: rawStock,
          barcode: rawBarcode,
          rak: rawRack,
          tanggal_kadaluarsa: rawExpiry,
          gambar: rawImage,
          createdAt: (existingIdx !== -1 && products[existingIdx]?.createdAt) ? products[existingIdx].createdAt : new Date().toISOString()
        };

        if (existingIdx !== -1) {
          // Perbarui produk yang sudah ada
          products[existingIdx] = { ...products[existingIdx], ...prodData };
          updatedCount++;
        } else {
          // Tambah produk baru
          products.push(prodData);
          addedCount++;
        }

        // Simpan kategori baru jika belum ada di customCategories
        if (rawCat && !customCategories.find(c => c.toLowerCase() === rawCat.toLowerCase())) {
          customCategories.push(rawCat);
        }

        // Simpan rak baru jika belum ada di customRacks
        if (rawRack && !customRacks.find(r => r.toLowerCase() === rawRack.toLowerCase())) {
          customRacks.push(rawRack);
        }

        if (firebaseDb) {
          updatesCloud[getStorePath('products/' + rawId)] = prodData;
        }
      });

      // Simpan perubahan ke LocalStorage
      localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
      localStorage.setItem('kasir_custom_racks', JSON.stringify(customRacks));
      saveCustomRacksCloud();
      saveProductsLocally();
      updateCategoriesList();
      updateRacksList();
      renderProductsTable();

      // Sinkronkan ke Firebase jika sedang online
      if (firebaseDb && Object.keys(updatesCloud).length > 0) {
        updateSyncStatus('syncing', 'Menyimpan produk dari Excel ke cloud...');
        firebaseDb.ref('/').update(updatesCloud).then(() => {
          updateSyncStatus('online', 'Database Terhubung');
        }).catch(err => {
          console.error('Gagal sinkron excel ke RTDB:', err);
        });
      }

      alert(`✅ Berhasil Mengimpor Data Excel!\n\n• Produk Baru Ditambahkan: ${addedCount}\n• Produk Lama Diperbarui: ${updatedCount}\n• Total Produk di Kasir: ${products.length}`);
    } catch (err) {
      console.error('Gagal membaca file Excel:', err);
      alert('❌ Gagal memproses file Excel: ' + err.message + '\n\nSilakan gunakan template dari tombol "Contoh Excel" sebagai acuan.');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}






// ─── LOGIKA MANAJEMEN KARYAWAN & HAK AKSES ROLE (OWNER VS KASIR) ──────────

// Cek apakah akun aktif berhak mengakses tab tertentu
function canAccessTab(tabName) {
  // Jika fitur wajib login dimatikan, semua tab terbuka bebas
  if (!isStaffLoginEnabled) return true;

  // Owner memiliki akses mutlak ke semua tab
  if (currentUserRole === 'owner') return true;

  // Tab POS kasir selalu diizinkan untuk siapa saja yang sudah login
  if (tabName === 'pos') return true;

  // Cari hak akses staf aktif
  const staff = staffAccounts.find(s => s.name === activeCashier);
  if (!staff || !staff.permissions) return false;

  return !!staff.permissions[tabName];
}

// Cek hak akses aksi spesifik (Hapus transaksi, edit harga, dll)
function canPerformAction(actionKey) {
  if (!isStaffLoginEnabled) return true;
  if (currentUserRole === 'owner') return true;
  const staff = staffAccounts.find(s => s.name === activeCashier);
  if (!staff || !staff.permissions) return false;
  return !!staff.permissions[actionKey];
}

// Perbarui badge tampilan kasir di Navbar & kontrol tombol Logout
function updateCashierAuthUI() {
  const roleBadge = document.getElementById('current-user-role-badge');
  const nameSpan = document.getElementById('current-user-name');
  const chkLogin = document.getElementById('chk-enable-staff-login');
  const ownerPinInput = document.getElementById('owner-pin-input');
  const logoutBtn = document.getElementById('btn-logout-staff');

  const authWrapper = document.getElementById('cashier-auth-wrapper');
  const sheetAuthItem = document.getElementById('m3-sheet-auth-item');

  if (chkLogin) chkLogin.checked = !!isStaffLoginEnabled;
  if (ownerPinInput) ownerPinInput.value = ownerPin || '1234';

  if (!isStaffLoginEnabled) {
    // JIKA FITUR LOGIN DIMATIKAN:
    // Sembunyikan tombol login & logout dari desktop navbar serta menu Ganti Akun di mobile sheet
    if (authWrapper) {
      authWrapper.style.display = 'none';
    }
    if (logoutBtn) {
      logoutBtn.style.display = 'none';
    }
    if (sheetAuthItem) {
      sheetAuthItem.style.display = 'none';
    }
  } else {
    // JIKA FITUR LOGIN DIAKTIFKAN:
    // Tampilkan tombol status login kasir & tombol logout di desktop navbar serta menu Ganti Akun di mobile sheet
    if (authWrapper) {
      authWrapper.style.display = 'flex';
    }
    if (logoutBtn) {
      logoutBtn.style.display = 'inline-flex';
    }
    if (sheetAuthItem) {
      sheetAuthItem.style.display = 'flex';
    }

    if (roleBadge) {
      if (currentUserRole === 'owner') {
        roleBadge.textContent = 'Owner';
        roleBadge.style.background = '#3b82f6';
      } else {
        roleBadge.textContent = 'Kasir';
        roleBadge.style.background = '#10b981';
      }
    }

    if (nameSpan) {
      nameSpan.textContent = currentUserRole === 'owner' ? 'Owner Toko' : activeCashier;
    }
  }

  // Terapkan izin akses menu tab
  applyTabVisibilityByPermissions();
}

// Tombol Logout Kasir
function logoutCashier() {
  // Cek apakah kasir yang sedang aktif masih memiliki sesi shift yang belum ditutup
  const currentStaffShift = getStaffActiveShift(activeCashier);
  if (currentStaffShift && currentUserRole === 'staff') {
    alert(`⚠️ PERINGATAN:\nKasir "${activeCashier}" masih memiliki shift yang AKTIF!\n\nSebelum keluar atau berganti kasir, Anda WAJIB TUTUP SHIFT terlebih dahulu untuk menghitung uang laci (modal + hasil penjualan).`);
    openShiftModal();
    return;
  }

  if (!confirm(`Keluar dari akun "${currentUserRole === 'owner' ? 'Owner' : activeCashier}"?`)) {
    return;
  }

  // Reset sesi aktif
  activeCashier = '';
  currentUserRole = '';
  localStorage.removeItem('kasir_active_cashier');
  localStorage.removeItem('kasir_current_user_role');

  updateCashierAuthUI();

  // Langsung tampilkan modal login PIN (wajib)
  openCashierLoginModal(true);
}

// Terapkan visibility tombol tab sesuai izin karyawan
function applyTabVisibilityByPermissions() {
  const tabs = ['analytics', 'pos', 'transactions', 'kulak', 'products', 'customers', 'settings'];
  tabs.forEach(tabId => {
    const btn = document.getElementById(`tab-${tabId}`);
    if (btn) {
      if (canAccessTab(tabId)) {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
      } else {
        btn.style.opacity = '0.35';
        btn.title = 'Akses Terkunci (Khusus Owner)';
      }
    }
  });
}

let isLoginModalForced = false;

// Buka modal login kasir
function openCashierLoginModal(isForced = false) {
  const modal = document.getElementById('cashier-login-modal');
  const select = document.getElementById('login-cashier-select');
  const pinInput = document.getElementById('login-pin-input');
  const closeBtn = modal ? modal.querySelector('.close-modal-btn') : null;
  if (!modal || !select) return;

  isLoginModalForced = isForced;
  if (closeBtn) closeBtn.style.display = isForced ? 'none' : 'block';

  pinInput.value = '';

  // Isi daftar pilihan: Owner + Karyawan
  select.innerHTML = '';
  const optOwner = document.createElement('option');
  optOwner.value = '__OWNER__';
  optOwner.textContent = '👑 Owner Toko (Pemilik)';
  if (currentUserRole === 'owner') optOwner.selected = true;
  select.appendChild(optOwner);

  staffAccounts.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `👤 ${s.name}`;
    if (currentUserRole === 'staff' && activeCashier === s.name) opt.selected = true;
    select.appendChild(opt);
  });

  const pinContainer = document.getElementById('login-pin-container');
  if (pinContainer) {
    pinContainer.style.display = isStaffLoginEnabled ? 'block' : 'none';
  }

  // Render opsi Master Shift
  renderMasterShiftOptions();
  onLoginAccountSelected();

  modal.style.display = 'flex';
}

function renderMasterShiftOptions() {
  const shiftSelect = document.getElementById('login-shift-select');
  if (!shiftSelect) return;

  const s1 = masterShiftSchedule.shift1 || { name: 'Shift 1 (Pagi)', start: '07:00', end: '15:00' };
  const s2 = masterShiftSchedule.shift2 || { name: 'Shift 2 (Siang)', start: '15:00', end: '21:00' };
  const s3 = masterShiftSchedule.shift3 || { name: 'Shift 3 (Malam)', start: '21:00', end: '07:00' };

  shiftSelect.innerHTML = `
    <option value="${s1.name} (${s1.start} - ${s1.end})">🌅 ${s1.name} (${s1.start} - ${s1.end})</option>
    <option value="${s2.name} (${s2.start} - ${s2.end})">☀️ ${s2.name} (${s2.start} - ${s2.end})</option>
    <option value="${s3.name} (${s3.start} - ${s3.end})">🌙 ${s3.name} (${s3.start} - ${s3.end})</option>
    <option value="Shift Fleksibel / Full Day">🕒 Shift Fleksibel / Full Day</option>
  `;
}

function closeCashierLoginModal() {
  if (isLoginModalForced && isStaffLoginEnabled) {
    alert("Silakan pilih akun dan masukkan PIN untuk mulai menggunakan kasir.");
    return;
  }
  const modal = document.getElementById('cashier-login-modal');
  if (modal) modal.style.display = 'none';
}

function onLoginAccountSelected() {
  const select = document.getElementById('login-cashier-select');
  const pinInput = document.getElementById('login-pin-input');
  const shiftCont = document.getElementById('login-shift-selection-container');
  const modalCont = document.getElementById('login-modal-awal-container');
  const shiftSelect = document.getElementById('login-shift-select');
  const modalInput = document.getElementById('login-modal-awal-input');
  if (pinInput) pinInput.value = '';

  const selected = select ? select.value : '';
  const isOwner = selected === '__OWNER__';

  // Jika Owner yang login, sembunyikan shift dan modal awal laci
  if (isOwner) {
    if (shiftCont) shiftCont.style.display = 'none';
    if (modalCont) modalCont.style.display = 'none';
    return;
  }

  // Jika Karyawan/Kasir: Cek apakah karyawan ini sudah punya shift yang sedang berjalan (aktif)
  const existingShift = getStaffActiveShift(selected);
  if (existingShift) {
    // SHIFT SUDAH BERJALAN: Kunci pilihan shift & modal (tidak boleh diubah sebelum ditutup)
    if (shiftCont) {
      shiftCont.style.display = 'block';
      let infoBadge = document.getElementById('login-shift-locked-notice');
      if (!infoBadge) {
        infoBadge = document.createElement('div');
        infoBadge.id = 'login-shift-locked-notice';
        infoBadge.style.cssText = 'background: rgba(22, 163, 74, 0.1); border: 1px solid #16a34a; color: #16a34a; font-size: 0.78rem; font-weight: 700; padding: 6px 10px; border-radius: 6px; margin-top: 4px;';
        shiftCont.appendChild(infoBadge);
      }
      infoBadge.innerHTML = `🔒 Shift Berjalan: <strong>${existingShift.jenis_shift}</strong><br><span style="font-size: 0.72rem; font-weight: 500; color: var(--text-muted);">Shift tidak dapat diganti sampai shift ini ditutup.</span>`;
      infoBadge.style.display = 'block';
    }
    if (shiftSelect) {
      shiftSelect.value = existingShift.jenis_shift;
      shiftSelect.disabled = true;
      shiftSelect.style.opacity = '0.75';
      shiftSelect.style.cursor = 'not-allowed';
    }
    if (modalCont) modalCont.style.display = 'none'; // Modal awal tidak perlu diisi ulang
  } else {
    // BELUM ADA SHIFT: Izinkan pilih shift baru dan input modal awal laci
    if (shiftCont) {
      shiftCont.style.display = 'block';
      const infoBadge = document.getElementById('login-shift-locked-notice');
      if (infoBadge) infoBadge.style.display = 'none';
    }
    if (shiftSelect) {
      shiftSelect.disabled = false;
      shiftSelect.style.opacity = '1';
      shiftSelect.style.cursor = 'default';
    }
    if (modalCont) {
      modalCont.style.display = 'block';
      if (modalInput) modalInput.value = '';
    }
  }
}

// Input PIN via Numpad
function inputLoginPin(digit) {
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput && pinInput.value.length < 6) {
    pinInput.value += digit;
  }
}

function clearLoginPin() {
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) pinInput.value = '';
}

function backspaceLoginPin() {
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput && pinInput.value.length > 0) {
    pinInput.value = pinInput.value.slice(0, -1);
  }
}

// Submit login kasir / owner sekaligus mulai shift kerja
function submitCashierLogin() {
  const select = document.getElementById('login-cashier-select');
  const pinInput = document.getElementById('login-pin-input');
  const shiftSelect = document.getElementById('login-shift-select');
  const modalAwalInput = document.getElementById('login-modal-awal-input');
  const selectedAccount = select.value;
  const enteredPin = pinInput ? pinInput.value.trim() : '';

  // CEK JIKA ADA KASIR SEBELUMNYA YANG MASIH AKTIF SHIFTNYA & BERBEDA AKUN
  if (activeCashier && currentUserRole === 'staff' && selectedAccount !== activeCashier && selectedAccount !== '__OWNER__') {
    const prevShift = getStaffActiveShift(activeCashier);
    if (prevShift) {
      alert(`⚠️ PERINGATAN GANTI KASIR:\nKasir "${activeCashier}" masih memiliki shift yang AKTIF!\n\nKasir sebelumnya wajib melakukan TUTUP SHIFT terlebih dahulu dan menghitung uang laci sebelum kasir baru dapat masuk.`);
      const modal = document.getElementById('cashier-login-modal');
      if (modal) modal.style.display = 'none';
      openShiftModal();
      return;
    }
  }

  // JIKA FITUR WAJIB LOGIN DIAKTIFKAN: Validasi PIN secara ketat!
  if (isStaffLoginEnabled) {
    if (!enteredPin) {
      alert("⚠️ PIN Keamanan wajib diisi!");
      return;
    }

    if (selectedAccount === '__OWNER__') {
      const currentOwnerPin = (ownerPin || '1234').toString();
      if (enteredPin !== currentOwnerPin) {
        alert("❌ PIN Owner SALAH! Silakan masukkan PIN Owner yang benar.");
        if (pinInput) pinInput.value = '';
        return;
      }
      currentUserRole = 'owner';
      activeCashier = 'Owner Toko';
      alert("✅ PIN Benar! Selamat datang, Owner Toko.");
    } else {
      const staff = staffAccounts.find(s => s.name === selectedAccount);
      if (!staff) {
        alert("Akun karyawan tidak ditemukan.");
        return;
      }

      const expectedPin = (staff.pin || '1234').toString();
      if (enteredPin !== expectedPin) {
        alert(`❌ PIN Kasir untuk "${staff.name}" SALAH!\nSilakan coba lagi atau tanyakan ke Owner.`);
        if (pinInput) pinInput.value = '';
        return;
      }

      currentUserRole = 'staff';
      activeCashier = staff.name;
    }
  } else {
    // JIKA FITUR WAJIB LOGIN DINONAKTIFKAN: Bebas ganti tanpa password
    if (selectedAccount === '__OWNER__') {
      currentUserRole = 'owner';
      activeCashier = 'Owner Toko';
    } else {
      currentUserRole = 'staff';
      activeCashier = selectedAccount;
    }
  }

  // Jika yang login adalah Karyawan / Kasir: Buka Shift Baru HANYA JIKA BELUM ADA SHIFT AKTIF
  if (currentUserRole === 'staff') {
    const staff = staffAccounts.find(s => s.name === activeCashier);
    const existingShift = getStaffActiveShift(activeCashier);

    if (existingShift) {
      // Shift sudah aktif sebelumnya, lanjutkan sesi shift yang sama
      activeShift = existingShift;
      localStorage.setItem('kasir_active_shift', JSON.stringify(activeShift));
      const termInfo = isMultiPosEnabled ? ` (${posTerminalName})` : '';
      alert(`✅ Berhasil Masuk!\n👤 Kasir: ${activeCashier}${termInfo}\n🕒 Melanjutkan Shift Aktif: ${existingShift.jenis_shift}\n💵 Modal Awal: Rp ${formatRupiah(existingShift.modal_awal || 0)}`);
    } else {
      // Shift baru pertama kali dibuka: ambil pilihan shift & modal awal
      const chosenShift = shiftSelect ? shiftSelect.value : 'Shift 1 (Pagi)';
      const modalRaw = modalAwalInput ? modalAwalInput.value.replace(/\./g, '') : '0';
      const modalAwal = parseFloat(modalRaw) || 0;

      const newShiftSession = {
        id_shift: 'SH-' + Date.now().toString().slice(-8),
        nama_kasir: activeCashier,
        terminal: posTerminalName || 'Kasir 1',
        jenis_shift: chosenShift,
        waktu_buka: new Date().toISOString(),
        modal_awal: modalAwal,
        status: 'aktif'
      };

      if (staff) {
        staff.shiftStatus = 'aktif';
        staff.shiftData = newShiftSession;
        staff.assignedShift = chosenShift;
        localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));
      }

      activeShift = newShiftSession;
      localStorage.setItem('kasir_active_shift', JSON.stringify(activeShift));
      const termInfo = isMultiPosEnabled ? ` (${posTerminalName})` : '';
      alert(`✅ Berhasil Masuk!\n👤 Kasir: ${activeCashier}${termInfo}\n🕒 Shift Baru: ${chosenShift}\n💵 Modal Laci: Rp ${formatRupiah(modalAwal)}`);
    }
  }

  localStorage.setItem('kasir_current_user_role', currentUserRole);
  localStorage.setItem('kasir_active_cashier', activeCashier);

  isLoginModalForced = false;
  const modal = document.getElementById('cashier-login-modal');
  if (modal) modal.style.display = 'none';

  updateCashierAuthUI();
  updateShiftStatusUI();
  renderCashierSettingsList();

  // Jika tab yang aktif saat ini tidak boleh dibuka oleh kasir baru, pindahkan ke Kasir (POS)
  if (!canAccessTab(activeTab)) {
    switchTab('pos');
  }
}

// Toggle on/off kewajiban login PIN
function toggleStaffLoginRequirement() {
  const chk = document.getElementById('chk-enable-staff-login');
  const enabled = chk ? chk.checked : false;

  // Jika ingin mengubah, minta konfirmasi PIN Owner jika sekarang bukan Owner
  if (currentUserRole !== 'owner') {
    const promptPin = prompt("Masukkan PIN Owner untuk mengubah pengaturan keamanan ini:");
    if (promptPin !== ownerPin) {
      alert("❌ PIN Owner salah. Perubahan dibatalkan.");
      if (chk) chk.checked = isStaffLoginEnabled;
      return;
    }
  }

  isStaffLoginEnabled = enabled;
  localStorage.setItem('kasir_staff_login_enabled', JSON.stringify(isStaffLoginEnabled));
  updateCashierAuthUI();
  alert(`Pengaturan disimpan: Wajib Login ${isStaffLoginEnabled ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'}.`);
}

// Simpan PIN Owner Baru
function saveOwnerPin() {
  if (currentUserRole !== 'owner') {
    const currentInput = prompt("Masukkan PIN Owner lama:");
    if (currentInput !== ownerPin) {
      alert("❌ PIN Owner salah.");
      return;
    }
  }

  const pinInput = document.getElementById('owner-pin-input');
  const newPin = pinInput.value.trim();
  if (newPin.length < 4) {
    alert("PIN Owner minimal 4 digit angka!");
    return;
  }

  ownerPin = newPin;
  localStorage.setItem('kasir_owner_pin', ownerPin);
  alert("✅ PIN Owner berhasil diperbarui!");
}

// ─── MASTER KEY PEMULIHAN PIN DEVELOPER ──────────────────────────────────────────
function openForgotPinModal() {
  const modal = document.getElementById('forgot-pin-modal');
  const masterInput = document.getElementById('recovery-master-key-input');
  const newPinInput = document.getElementById('recovery-new-pin-input');

  if (masterInput) masterInput.value = '';
  if (newPinInput) newPinInput.value = '';

  if (modal) modal.style.display = 'flex';
}

function closeForgotPinModal() {
  const modal = document.getElementById('forgot-pin-modal');
  if (modal) modal.style.display = 'none';
}

async function resetOwnerPinWithMasterKey() {
  const masterKey = document.getElementById('recovery-master-key-input').value.trim();
  const newPin = document.getElementById('recovery-new-pin-input').value.trim();

  if (!masterKey) {
    alert("Silakan masukkan Master Key Developer!");
    return;
  }

  const inputHash = await hashSecretStr(masterKey);
  if (inputHash !== DEV_MASTER_HASH) {
    alert("❌ Master Key Developer SALAH!\n\nJika Anda pemilik toko resmi, silakan klik tombol bantuan WhatsApp di bawah.");
    return;
  }

  if (!newPin || newPin.length < 4) {
    alert("PIN baru minimal harus 4 digit angka!");
    return;
  }

  // Update PIN Owner
  ownerPin = newPin;
  localStorage.setItem('kasir_owner_pin', ownerPin);

  // Otomatis login sebagai Owner
  currentUserRole = 'owner';
  activeCashier = 'Owner Toko';
  localStorage.setItem('kasir_current_user_role', currentUserRole);
  localStorage.setItem('kasir_active_cashier', activeCashier);

  closeForgotPinModal();
  closeCashierLoginModal();
  updateCashierAuthUI();

  alert(`🎉 SUKSES!\n\nPIN Owner Anda telah berhasil direset menjadi: "${newPin}".\nAnda sekarang telah masuk sebagai Owner Toko.`);
}

function contactAdminWhatsAppForPinReset() {
  const storeName = receiptSettings.name || 'Toko Saya';
  const licenseKey = currentLicenseKey || 'OFFLINE';
  const message = `Halo Admin Kasir, saya pemilik toko *${storeName}* (Lisensi: ${licenseKey}). Saya lupa PIN Owner aplikasi kasir. Mohon bantuan untuk reset Master PIN.`;
  const url = `https://wa.me/6289636492890?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

// Simpan Pengaturan Master Jam Shift Toko (Owner)
function saveMasterShiftSettings() {
  if (currentUserRole !== 'owner') {
    alert("Hanya akun Owner yang berhak mengubah Master Jam Operasional Shift Toko.");
    return;
  }

  const s1Start = document.getElementById('master-shift1-start')?.value || '07:00';
  const s1End = document.getElementById('master-shift1-end')?.value || '15:00';
  const s2Start = document.getElementById('master-shift2-start')?.value || '15:00';
  const s2End = document.getElementById('master-shift2-end')?.value || '21:00';
  const s3Start = document.getElementById('master-shift3-start')?.value || '21:00';
  const s3End = document.getElementById('master-shift3-end')?.value || '07:00';

  masterShiftSchedule = {
    shift1: { name: 'Shift 1 (Pagi)', start: s1Start, end: s1End },
    shift2: { name: 'Shift 2 (Siang)', start: s2Start, end: s2End },
    shift3: { name: 'Shift 3 (Malam)', start: s3Start, end: s3End }
  };

  localStorage.setItem('kasir_master_shift_schedule', JSON.stringify(masterShiftSchedule));
  renderMasterShiftOptions();
  alert("✅ Master Jam Operasional Shift Toko berhasil disimpan!\nKaryawan saat login akan otomatis memilih jadwal shift ini.");
}

// Muat UI Pengaturan Master Shift
function loadMasterShiftSettingsUI() {
  if (masterShiftSchedule) {
    if (document.getElementById('master-shift1-start') && masterShiftSchedule.shift1) {
      document.getElementById('master-shift1-start').value = masterShiftSchedule.shift1.start || '07:00';
      document.getElementById('master-shift1-end').value = masterShiftSchedule.shift1.end || '15:00';
    }
    if (document.getElementById('master-shift2-start') && masterShiftSchedule.shift2) {
      document.getElementById('master-shift2-start').value = masterShiftSchedule.shift2.start || '15:00';
      document.getElementById('master-shift2-end').value = masterShiftSchedule.shift2.end || '21:00';
    }
    if (document.getElementById('master-shift3-start') && masterShiftSchedule.shift3) {
      document.getElementById('master-shift3-start').value = masterShiftSchedule.shift3.start || '21:00';
      document.getElementById('master-shift3-end').value = masterShiftSchedule.shift3.end || '07:00';
    }
  }

  // Muat status centang mode 2 Komputer (Multi-POS)
  const chkMulti = document.getElementById('chk-enable-multi-pos');
  const panelMulti = document.getElementById('multi-pos-config-panel');
  if (chkMulti) chkMulti.checked = !!isMultiPosEnabled;
  if (panelMulti) panelMulti.style.display = isMultiPosEnabled ? 'block' : 'none';

  // Muat nama terminal POS
  const termInput = document.getElementById('terminal-device-name-input');
  if (termInput) termInput.value = posTerminalName || 'Kasir 1';

  // Tampilkan badge nama POS di navbar HANYA JIKA mode 2 Komputer dicentang
  const badge = document.getElementById('pos-terminal-badge');
  if (badge) {
    badge.textContent = posTerminalName || 'Kasir 1';
    badge.style.display = isMultiPosEnabled ? 'inline-block' : 'none';
  }
}

// Toggle on/off fitur 2 Komputer Kasir (Multi-POS)
function toggleMultiPosFeature() {
  const chk = document.getElementById('chk-enable-multi-pos');
  const panel = document.getElementById('multi-pos-config-panel');
  const badge = document.getElementById('pos-terminal-badge');
  
  isMultiPosEnabled = chk ? chk.checked : false;
  localStorage.setItem('kasir_multi_pos_enabled', JSON.stringify(isMultiPosEnabled));

  if (panel) panel.style.display = isMultiPosEnabled ? 'block' : 'none';
  if (badge) badge.style.display = isMultiPosEnabled ? 'inline-block' : 'none';

  if (isMultiPosEnabled) {
    alert(`✅ Fitur Toko 2 Komputer DIAKTIFKAN.\nSilakan atur nama komputer ini (misal: Kasir 1 atau Kasir 2).`);
  } else {
    alert(`ℹ️ Fitur Toko 2 Komputer DINONAKTIFKAN.\nAplikasi berjalan dalam mode kasir standar tunggal.`);
  }
}

// Simpan Identitas Terminal Komputer Kasir (untuk toko multi-komputer)
function saveDeviceTerminalName() {
  const input = document.getElementById('terminal-device-name-input');
  const val = input ? input.value.trim() : '';
  if (!val) {
    alert("Nama komputer/terminal tidak boleh kosong!");
    return;
  }

  posTerminalName = val;
  localStorage.setItem('kasir_pos_terminal_name', posTerminalName);
  
  const badge = document.getElementById('pos-terminal-badge');
  if (badge) badge.textContent = posTerminalName;

  alert(`✅ Nama komputer ini disetel sebagai: "${posTerminalName}".\nTransaksi dan laci kasir di komputer ini akan dicatat atas nama terminal ini.`);
}

// Toggle Tampilan Input Jam Kustom Shift
function toggleCustomShiftInputs(prefix) {
  const select = document.getElementById(prefix === 'new' ? 'new-cashier-shift' : 'edit-staff-shift-select');
  const container = document.getElementById(prefix === 'new' ? 'new-custom-shift-container' : 'edit-custom-shift-container');
  if (!select || !container) return;
  if (select.value === 'custom') {
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
  }
}

// Tambah Akun Karyawan Baru
function addStaffAccount() {
  const nameInput = document.getElementById('new-cashier-name');
  const pinInput = document.getElementById('new-cashier-pin');
  const shiftInput = document.getElementById('new-cashier-shift');
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();
  
  let assignedShift = shiftInput ? shiftInput.value : 'Shift Pagi (07:00 - 15:00)';
  if (assignedShift === 'custom') {
    const start = document.getElementById('new-shift-start-time')?.value || '08:00';
    const end = document.getElementById('new-shift-end-time')?.value || '16:00';
    const label = document.getElementById('new-shift-label')?.value.trim() || 'Shift Kustom';
    assignedShift = `${label} (${start} - ${end})`;
  }

  if (!name) {
    alert("Nama karyawan wajib diisi!");
    return;
  }
  if (name.toLowerCase() === 'owner' || name.toLowerCase() === 'owner toko') {
    alert("Nama ini dikhususkan untuk akun Owner.");
    return;
  }
  if (staffAccounts.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    alert("Karyawan dengan nama ini sudah terdaftar!");
    return;
  }
  if (pin && pin.length < 4) {
    alert("PIN karyawan minimal 4 digit angka!");
    return;
  }

  const newStaff = {
    name,
    pin: pin || '1234',
    assignedShift: assignedShift,
    shiftStatus: 'off', // 'off' atau 'aktif'
    shiftData: null,
    permissions: {
      pos: true,
      transactions: document.getElementById('perm-transactions')?.checked,
      products: document.getElementById('perm-products')?.checked,
      kulak: document.getElementById('perm-kulak')?.checked,
      customers: document.getElementById('perm-customers')?.checked,
      analytics: document.getElementById('perm-analytics')?.checked,
      settings: document.getElementById('perm-settings')?.checked,
      opname: document.getElementById('perm-opname')?.checked,
      expired: document.getElementById('perm-expired')?.checked,
      bundles: document.getElementById('perm-bundles')?.checked,
      expenses: document.getElementById('perm-expenses')?.checked,
      deleteTx: document.getElementById('perm-delete-tx')?.checked,
      editPrice: document.getElementById('perm-edit-price')?.checked
    }
  };

  staffAccounts.push(newStaff);
  localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));

  // Sinkronkan ke daftar kasir lama (kompatibilitas)
  if (!cashiers.includes(name)) {
    cashiers.push(name);
    localStorage.setItem('kasir_cashiers', JSON.stringify(cashiers));
  }

  nameInput.value = '';
  pinInput.value = '';
  if (shiftInput) shiftInput.value = 'Shift Pagi (07:00 - 15:00)';
  const custCont = document.getElementById('new-custom-shift-container');
  if (custCont) custCont.style.display = 'none';

  renderCashierSettingsList();
  alert(`✅ Karyawan "${name}" berhasil didaftarkan dengan jadwal ${assignedShift} & PIN: ${newStaff.pin}!`);
}

// Render Tabel Daftar Karyawan & Hak Akses
function renderCashierSettingsList() {
  const listContainer = document.getElementById('cashier-settings-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (staffAccounts.length === 0) {
    listContainer.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; padding:0.5rem;">Belum ada karyawan. Silakan tambah karyawan di atas.</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'data-table';
  table.style.fontSize = '0.85rem';
  table.style.width = '100%';

  table.innerHTML = `
    <thead>
      <tr>
        <th>Nama Karyawan</th>
        <th>PIN</th>
        <th>Jadwal Shift</th>
        <th>Status Shift</th>
        <th>Hak Akses Menu</th>
        <th style="width: 140px; text-align: center;">Aksi</th>
      </tr>
    </thead>
    <tbody id="staff-settings-tbody"></tbody>
  `;

  listContainer.appendChild(table);
  const tbody = table.querySelector('#staff-settings-tbody');

  staffAccounts.forEach((s, idx) => {
    const tr = document.createElement('tr');
    
    // Ringkasan izin yang aktif
    const perms = [];
    if (s.permissions.pos) perms.push('Kasir');
    if (s.permissions.transactions) perms.push('Transaksi');
    if (s.permissions.products) perms.push('Produk');
    if (s.permissions.kulak) perms.push('Kulak');
    if (s.permissions.customers) perms.push('Member');
    if (s.permissions.analytics) perms.push('📊 Laba');
    if (s.permissions.settings) perms.push('⚙️ Pengaturan');
    if (s.permissions.opname) perms.push('Stock Opname');
    if (s.permissions.expired) perms.push('Expired');
    if (s.permissions.bundles) perms.push('Bundling');
    if (s.permissions.expenses) perms.push('Kas Kecil');
    if (s.permissions.deleteTx) perms.push('🗑️ Hapus Transaksi');
    if (s.permissions.editPrice) perms.push('✏️ Ubah Harga');

    const permBadges = perms.map(p => `<span style="display:inline-block; background:rgba(234,88,12,0.1); color:#ea580c; padding:1px 6px; border-radius:4px; font-size:0.75rem; margin:1px;">${p}</span>`).join(' ');

    const assignedShift = s.assignedShift || 'Shift Pagi (07:00 - 15:00)';
    const isShiftActive = s.shiftStatus === 'aktif';
    const shiftBadge = isShiftActive 
      ? `<span style="display:inline-flex; align-items:center; gap:4px; background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:700;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#16a34a;"></span> Aktif</span>`
      : `<span style="display:inline-flex; align-items:center; gap:4px; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#94a3b8;"></span> Tutup</span>`;

    tr.innerHTML = `
      <td>
        <strong>${s.name}</strong>
        ${(currentUserRole === 'staff' && activeCashier === s.name) ? '<span style="color:#10b981; font-weight:700; margin-left:4px;">(Sedang Login)</span>' : ''}
      </td>
      <td>
        <span style="font-family: monospace; background: var(--bg-surface-elevated); padding: 2px 6px; border-radius: 4px;">••••</span>
      </td>
      <td>
        <span style="font-weight:600; color:var(--text-main); font-size:0.8rem;">${assignedShift}</span>
      </td>
      <td>
        ${shiftBadge}
      </td>
      <td>${permBadges || '<span style="color:red;">Hanya Kasir POS</span>'}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap;">
          <button class="btn btn-secondary btn-sm" onclick="openEditStaffModal(${idx})" title="Edit Jadwal Shift, Hak Akses & PIN" style="padding: 3px 8px; font-size: 0.78rem;">
            Edit
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteStaffAccount(${idx})" title="Hapus Karyawan" style="padding: 3px 8px; font-size: 0.78rem;">
            Hapus
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Buka Modal Edit Karyawan
function openEditStaffModal(index) {
  const staff = staffAccounts[index];
  if (!staff) return;

  document.getElementById('edit-staff-original-name').value = staff.name;
  document.getElementById('edit-staff-name-input').value = staff.name;
  document.getElementById('edit-staff-pin-input').value = '';
  document.getElementById('edit-staff-modal-title').textContent = `Edit Karyawan & Shift: ${staff.name}`;

  const shiftSelect = document.getElementById('edit-staff-shift-select');
  const custCont = document.getElementById('edit-custom-shift-container');
  const currentShift = staff.assignedShift || 'Shift Pagi (07:00 - 15:00)';

  if (shiftSelect) {
    const knownValues = [
      'Shift Pagi (07:00 - 15:00)',
      'Shift Siang (15:00 - 21:00)',
      'Shift Malam (21:00 - 07:00)',
      'Shift Fleksibel / Full Day'
    ];
    if (knownValues.includes(currentShift)) {
      shiftSelect.value = currentShift;
      if (custCont) custCont.style.display = 'none';
    } else {
      // Shift kustom dengan jam tertentu
      shiftSelect.value = 'custom';
      if (custCont) custCont.style.display = 'block';
      // Coba parse jam jika dalam format "... (HH:mm - HH:mm)"
      const match = currentShift.match(/^(.*?)\s*\(([0-9]{1,2}:[0-9]{2})\s*-\s*([0-9]{1,2}:[0-9]{2})\)$/);
      if (match) {
        if (document.getElementById('edit-shift-label')) document.getElementById('edit-shift-label').value = match[1].trim();
        if (document.getElementById('edit-shift-start-time')) document.getElementById('edit-shift-start-time').value = match[2];
        if (document.getElementById('edit-shift-end-time')) document.getElementById('edit-shift-end-time').value = match[3];
      } else {
        if (document.getElementById('edit-shift-label')) document.getElementById('edit-shift-label').value = currentShift;
      }
    }
  }

  // Checklist
  document.getElementById('edit-perm-transactions').checked = !!staff.permissions.transactions;
  document.getElementById('edit-perm-products').checked = !!staff.permissions.products;
  document.getElementById('edit-perm-kulak').checked = !!staff.permissions.kulak;
  document.getElementById('edit-perm-customers').checked = !!staff.permissions.customers;
  document.getElementById('edit-perm-analytics').checked = !!staff.permissions.analytics;
  document.getElementById('edit-perm-settings').checked = !!staff.permissions.settings;
  const opnameCb = document.getElementById('edit-perm-opname');
  if (opnameCb) opnameCb.checked = !!staff.permissions.opname;
  const expiredCb = document.getElementById('edit-perm-expired');
  if (expiredCb) expiredCb.checked = !!staff.permissions.expired;
  const bundlesCb = document.getElementById('edit-perm-bundles');
  if (bundlesCb) bundlesCb.checked = !!staff.permissions.bundles;
  const expCb = document.getElementById('edit-perm-expenses');
  if (expCb) expCb.checked = !!staff.permissions.expenses;
  const delCb = document.getElementById('edit-perm-delete-tx');
  if (delCb) delCb.checked = !!staff.permissions.deleteTx;
  const priceCb = document.getElementById('edit-perm-edit-price');
  if (priceCb) priceCb.checked = !!staff.permissions.editPrice;

  document.getElementById('edit-staff-modal').style.display = 'flex';
}

function closeEditStaffModal() {
  const modal = document.getElementById('edit-staff-modal');
  if (modal) modal.style.display = 'none';
}

// Simpan Perubahan Edit Karyawan
function saveStaffPermissions() {
  const origName = document.getElementById('edit-staff-original-name').value;
  const newName = document.getElementById('edit-staff-name-input').value.trim();
  const newPin = document.getElementById('edit-staff-pin-input').value.trim();
  const shiftSelect = document.getElementById('edit-staff-shift-select');
  
  let newShift = shiftSelect ? shiftSelect.value : 'Shift Pagi (07:00 - 15:00)';
  if (newShift === 'custom') {
    const start = document.getElementById('edit-shift-start-time')?.value || '08:00';
    const end = document.getElementById('edit-shift-end-time')?.value || '16:00';
    const label = document.getElementById('edit-shift-label')?.value.trim() || 'Shift Kustom';
    newShift = `${label} (${start} - ${end})`;
  }

  if (!newName) {
    alert("Nama karyawan tidak boleh kosong!");
    return;
  }

  const staff = staffAccounts.find(s => s.name === origName);
  if (!staff) return;

  staff.name = newName;
  staff.assignedShift = newShift;

  if (newPin) {
    if (newPin.length < 4) {
      alert("PIN baru minimal 4 digit angka!");
      return;
    }
    staff.pin = newPin;
  }

  staff.permissions = {
    pos: true,
    transactions: document.getElementById('edit-perm-transactions').checked,
    products: document.getElementById('edit-perm-products').checked,
    kulak: document.getElementById('edit-perm-kulak').checked,
    customers: document.getElementById('edit-perm-customers').checked,
    analytics: document.getElementById('edit-perm-analytics').checked,
    settings: document.getElementById('edit-perm-settings').checked,
    opname: document.getElementById('edit-perm-opname') ? document.getElementById('edit-perm-opname').checked : false,
    expired: document.getElementById('edit-perm-expired') ? document.getElementById('edit-perm-expired').checked : false,
    bundles: document.getElementById('edit-perm-bundles') ? document.getElementById('edit-perm-bundles').checked : false,
    expenses: document.getElementById('edit-perm-expenses') ? document.getElementById('edit-perm-expenses').checked : false,
    deleteTx: document.getElementById('edit-perm-delete-tx') ? document.getElementById('edit-perm-delete-tx').checked : false,
    editPrice: document.getElementById('edit-perm-edit-price') ? document.getElementById('edit-perm-edit-price').checked : false
  };

  localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));

  // Update nama di daftar cashiers jika berubah
  const cIdx = cashiers.indexOf(origName);
  if (cIdx !== -1) {
    cashiers[cIdx] = newName;
    localStorage.setItem('kasir_cashiers', JSON.stringify(cashiers));
  }

  if (activeCashier === origName) {
    activeCashier = newName;
    localStorage.setItem('kasir_active_cashier', activeCashier);
  }

  closeEditStaffModal();
  renderCashierSettingsList();
  updateCashierAuthUI();
  alert(`✅ Data karyawan "${newName}" dan jadwal ${newShift} berhasil disimpan!`);
}

// Hapus Karyawan
function deleteStaffAccount(index) {
  const staff = staffAccounts[index];
  if (!staff) return;

  if (confirm(`Yakin ingin menghapus karyawan "${staff.name}"?`)) {
    staffAccounts.splice(index, 1);
    localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));

    cashiers = cashiers.filter(c => c !== staff.name);
    localStorage.setItem('kasir_cashiers', JSON.stringify(cashiers));

    if (activeCashier === staff.name) {
      activeCashier = 'Owner Toko';
      currentUserRole = 'owner';
      localStorage.setItem('kasir_active_cashier', activeCashier);
      localStorage.setItem('kasir_current_user_role', currentUserRole);
    }

    renderCashierSettingsList();
    updateCashierAuthUI();
    alert(`Karyawan "${staff.name}" telah dihapus.`);
  }
}

// Inisialisasi kasir saat pertama kali aplikasi dibuka
function initCashiers() {
  updateCashierAuthUI();
  renderCashierSettingsList();
  loadMasterShiftSettingsUI();

  // Jika wajib login diaktifkan oleh Owner, langsung suguhkan modal login saat buka aplikasi
  if (isStaffLoginEnabled) {
    setTimeout(() => {
      openCashierLoginModal(true); // mode wajib
    }, 400);
  }
}

// --- PINTASAN KEYBOARD GLOBAL ---

function handleGlobalKeydowns(e) {
  const paymentModal = document.getElementById('payment-modal');
  const receiptModal = document.getElementById('receipt-modal');
  
  const isPaymentOpen = paymentModal.classList.contains('active');
  const isReceiptOpen = receiptModal.classList.contains('active');
  
  // Modals have global priority across all tabs
  if (isReceiptOpen || isPaymentOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (isReceiptOpen) closeReceiptModal();
      else if (isPaymentOpen) closePaymentModal();
      return;
    }
    
    if (isReceiptOpen) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        selectedReceiptButtonIndex = (selectedReceiptButtonIndex - 1 + 3) % 3;
        updateReceiptButtonsHighlight();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        selectedReceiptButtonIndex = (selectedReceiptButtonIndex + 1) % 3;
        updateReceiptButtonsHighlight();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedReceiptButtonIndex === 0) {
          window.print();
        } else if (selectedReceiptButtonIndex === 1) {
          shareCurrentReceiptToWhatsApp();
        } else {
          closeReceiptModal();
        }
        return;
      }
    } else if (isPaymentOpen) {
      if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setQuickCash('pass');
        return;
      }
      if (e.key === 'Enter') {
        if (document.activeElement && document.activeElement.id === 'customer-name-input') {
          // Handled by handleCustomerInputKeydowns to select or move focus to cash-received
          return;
        }
        const btnSubmit = document.getElementById('btn-submit-payment');
        if (btnSubmit && !btnSubmit.disabled) {
          e.preventDefault();
          processCheckout();
        }
        return;
      }
    }
    // Jika modal pembayaran atau struk sedang terbuka, jangan jalankan shortcut di luar modal (seperti navigasi keranjang)
    return;
  }
  
  // Non-modal shortcuts are POS-only
  if (activeTab !== 'pos') return;
  
  if (e.key === 'Escape') {
    e.preventDefault();
    if (cart.length > 0) {
      clearCart();
    }
    return;
  }
  
  if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (cart.length > 0) {
      e.preventDefault();
      openPaymentModal();
    }
    return;
  }
  
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    const searchInput = document.getElementById('search-input');
    // Jika focus bukan di search input, arahkan ke search input agar navigasi keranjang berfungsi
    if (document.activeElement !== searchInput && activeTag !== 'TEXTAREA' && activeTag !== 'SELECT') {
      searchInput.focus();
    }
  }

}

// --- UTILITY FUNCTIONS ---
function formatRupiah(number) {
  const val = Number(number);
  if (isNaN(val) || !isFinite(val)) return '0';
  return new Intl.NumberFormat('id-ID').format(val);
}

// --- Generator Barcode JsBarcode ---
function getBarcodeHTML(text, options = {}) {
  if (!text) return '';
  try {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(svg, text, { 
      width: options.width || 1.5, 
      height: options.height || 32, 
      displayValue: false, 
      margin: 0,
      background: "transparent"
    });
    return svg.outerHTML;
  } catch (e) {
    console.error("Barcode generation error:", e);
    return '';
  }
}


// State Riwayat Transaksi & Edit Transaksi
let editTxItems = [];
let editTxOriginalItems = [];
let editTxFilteredProducts = [];
let selectedEditTxFloatIndex = -1;
let currentEditingTxId = null;

// State halaman pagination transaksi
let currentTxPage = 1;
const TX_PER_PAGE = 20;

function renderTransactionsTable() {
  const tbody = document.getElementById('transactions-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const searchVal = document.getElementById('transaction-list-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('tx-filter-status').value;
  
  // Urutkan transaksi dari yang terbaru ke terlama
  const sortedTxs = [...transactions].sort((a, b) => {
    return parseTxDate(b.waktu).getTime() - parseTxDate(a.waktu).getTime();
  });
  
  const startDateEl = document.getElementById('tx-filter-start-date');
  const endDateEl = document.getElementById('tx-filter-end-date');
  
  const startDateVal = startDateEl ? startDateEl.value : '';
  const endDateVal = endDateEl ? endDateEl.value : '';
  
  let startLimit = startDateVal ? new Date(startDateVal + "T00:00:00") : null;
  let endLimit = endDateVal ? new Date(endDateVal + "T23:59:59") : null;
  
  const filteredTxs = sortedTxs.filter(tx => {
    const itemsStr = Array.isArray(tx.items) 
      ? tx.items.map(item => item.nama).join(" ").toLowerCase()
      : (tx.daftar_item || tx.items || "").toLowerCase();
      
    const txDate = parseTxDate(tx.waktu);
    const waktuStr = txDate.toLocaleString('id-ID').toLowerCase();
    const customerName = (tx.nama_pelanggan || tx.pelanggan || '').toLowerCase();
    
    const matchesSearch = String(tx.id).toLowerCase().includes(searchVal) || 
                          waktuStr.includes(searchVal) ||
                          itemsStr.includes(searchVal) ||
                          tx.total.toString().includes(searchVal) ||
                          customerName.includes(searchVal);
                          
    if (!matchesSearch) return false;
    
    // Filter status pembayaran
    if (statusFilter === 'Lunas' && tx.status_pembayaran === 'Bon') return false;
    if (statusFilter === 'Bon' && tx.status_pembayaran !== 'Bon') return false;
    
    // Filter rentang tanggal (hanya jika diisi oleh pengguna)
    if (searchVal === '') {
      if (startLimit && txDate < startLimit) return false;
      if (endLimit && txDate > endLimit) return false;
    }
    
    return true;
  });
  
  const totalCount = filteredTxs.length;
  const paginationEl = document.getElementById('transactions-pagination');
  const countHelpEl = document.getElementById('transaction-search-count');

  // Pastikan currentTxPage valid
  const totalPages = Math.ceil(totalCount / TX_PER_PAGE);
  if (currentTxPage < 1) currentTxPage = 1;
  if (totalPages > 0 && currentTxPage > totalPages) currentTxPage = totalPages;

  const startIdx = (currentTxPage - 1) * TX_PER_PAGE;
  const endIdx = Math.min(startIdx + TX_PER_PAGE, totalCount);
  const txsToRender = filteredTxs.slice(startIdx, endIdx);

  // Update keterangan jumlah
  if (countHelpEl) {
    if (totalCount === 0) {
      countHelpEl.textContent = `Tidak ada transaksi ditemukan.`;
    } else {
      countHelpEl.textContent = `Menampilkan ${startIdx + 1}–${endIdx} dari ${totalCount} transaksi.`;
    }
  }

  // Render pagination
  if (paginationEl) {
    if (totalPages <= 1) {
      paginationEl.style.display = 'none';
    } else {
      paginationEl.style.display = 'flex';
      renderTxPagination(totalPages, currentTxPage);
    }
  }
  
  if (filteredTxs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;">Tidak ada transaksi ditemukan.</td></tr>`;
    updateBulkTxButtonState();
    return;
  }
  
  txsToRender.forEach(tx => {
    const tr = document.createElement('tr');
    const isChecked = selectedTransactionIds.has(tx.id);
    
    let itemsDisplay = "";
    if (Array.isArray(tx.items)) {
      itemsDisplay = tx.items.map(item => `${item.nama} (${item.qty}x)`).join(", ");
    } else {
      itemsDisplay = tx.daftar_item || tx.items || "";
    }
    
    const timeStr = parseTxDate(tx.waktu).toLocaleString('id-ID', { hour12: false });
    
    // Status Pembayaran badge & kembalian display
    let statusBadge = '';
    let changeOrDebtDisplay = '';
    let settleBtnHtml = '';
    
    if (tx.status_pembayaran === 'Bon') {
      statusBadge = `<span class="cat-btn" style="background-color: rgba(239,68,68,0.1); color: var(--color-danger); border-color: rgba(239,68,68,0.2); cursor: default; margin: 0; font-size: 0.75rem;">Bon</span>`;
      changeOrDebtDisplay = `<span style="color: var(--color-danger); font-weight: 700;">Sisa: Rp ${formatRupiah(tx.sisa_piutang)}</span>`;
      if (tx.sisa_piutang > 0) {
        settleBtnHtml = `
          <button class="action-icon-btn btn-edit" onclick="openSettleDebtModal('${tx.id}')" title="Pelunasan Bon" style="color: var(--color-success); background-color: rgba(16,185,129,0.1);">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </button>
        `;
      }
    } else {
      statusBadge = `<span class="cat-btn" style="background-color: rgba(16,185,129,0.1); color: var(--color-success); border-color: rgba(16,185,129,0.2); cursor: default; margin: 0; font-size: 0.75rem;">Lunas</span>`;
      changeOrDebtDisplay = `<span style="color: var(--color-success); font-weight: 700;">Rp ${formatRupiah(tx.kembalian)}</span>`;
    }
    
    const customerDisplay = tx.nama_pelanggan ? `<br><small style="color: var(--text-muted); font-size: 0.75rem;">Pelanggan: <strong>${tx.nama_pelanggan}</strong></small>` : '';
    
    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="tx-select-checkbox" data-id="${tx.id}" ${isChecked ? 'checked' : ''} onchange="toggleTransactionSelection('${tx.id}', this)">
      </td>
      <td><strong>${tx.id}</strong>${customerDisplay}</td>
      <td>${timeStr}</td>
      <td><span style="font-weight: 600; font-size: 0.85rem;">${tx.kasir || 'Kasir Utama'}</span></td>
      <td><span class="text-muted" style="font-size: 0.8rem;">${itemsDisplay}</span></td>
      <td style="font-weight: 700;">Rp ${formatRupiah(tx.total)}</td>
      <td><span style="font-size: 0.85rem; display: flex; align-items: center; gap: 0.25rem;">${tx.metode_pembayaran || 'Tunai'} ${statusBadge}</span></td>
      <td>Rp ${formatRupiah(tx.bayar)}</td>
      <td>${changeOrDebtDisplay}</td>
      <td>
        <div style="display: flex; gap: 0.35rem;">
          ${settleBtnHtml}
          <button class="action-icon-btn btn-edit" onclick="openEditTransactionModal('${tx.id}')" title="Edit Transaksi">
            <svg viewBox="0 0 24 24" class="icon-sm"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="action-icon-btn btn-edit" onclick="reprintReceipt('${tx.id}')" title="Cetak Ulang / Reprint Nota" style="color: var(--color-primary); background-color: rgba(202,138,4,0.1);">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button class="action-icon-btn btn-edit" onclick="shareReceiptFromList('${tx.id}')" title="Kirim Nota ke WhatsApp" style="color: #25d366; background-color: rgba(37,211,102,0.15); width: 34px; height: 34px; border-radius: 8px;">
            <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: #25d366;"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.2.662.591 1.221.774 1.394.86.173.086.275.072.376-.044.101-.116.433-.506.549-.68.116-.173.231-.145.39-.086s1.011.477 1.184.564.289.13.332.203c.043.071.043.419-.101.824z"/></svg>
          </button>
          <button class="action-icon-btn btn-delete" onclick="deleteTransaction('${tx.id}')" title="Hapus Transaksi">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  updateBulkTxButtonState();
}

// Render tabel dari data sementara (hasil pencarian cloud) tanpa menimpa transactions lokal
function renderTransactionsTableFromData(data) {
  const tbody = document.getElementById('transactions-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const countHelpEl = document.getElementById('transaction-search-count');
  const paginationEl = document.getElementById('transactions-pagination');
  if (paginationEl) paginationEl.style.display = 'none';

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Tidak ada transaksi ditemukan untuk pencarian ini.</td></tr>`;
    if (countHelpEl) countHelpEl.textContent = 'Tidak ada transaksi ditemukan.';
    return;
  }

  if (countHelpEl) countHelpEl.textContent = `Menampilkan ${data.length} hasil pencarian dari cloud.`;

  const sortedData = [...data].sort((a, b) => new Date(b.waktu) - new Date(a.waktu));

  sortedData.forEach(tx => {
    const tr = document.createElement('tr');

    let itemsDisplay = '';
    if (Array.isArray(tx.items) && tx.items.length > 0) {
      itemsDisplay = tx.items.map(item => `${item.nama} (${item.qty}x)`).join(', ');
    } else {
      itemsDisplay = tx.daftar_item || tx.items || '';
    }

    const timeStr = tx.waktu ? new Date(tx.waktu).toLocaleString('id-ID', { hour12: false }) : '-';

    let statusBadge = '';
    let changeOrDebtDisplay = '';
    if (tx.status_pembayaran === 'Bon') {
      statusBadge = `<span class="cat-btn" style="background-color: rgba(239,68,68,0.1); color: var(--color-danger); border-color: rgba(239,68,68,0.2); cursor: default; margin: 0; font-size: 0.75rem;">Bon</span>`;
      changeOrDebtDisplay = `<span style="color: var(--color-danger); font-weight: 700;">Sisa: Rp ${formatRupiah(tx.sisa_piutang)}</span>`;
    } else {
      statusBadge = `<span class="cat-btn" style="background-color: rgba(16,185,129,0.1); color: var(--color-success); border-color: rgba(16,185,129,0.2); cursor: default; margin: 0; font-size: 0.75rem;">Lunas</span>`;
      changeOrDebtDisplay = `<span style="color: var(--color-success); font-weight: 700;">Rp ${formatRupiah(tx.kembalian)}</span>`;
    }

    const customerDisplay = tx.nama_pelanggan
      ? `<br><small style="color: var(--text-muted); font-size: 0.75rem;">Pelanggan: <strong>${tx.nama_pelanggan}</strong></small>`
      : '';

    tr.innerHTML = `
      <td><strong>${tx.id}</strong>${customerDisplay}</td>
      <td>${timeStr}</td>
      <td><span style="font-weight: 600; font-size: 0.85rem;">${tx.kasir || 'Kasir Utama'}</span></td>
      <td><span class="text-muted" style="font-size: 0.8rem;">${itemsDisplay}</span></td>
      <td style="font-weight: 700;">Rp ${formatRupiah(tx.total)}</td>
      <td><span style="font-size: 0.85rem; display: flex; align-items: center; gap: 0.25rem;">${tx.metode_pembayaran || 'Tunai'} ${statusBadge}</span></td>
      <td>Rp ${formatRupiah(tx.bayar)}</td>
      <td>${changeOrDebtDisplay}</td>
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="action-icon-btn btn-edit" onclick="reprintReceipt('${tx.id}')" title="Cetak Ulang Nota" style="color: var(--color-primary); background-color: rgba(202,138,4,0.1);">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button class="action-icon-btn btn-edit" onclick="shareReceiptFromList('${tx.id}')" title="Kirim Nota ke WhatsApp" style="color: #25d366; background-color: rgba(37,211,102,0.15); width: 34px; height: 34px; border-radius: 8px;">
            <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: #25d366;"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.2.662.591 1.221.774 1.394.86.173.086.275.072.376-.044.101-.116.433-.506.549-.68.116-.173.231-.145.39-.086s1.011.477 1.184.564.289.13.332.203c.043.071.043.419-.101.824z"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Render tombol pagination untuk tabel transaksi
function renderTxPagination(totalPages, currentPage) {
  const paginationEl = document.getElementById('transactions-pagination');
  if (!paginationEl) return;
  paginationEl.innerHTML = '';

  const btnStyle = (active) => `
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 2.1rem; height: 2.1rem; padding: 0 0.5rem;
    border-radius: 6px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid var(--border-color);
    background: ${active ? '#ea580c' : 'var(--bg-card, #fff)'};
    color: ${active ? '#fff' : 'var(--text-main)'};
    transition: all 0.15s; font-family: var(--font-main);
  `;

  const makeBtn = (label, page, active = false, disabled = false) => {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.style.cssText = btnStyle(active);
    if (disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
    }
    if (!disabled && !active) {
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-body, #f1f5f9)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-card, #fff)'; });
    }
    if (!disabled) {
      btn.onclick = () => { currentTxPage = page; renderTransactionsTable(); };
    }
    return btn;
  };

  // Tombol ‹ Sebelumnya
  paginationEl.appendChild(makeBtn('&#8249;', currentPage - 1, false, currentPage === 1));

  // Nomor halaman dengan ellipsis
  const pageRange = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageRange.push(i);
  } else {
    pageRange.push(1);
    if (currentPage > 4) pageRange.push('...');
    const start = Math.max(2, currentPage - 2);
    const end = Math.min(totalPages - 1, currentPage + 2);
    for (let i = start; i <= end; i++) pageRange.push(i);
    if (currentPage < totalPages - 3) pageRange.push('...');
    pageRange.push(totalPages);
  }

  pageRange.forEach(item => {
    if (item === '...') {
      const el = document.createElement('span');
      el.textContent = '...';
      el.style.cssText = 'padding: 0 0.25rem; color: var(--text-muted); font-weight: 600;';
      paginationEl.appendChild(el);
    } else {
      paginationEl.appendChild(makeBtn(item, item, item === currentPage));
    }
  });

  // Tombol › Berikutnya
  paginationEl.appendChild(makeBtn('&#8250;', currentPage + 1, false, currentPage === totalPages));
}

let txFilterTimeout = null;
function filterTransactionsTable() {
  if (txFilterTimeout) clearTimeout(txFilterTimeout);
  txFilterTimeout = setTimeout(() => {
    currentTxPage = 1;

    const startDate = document.getElementById('tx-filter-start-date').value;
    const endDate   = document.getElementById('tx-filter-end-date').value;
    const keyword   = document.getElementById('transaction-list-search').value.trim();

    // Cek apakah filter tanggal mengarah ke hari selain hari ini (Gunakan tanggal lokal Indonesia)
    const todayStr = getLocalISODate(new Date()).slice(0, 10);
    const isSearchingHistory = (startDate && startDate !== todayStr) || (endDate && endDate !== todayStr);

    // Filter lokal - data selalu up-to-date dari Realtime Database listener
    renderTransactionsTable();
  }, 600);
}

// --- SELEKSI & HAPUS MASSAL TRANSAKSI ---
function toggleTransactionSelection(txId, checkbox) {
  if (checkbox && checkbox.checked) {
    selectedTransactionIds.add(txId);
  } else {
    selectedTransactionIds.delete(txId);
  }
  updateBulkTxButtonState();
}

function toggleSelectAllTransactions(masterCheckbox) {
  const checkboxes = document.querySelectorAll('.tx-select-checkbox');
  const isChecked = masterCheckbox ? masterCheckbox.checked : false;

  checkboxes.forEach(cb => {
    cb.checked = isChecked;
    const txId = cb.dataset.id;
    if (txId) {
      if (isChecked) {
        selectedTransactionIds.add(txId);
      } else {
        selectedTransactionIds.delete(txId);
      }
    }
  });

  updateBulkTxButtonState();
}

function updateBulkTxButtonState() {
  const count = selectedTransactionIds.size;
  const btnBulk = document.getElementById('btn-bulk-delete-txs');
  const countEl = document.getElementById('bulk-tx-count');

  if (btnBulk && countEl) {
    if (count > 0) {
      countEl.textContent = count;
      btnBulk.style.display = 'inline-flex';
    } else {
      btnBulk.style.display = 'none';
    }
  }

  const masterCb = document.getElementById('select-all-transactions');
  if (masterCb) {
    const checkboxes = document.querySelectorAll('.tx-select-checkbox');
    if (checkboxes.length === 0) {
      masterCb.checked = false;
      masterCb.indeterminate = false;
    } else {
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      const someChecked = Array.from(checkboxes).some(cb => cb.checked);
      masterCb.checked = allChecked;
      masterCb.indeterminate = !allChecked && someChecked;
    }
  }
}

// Hapus satu transaksi
async function deleteTransaction(txId) {
  if (!canPerformAction('deleteTx')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk menghapus transaksi! Silakan hubungi Pemilik Toko (Owner).");
    return;
  }

  if (!confirm(`Apakah Anda yakin ingin menghapus transaksi "${txId}"? Tindakan ini akan mengembalikan stok barang ke inventaris.`)) {
    return;
  }

  const txIndex = transactions.findIndex(t => t.id === txId);
  if (txIndex === -1) {
    alert("Transaksi tidak ditemukan!");
    return;
  }

  const tx = transactions[txIndex];
  recentlyDeletedTxIds.add(txId);
  saveDeletedTxIdsLocally();

  // Kembalikan stok untuk semua barang di transaksi ini
  if (Array.isArray(tx.items)) {
    tx.items.forEach(item => {
      if (item.isBundle && Array.isArray(item.bundleItems)) {
        item.bundleItems.forEach(bComp => {
          const compProd = products.find(p => String(p.id) === String(bComp.productId));
          if (compProd) {
            compProd.stok += ((Number(bComp.qty) || 1) * (Number(item.qty) || 1));
          }
        });
      } else {
        const product = products.find(p => p.id === item.id);
        if (product) {
          product.stok += (item.isBox ? (item.qty * (item.isiBox || 1)) : (item.isGrosir ? (item.qty * (item.grosirQty || 1)) : item.qty));
          if (item.isPromo && !item.isBonus) {
            product.kuota_diskon = (parseInt(product.kuota_diskon) || 0) + item.qty;
          }
        }
      }
    });
  }

  // Hapus transaksi dari cache lokal
  transactions.splice(txIndex, 1);
  selectedTransactionIds.delete(txId);

  // Rollback Poin & Kuota Voucher Pelanggan
  if (tx.id_pelanggan || tx.nama_pelanggan) {
    const cust = customers.find(c => c.id === tx.id_pelanggan || c.nama === tx.nama_pelanggan);
    if (cust) {
      if (tx.poin_didapat && Number(tx.poin_didapat) > 0) {
        cust.poin = Math.max(0, (cust.poin || 0) - Number(tx.poin_didapat));
      }
      if (tx.poin_ditukar && Number(tx.poin_ditukar) > 0) {
        cust.poin = (cust.poin || 0) + Number(tx.poin_ditukar);
      }
      if (tx.voucher_ditukar && Number(tx.voucher_ditukar) > 0) {
        const txMonth = (tx.waktu || '').slice(0, 7) || (new Date().toISOString().slice(0, 7));
        if (cust.voucherUsage && cust.voucherUsage[txMonth]) {
          cust.voucherUsage[txMonth].used = Math.max(0, (cust.voucherUsage[txMonth].used || 0) - Number(tx.voucher_ditukar));
        }
      }
      saveCustomersLocally();
      if (typeof saveCustomerCloud === 'function') {
        saveCustomerCloud(cust);
      }
    }
  }

  // Simpan data lokal
  saveProductsLocally();
  saveTransactionsLocally();

  // Render ulang UI
  renderTransactionsTable();
  renderProductsTable();
  updateAnalytics();

  // Hapus dari RTDB & update stok produk
  if (firebaseDb) {
    updateSyncStatus('syncing', 'Menghapus transaksi dari database...');
    try {
      const updates = {};
      updates[getStorePath('transactions/' + txId)] = null;

      if (Array.isArray(tx.items)) {
        tx.items.forEach(item => {
          const p = products.find(prod => prod.id === item.id);
          if (p) {
            updates[getStorePath('products/' + p.id + '/stok')] = p.stok;
            updates[getStorePath('products/' + p.id + '/kuota_diskon')] = p.kuota_diskon || 0;
          }
        });
      }

      await firebaseDb.ref('/').update(updates);
      console.log('✅ Transaksi berhasil dihapus dari RTDB:', txId);
      updateSyncStatus('online', 'Database Terhubung');
    } catch (err) {
      console.error('❌ Gagal hapus transaksi dari RTDB:', err.message);
      updateSyncStatus('offline', 'Gagal hapus: ' + err.message);
      alert(`⚠️ Peringatan: Transaksi dihapus dari perangkat ini, namun gagal dihapus dari cloud database (${err.message}).`);
      return;
    }
  }

  alert(`✅ Transaksi ${txId} berhasil dihapus dan stok barang dikembalikan.`);
}

// Hapus banyak transaksi sekaligus (Bulk Delete)
async function deleteSelectedTransactions() {
  const idsToDelete = Array.from(selectedTransactionIds);
  if (idsToDelete.length === 0) {
    alert("Silakan pilih transaksi yang ingin dihapus terlebih dahulu.");
    return;
  }

  const confirmMsg = `⚠️ PERINGATAN HAPUS MASSAL\n\nAnda akan menghapus ${idsToDelete.length} transaksi sekaligus.\nStok seluruh barang pada transaksi-transaksi tersebut akan otomatis dikembalikan ke inventaris.\n\nApakah Anda yakin ingin melanjutkan?`;
  if (!confirm(confirmMsg)) {
    return;
  }

  const affectedProductsMap = new Map();
  let deletedCount = 0;

  // Lakukan pengembalian stok & hapus dari array lokal
  idsToDelete.forEach(txId => {
    recentlyDeletedTxIds.add(txId);
    const idx = transactions.findIndex(t => t.id === txId);
    if (idx !== -1) {
      const tx = transactions[idx];
      if (Array.isArray(tx.items)) {
        tx.items.forEach(item => {
          if (item.isBundle && Array.isArray(item.bundleItems)) {
            item.bundleItems.forEach(bComp => {
              const compProd = products.find(p => String(p.id) === String(bComp.productId));
              if (compProd) {
                compProd.stok += ((Number(bComp.qty) || 1) * (Number(item.qty) || 1));
                affectedProductsMap.set(compProd.id, compProd);
              }
            });
          } else {
            const product = products.find(p => p.id === item.id);
            if (product) {
              const addedStock = (item.isBox ? (item.qty * (item.isiBox || 1)) : (item.isGrosir ? (item.qty * (item.grosirQty || 1)) : item.qty));
              product.stok += addedStock;
              if (item.isPromo && !item.isBonus) {
                product.kuota_diskon = (parseInt(product.kuota_diskon) || 0) + item.qty;
              }
              affectedProductsMap.set(product.id, product);
            }
          }
        });
      }
      transactions.splice(idx, 1);
      deletedCount++;
    }
  });
  saveDeletedTxIdsLocally();

  // Kosongkan seleksi
  selectedTransactionIds.clear();

  // Simpan perubahan lokal
  saveProductsLocally();
  saveTransactionsLocally();

  // Render UI
  renderTransactionsTable();
  renderProductsTable();
  updateAnalytics();

  // Sinkronisasi hapus batch ke Firebase RTDB
  if (firebaseDb) {
    updateSyncStatus('syncing', `Menghapus ${deletedCount} transaksi dari database...`);
    try {
      const cloudUpdates = {};
      idsToDelete.forEach(txId => {
        cloudUpdates[getStorePath('transactions/' + txId)] = null;
      });

      affectedProductsMap.forEach(prod => {
        cloudUpdates[getStorePath('products/' + prod.id + '/stok')] = prod.stok;
        cloudUpdates[getStorePath('products/' + prod.id + '/kuota_diskon')] = prod.kuota_diskon || 0;
      });

      await firebaseDb.ref('/').update(cloudUpdates);
      console.log(`✅ ${deletedCount} transaksi berhasil dihapus dari RTDB.`);
      updateSyncStatus('online', 'Database Terhubung');
    } catch (err) {
      console.error('❌ Gagal hapus bulk transaksi dari RTDB:', err.message);
      updateSyncStatus('offline', 'Gagal hapus massal: ' + err.message);
      alert(`⚠️ Peringatan: Transaksi dihapus dari perangkat ini, namun gagal dihapus dari cloud database (${err.message}).`);
      return;
    }
  }

  alert(`✅ Berhasil menghapus ${deletedCount} transaksi! Stok seluruh barang terkait telah dikembalikan ke inventaris.`);
}

function reprintReceipt(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  showReceipt(tx, tx.items || []);
}

function shareReceiptFromList(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  shareReceiptToWhatsApp(tx, tx.items || []);
}

function openEditTransactionModal(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  
  currentEditingTxId = txId;
  document.getElementById('edit-tx-id-title').textContent = txId;
  
  // Clone data transaksi dan pastikan cartId ada
  editTxItems = JSON.parse(JSON.stringify(tx.items || [])).map(item => {
    if (!item.cartId) item.cartId = item.id + (item.isPromo ? '_promo' : '_reguler');
    return item;
  });
  editTxOriginalItems = JSON.parse(JSON.stringify(editTxItems));
  
  // Set metode pembayaran
  const metode = tx.metode_pembayaran || 'Tunai';
  selectEditTxPaymentMethod(metode, false);
  
  // Set nilai uang bayar terformat
  const cashInput = document.getElementById('edit-tx-cash-received');
  cashInput.value = formatRupiah(tx.bayar);
  
  document.getElementById('edit-tx-search-input').value = '';
  closeEditTxFloatingResults();
  
  renderEditTxItems();
  
  document.getElementById('edit-transaction-modal').classList.add('active');
}

function closeEditTransactionModal() {
  document.getElementById('edit-transaction-modal').classList.remove('active');
  currentEditingTxId = null;
  editTxItems = [];
  editTxOriginalItems = [];
}

function renderEditTxItems() {
  const container = document.getElementById('edit-tx-items-list');
  const countBadge = document.getElementById('edit-tx-items-count');
  if (!container) return;
  container.innerHTML = '';
  
  if (countBadge) {
    const totalCount = editTxItems.reduce((acc, it) => acc + (it.qty || 1), 0);
    countBadge.textContent = `${totalCount} item (${editTxItems.length} jenis)`;
  }
  
  let total = 0;
  
  if (editTxItems.length === 0) {
    container.innerHTML = `
      <div style="padding: 2rem 1rem; text-align: center; color: var(--text-muted); background: var(--bg-surface-elevated); border: 1px dashed var(--border-color); border-radius: 12px;">
        <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; stroke: currentColor; fill: none; margin: 0 auto 0.5rem; opacity: 0.5;"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
        <p style="margin: 0; font-size: 0.88rem; font-weight: 600;">Belum ada barang di transaksi ini</p>
        <small style="font-size: 0.78rem; opacity: 0.8;">Cari barang di atas untuk menambahkan</small>
      </div>`;
    document.getElementById('edit-tx-total-amount').textContent = 'Rp 0';
    document.getElementById('edit-tx-change-amount').textContent = 'Rp 0';
    return;
  }
  
  editTxItems.forEach(item => {
    applyPricingToEditTxItem(item);
    const subtotal = item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty);
    total += subtotal;
    
    let badgesHtml = '';
    if (item.badges && item.badges.length > 0) {
      badgesHtml = item.badges.map(b => `<span class="cart-promo-badge badge-${b.type}">${b.text}</span>`).join(' ');
    }
    
    const div = document.createElement('div');
    div.className = 'edit-tx-item-card';
    div.innerHTML = `
      <div class="edit-tx-item-main">
        <div class="edit-tx-item-name" title="${item.nama}">${item.nama}</div>
        <div class="edit-tx-item-meta">
          <span class="edit-tx-unit-price">Rp ${formatRupiah(item.harga)}</span>
          ${item.isBox ? `<span style="color: var(--color-primary); font-weight:600;">(Dus/Box)</span>` : ''}
        </div>
        ${badgesHtml ? `<div style="display:flex; flex-wrap:wrap; gap:0.25rem; margin-top:0.25rem;">${badgesHtml}</div>` : ''}
      </div>
      
      <div class="edit-tx-item-action">
        <div class="edit-tx-qty-stepper">
          <button type="button" class="edit-tx-stepper-btn" onclick="stepEditTxQty('${item.cartId}', -1)">−</button>
          <input type="number" class="edit-tx-stepper-input" value="${item.qty}" min="1" onchange="updateEditTxQty('${item.cartId}', this.value)">
          <button type="button" class="edit-tx-stepper-btn" onclick="stepEditTxQty('${item.cartId}', 1)">+</button>
        </div>
        
        <span class="edit-tx-item-subtotal-val">Rp ${formatRupiah(subtotal)}</span>
        
        <button type="button" class="edit-tx-remove-btn" onclick="removeEditTxItem('${item.cartId}')" title="Hapus Barang">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;
    container.appendChild(div);
  });
  
  document.getElementById('edit-tx-total-amount').textContent = `Rp ${formatRupiah(total)}`;
  calculateChangeEditTx();
}

function stepEditTxQty(cartId, delta) {
  const item = editTxItems.find(it => it.cartId === cartId);
  if (!item) return;
  const newQty = (item.qty || 1) + delta;
  if (newQty <= 0) {
    removeEditTxItem(cartId);
  } else {
    updateEditTxQty(cartId, newQty);
  }
}

function applyPricingToEditTxItem(item) {
  if (item.isBox) {
    item.subtotal = item.qty * item.harga;
    return;
  }
  const localProd = products.find(p => p.id === item.id);
  if (!localProd) return;
  const pricing = calculateCartItemPricing(localProd, item.qty);
  item.subtotal = pricing.subtotal;
  item.harga = item.qty > 0 ? (pricing.subtotal / item.qty) : localProd.harga_jual;
  item.badges = pricing.badges;
  item.promoInfo = pricing.promoInfo;
}

function updateEditTxQty(cartId, value) {
  let qty = parseInt(value);
  const itemIndex = editTxItems.findIndex(it => it.cartId === cartId);
  if (itemIndex === -1) return;
  const item = editTxItems[itemIndex];
  
  if (isNaN(qty) || qty < 1) {
    qty = 1;
  }
  
  const localProd = products.find(p => p.id === item.id);
  if (localProd && !appConfig.allowZeroStock) {
    const origItem = editTxOriginalItems.find(it => it.id === item.id);
    const origQty = origItem ? (origItem.isBox ? origItem.qty * (origItem.isiBox || 12) : origItem.qty) : 0;
    const maxAvailable = localProd.stok + origQty;
    
    if (qty > maxAvailable) {
      alert(`Stok tidak mencukupi! Batas maksimum adalah ${maxAvailable} pcs (Stok sisa + Asli).`);
      item.qty = maxAvailable;
      applyPricingToEditTxItem(item);
      renderEditTxItems();
      return;
    }
  }
  
  item.qty = qty;
  applyPricingToEditTxItem(item);
  renderEditTxItems();
}

function removeEditTxItem(cartId) {
  const itemIndex = editTxItems.findIndex(it => it.cartId === cartId);
  if (itemIndex === -1) return;
  editTxItems.splice(itemIndex, 1);
  renderEditTxItems();
}

function filterEditTxSearch() {
  const input = document.getElementById('edit-tx-search-input');
  const val = input.value.toLowerCase().trim();
  const dropdown = document.getElementById('edit-tx-floating-results');
  
  if (val === '') {
    closeEditTxFloatingResults();
    return;
  }
  
  let matched = products.filter(p => {
    return String(p.nama).toLowerCase().includes(val) || 
           String(p.id).toLowerCase().includes(val) ||
           (p.barcode && String(p.barcode).toLowerCase().includes(val));
  });
  
  matched.sort((a, b) => {
    const aNameMatch = String(a.nama).toLowerCase().includes(val);
    const bNameMatch = String(b.nama).toLowerCase().includes(val);
    if (aNameMatch && !bNameMatch) return -1;
    if (!aNameMatch && bNameMatch) return 1;
    return 0;
  });
  
  editTxFilteredProducts = matched.slice(0, 15);
  
  if (editTxFilteredProducts.length === 0) {
    dropdown.innerHTML = '<div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.85rem;">Barang tidak ditemukan...</div>';
    dropdown.classList.add('active');
    selectedEditTxFloatIndex = -1;
    return;
  }
  
  selectedEditTxFloatIndex = 0;
  renderEditTxFloatingDropdown();
}

function renderEditTxFloatingDropdown() {
  const dropdown = document.getElementById('edit-tx-floating-results');
  dropdown.innerHTML = '';
  dropdown.classList.add('active');
  
  editTxFilteredProducts.forEach((p, index) => {
    const isSelected = index === selectedEditTxFloatIndex;
    const isOutOfStock = p.stok <= 0;
    
    const div = document.createElement('div');
    const isDropdownDisabled = isOutOfStock && !appConfig.allowZeroStock;
    div.className = `floating-item ${isSelected ? 'selected' : ''} ${isDropdownDisabled ? 'out-of-stock' : ''}`;
    div.onclick = () => {
      if (!isOutOfStock || appConfig.allowZeroStock) {
        addEditTxItem(p);
      } else {
        alert("Stok barang habis!");
      }
    };
    
    const imgUrl = p.gambar || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=100';
    
    let priceText = `Rp ${formatRupiah(p.harga_jual)}`;
    if (p.grosir_qty > 0 && p.grosir_harga > 0) {
      priceText += ` <span class="badge-grosir-price">🏷️ Grosir ${p.grosir_qty} pcs: Rp ${formatRupiah(p.grosir_harga)}</span>`;
    }
    if (p.promo_beli_x > 0 && p.promo_gratis_y > 0) {
      priceText += ` <span class="badge-promo-buyget">🎁 Beli ${p.promo_beli_x} Gratis ${p.promo_gratis_y}</span>`;
    }
    
    div.innerHTML = `
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onclick="event.stopPropagation(); openProductImageLightbox('${imgUrl}', '${escapeJsQuotes(p.nama)}')" onerror="handleImageError(this)">
      <div class="floating-item-info">
        <span class="floating-item-name">${p.nama} (${p.id})</span>
        <div class="floating-item-meta" style="flex-wrap: wrap; gap: 0.2rem; align-items: center;">
          <span class="floating-item-price">${priceText}</span>
          <span class="floating-item-stock">Stok: ${p.stok}</span>
        </div>
      </div>
    `;
    dropdown.appendChild(div);
  });
  
  const selectedEl = dropdown.querySelector('.floating-item.selected');
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: 'nearest' });
  }
}

function closeEditTxFloatingResults() {
  const dropdown = document.getElementById('edit-tx-floating-results');
  if (dropdown) dropdown.classList.remove('active');
  editTxFilteredProducts = [];
  selectedEditTxFloatIndex = -1;
}

function handleEditTxSearchInputKeydowns(e) {
  if (editTxFilteredProducts.length === 0) return;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedEditTxFloatIndex = (selectedEditTxFloatIndex + 1) % editTxFilteredProducts.length;
    renderEditTxFloatingDropdown();
  } 
  else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedEditTxFloatIndex = (selectedEditTxFloatIndex - 1 + editTxFilteredProducts.length) % editTxFilteredProducts.length;
    renderEditTxFloatingDropdown();
  } 
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedEditTxFloatIndex > -1 && selectedEditTxFloatIndex < editTxFilteredProducts.length) {
      const prod = editTxFilteredProducts[selectedEditTxFloatIndex];
      if (prod.stok > 0 || appConfig.allowZeroStock) {
        addEditTxItem(prod);
      } else {
        alert("Stok barang habis!");
      }
    }
  }
}

function addEditTxItem(product) {
  let existingItem = editTxItems.find(it => it.id === product.id && !it.isBox);
  if (existingItem) {
    let newQty = existingItem.qty + 1;
    const origItem = editTxOriginalItems.find(it => it.id === product.id);
    const origQty = origItem ? (origItem.isBox ? origItem.qty * (origItem.isiBox || 12) : origItem.qty) : 0;
    const maxAvailable = product.stok + origQty;
    
    if (newQty > maxAvailable && !appConfig.allowZeroStock) {
      alert(`Stok tidak mencukupi! Batas maksimum adalah ${maxAvailable} pcs.`);
      return;
    }
    existingItem.qty = newQty;
    applyPricingToEditTxItem(existingItem);
  } else {
    const newItem = {
      cartId: product.id,
      id: product.id,
      nama: product.nama,
      harga: product.harga_jual,
      harga_beli: product.harga_beli || 0,
      qty: 1,
      isBox: false,
      gambar: product.gambar
    };
    applyPricingToEditTxItem(newItem);
    editTxItems.unshift(newItem);
  }
  
  document.getElementById('edit-tx-search-input').value = '';
  closeEditTxFloatingResults();
  renderEditTxItems();
}

function formatAndCalculateChangeEditTx() {
  const input = document.getElementById('edit-tx-cash-received');
  const cleanVal = input.value.replace(/\D/g, "");
  if (cleanVal === "") {
    input.value = "";
  } else {
    input.value = new Intl.NumberFormat('id-ID').format(cleanVal);
  }
  calculateChangeEditTx();
}

function selectEditTxPaymentMethod(method, triggerChange = true) {
  const hiddenInput = document.getElementById('edit-tx-payment-method');
  if (hiddenInput) hiddenInput.value = method;
  
  const pills = document.querySelectorAll('.edit-tx-method-pill');
  pills.forEach(btn => {
    const isThis = btn.getAttribute('data-method') === method;
    btn.classList.toggle('active', isThis);
    if (isThis) {
      btn.style.background = 'var(--color-primary, #2563eb)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'var(--color-primary, #2563eb)';
      btn.style.boxShadow = '0 2px 8px rgba(37,99,235,0.3)';
    } else {
      btn.style.background = 'var(--bg-surface-elevated, #f8fafc)';
      btn.style.color = 'var(--text-main, #334155)';
      btn.style.borderColor = 'var(--border-color, #e2e8f0)';
      btn.style.boxShadow = 'none';
    }
  });

  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  const cashSection = document.getElementById('edit-tx-cash-section');
  if (cashSection) cashSection.style.display = nonCashMethods.includes(method) ? 'none' : 'block';
  
  if (triggerChange) {
    calculateChangeEditTx();
  }
}

function onEditTxPaymentMethodChange(value) {
  selectEditTxPaymentMethod(value, true);
}

function calculateChangeEditTx() {
  const cashInput = document.getElementById('edit-tx-cash-received');
  const changeVal = document.getElementById('edit-tx-change-amount');
  const btnSave = document.getElementById('btn-save-edited-tx');
  
  let total = 0;
  editTxItems.forEach(item => {
    total += item.harga * item.qty;
  });
  
  // Cek apakah metode non-tunai (tidak perlu hitung kembalian)
  const metode = document.getElementById('edit-tx-payment-method')?.value || 'Tunai';
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  if (nonCashMethods.includes(metode)) {
    // Non-cash: langsung enable tombol simpan
    btnSave.disabled = false;
    return;
  }
  
  const cashText = cashInput.value.replace(/\./g, "");
  const cash = parseFloat(cashText) || 0;
  const change = cash - total;
  
  const tx = transactions.find(t => t.id === currentEditingTxId);
  const isBon = tx && tx.status_pembayaran === 'Bon';
  
  if (cashInput.value === '') {
    changeVal.textContent = 'Rp 0';
    changeVal.style.color = 'var(--text-muted)';
    btnSave.disabled = false; // Enable so user can click and get the alert
  } else if (change >= 0) {
    changeVal.textContent = `Rp ${formatRupiah(change)}`;
    changeVal.style.color = 'var(--color-success)';
    btnSave.disabled = false;
  } else {
    if (isBon) {
      changeVal.textContent = `Sisa Bon Rp ${formatRupiah(Math.abs(change))}`;
      changeVal.style.color = 'var(--text-main)';
      btnSave.disabled = false;
    } else {
      changeVal.textContent = `Kurang Rp ${formatRupiah(Math.abs(change))}`;
      changeVal.style.color = 'var(--color-danger)';
      btnSave.disabled = false; // Enable so user can click and get the alert
    }
  }
}

function saveEditedTransaction() {
  if (editTxItems.length === 0) {
    alert("Daftar barang belanjaan tidak boleh kosong!");
    return;
  }
  
  // Baca metode pembayaran
  const metode = document.getElementById('edit-tx-payment-method')?.value || 'Tunai';
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  const isNonCash = nonCashMethods.includes(metode);
  
  let total = 0;
  editTxItems.forEach(item => {
    total += item.harga * item.qty;
  });
  
  let cash = total; // untuk non-cash, bayar = total (tidak ada kembalian)
  let kembalian = 0;
  
  const tx = transactions.find(t => t.id === currentEditingTxId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  
  if (!isNonCash) {
    const cashInput = document.getElementById('edit-tx-cash-received');
    const cashText = cashInput.value.replace(/\./g, "");
    cash = parseFloat(cashText) || 0;
    
    if (tx.status_pembayaran !== 'Bon' && cash < total) {
      alert("Pembayaran kurang! Silakan ubah Uang Diterima agar tidak kurang dari total tagihan.");
      return;
    }
    kembalian = cash >= total ? cash - total : 0;
  }
  
  // Update stok produk
  const allProductIds = new Set([
    ...editTxOriginalItems.map(it => it.id),
    ...editTxItems.map(it => it.id)
  ]);
  
  allProductIds.forEach(id => {
    const origQty = editTxOriginalItems.filter(it => it.id === id).reduce((sum, it) => sum + (it.isGrosir ? it.qty * (it.grosirQty || 1) : (it.isBox ? it.qty * (it.isiBox || 12) : it.qty)), 0);
    const newQty = editTxItems.filter(it => it.id === id).reduce((sum, it) => sum + (it.isGrosir ? it.qty * (it.grosirQty || 1) : (it.isBox ? it.qty * (it.isiBox || 12) : it.qty)), 0);
    const delta = newQty - origQty;
    
    if (delta !== 0) {
      const product = products.find(p => p.id === id);
      if (product) {
        product.stok = Math.max(0, product.stok - delta);
        const origPromo = editTxOriginalItems.some(it => it.id === id && it.isPromo && !it.isBonus);
        const newPromo = editTxItems.some(it => it.id === id && it.isPromo && !it.isBonus);
        if (origPromo || newPromo) {
          let prevKuota = parseInt(product.kuota_diskon) || 0;
          if (prevKuota > 0) {
            product.kuota_diskon = Math.max(0, prevKuota - delta);
            if (product.kuota_diskon === 0) {
              product.harga_diskon = 0;
            }
          }
        }
      }
    }
  });
  
  tx.items = [...editTxItems];
  tx.total = total;
  tx.bayar = cash;
  tx.kembalian = kembalian;
  tx.metode_pembayaran = metode;
  
  if (isNonCash) {
    tx.sisa_piutang = 0;
    tx.status_pembayaran = 'Lunas';
  } else {
    tx.sisa_piutang = cash < total ? total - cash : 0;
    tx.status_pembayaran = tx.sisa_piutang > 0 ? 'Bon' : 'Lunas';
  }
  
  saveProductsLocally();
  saveTransactionsLocally();
  
  closeEditTransactionModal();
  renderTransactionsTable();
  renderProductsTable();
  updateAnalytics();
  
  syncSingleTransactionToCloud(tx);
  
  if (firebaseDb && allProductIds && allProductIds.size > 0) {
    allProductIds.forEach(id => {
      const p = products.find(prod => prod.id === id);
      if (p) saveProductCloud(p);
    });
  }
  
  alert("Transaksi berhasil diperbarui!");
}

async function syncProductsToCloud() {
  if (!firebaseDb) {
    alert('Firebase Realtime Database belum terhubung. Silakan atur di Pengaturan.');
    return;
  }
  updateSyncStatus('syncing', 'Mengunggah semua produk...');
  try {
    const updates = {};
    products.forEach(p => { updates[getStorePath('products/' + p.id)] = JSON.parse(JSON.stringify(p)); });
    await firebaseDb.ref('/').update(updates);
    updateSyncStatus('online', 'Database Terhubung');
    alert('Berhasil menyinkronkan ' + products.length + ' produk ke Firebase Realtime Database! 🚀');
  } catch (err) {
    console.error('Gagal sync produk:', err);
    alert('Gagal menyinkronkan produk: ' + err.message);
  }
}

async function syncTransactionsToCloud() {
  if (!firebaseDb) {
    alert('Firebase Realtime Database belum terhubung. Silakan atur di Pengaturan.');
    return;
  }
  updateSyncStatus('syncing', 'Mengunggah semua transaksi...');
  try {
    const updates = {};
    transactions.forEach(t => { updates[getStorePath('transactions/' + t.id)] = JSON.parse(JSON.stringify(t)); });
    await firebaseDb.ref('/').update(updates);
    updateSyncStatus('online', 'Database Terhubung');
    alert('Berhasil menyinkronkan ' + transactions.length + ' transaksi ke Firebase Realtime Database! 🚀');
  } catch (err) {
    console.error('Gagal sync transaksi:', err);
    alert('Gagal menyinkronkan transaksi: ' + err.message);
  }
}






function exportTransactionsToCSV() {
  const searchVal = document.getElementById('transaction-list-search').value.toLowerCase().trim();
  const startDateVal = document.getElementById('tx-filter-start-date').value;
  const endDateVal = document.getElementById('tx-filter-end-date').value;
  
  let startLimit = startDateVal ? new Date(startDateVal + "T00:00:00") : null;
  let endLimit = endDateVal ? new Date(endDateVal + "T23:59:59") : null;
  
  const sortedTxs = [...transactions].sort((a, b) => {
    return new Date(b.waktu) - new Date(a.waktu);
  });
  
  const filteredTxs = sortedTxs.filter(tx => {
    const itemsStr = Array.isArray(tx.items) 
      ? tx.items.map(item => item.nama).join(" ").toLowerCase()
      : (tx.daftar_item || tx.items || "").toLowerCase();
      
    const waktuStr = new Date(tx.waktu).toLocaleString('id-ID').toLowerCase();
    
    const matchesSearch = String(tx.id).toLowerCase().includes(searchVal) || 
                          waktuStr.includes(searchVal) ||
                          itemsStr.includes(searchVal) ||
                          tx.total.toString().includes(searchVal);
                          
    if (!matchesSearch) return false;
    
    if (tx.waktu) {
      const txDate = new Date(tx.waktu);
      if (startLimit && txDate < startLimit) return false;
      if (endLimit && txDate > endLimit) return false;
    }
    return true;
  });
  
  if (filteredTxs.length === 0) {
    alert("Daftar transaksi yang disaring kosong!");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "ID Transaksi,Waktu,Daftar Item,Total Tagihan,Uang Bayar,Kembalian\n";
  
  filteredTxs.forEach(tx => {
    let itemsDisplay = "";
    if (Array.isArray(tx.items)) {
      itemsDisplay = tx.items.map(item => `${item.nama} (${item.qty}x @${item.harga})`).join(" | ");
    } else {
      itemsDisplay = tx.daftar_item || tx.items || "";
    }
    
    const row = [
      `"${tx.id}"`,
      `"${new Date(tx.waktu).toLocaleString('id-ID')}"`,
      `"${itemsDisplay.replace(/"/g, '""')}"`,
      tx.total,
      tx.bayar,
      tx.kembalian
    ].join(",");
    csvContent += row + "\n";
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Laporan_Penjualan_Toko Sahil POS_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  
  link.click();
  document.body.removeChild(link);
}

function printDailyReport() {
  const storeNameEl = document.getElementById('print-rep-store-name');
  const storeAddrEl = document.getElementById('print-rep-store-address');
  if (storeNameEl) storeNameEl.textContent = (receiptSettings && receiptSettings.name) || 'TOKO KASIR';
  if (storeAddrEl) storeAddrEl.textContent = (receiptSettings && receiptSettings.address) || '';
  
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  let periodLabel = '';
  let targetDateForStock = null;
  
  if (filterType === 'hari') {
    const d = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
    periodLabel = `Tanggal: ${d}`;
    targetDateForStock = d;
  } else if (filterType === 'bulan') {
    const m = document.getElementById('analytics-filter-month')?.value || getLocalISODate(new Date()).slice(0, 7);
    periodLabel = `Bulan: ${m}`;
    // Akhir bulan tersebut
    const [yr, mo] = m.split('-').map(Number);
    const lastDay = new Date(yr, mo, 0).getDate();
    targetDateForStock = `${m}-${String(lastDay).padStart(2, '0')}`;
  } else if (filterType === 'tahun') {
    const y = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
    periodLabel = `Tahun: ${y}`;
    targetDateForStock = `${y}-12-31`;
  } else {
    periodLabel = 'Semua Waktu';
    targetDateForStock = null;
  }
  
  const printDateEl = document.getElementById('print-rep-date');
  if (printDateEl) printDateEl.textContent = periodLabel;
  
  const printTimestampEl = document.getElementById('print-rep-timestamp');
  if (printTimestampEl) printTimestampEl.textContent = "Waktu Cetak: " + new Date().toLocaleString('id-ID');
  
  // Ambil transaksi periode ini
  const periodTxs = getAnalyticsFilteredTxs();
  
  let revenue = 0;
  let grossHpp = 0;
  let netProfit = 0;
  let totalItemsSold = 0;
  
  const paymentMethodsStats = {
    'Tunai': { count: 0, total: 0 },
    'QRIS': { count: 0, total: 0 },
    'Debit': { count: 0, total: 0 },
    'Transfer': { count: 0, total: 0 }
  };
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  
  const sellCounts = {};
  const sellRevenue = {};
  
  periodTxs.forEach(tx => {
    const metode = tx.metode_pembayaran || 'Tunai';
    const isNonCash = nonCashMethods.includes(metode);
    
    let txSubtotal = 0;
    let txBuyTotal = 0;
    
    (tx.items || []).forEach(item => {
      const buyPrice = Number(item.harga_beli) || 0;
      const sellPrice = Number(item.harga) || 0;
      const q = Number(item.qty) || 0;
      
      txBuyTotal += (buyPrice * q);
      txSubtotal += (sellPrice * q);
      totalItemsSold += q;
      
      sellCounts[item.nama] = (sellCounts[item.nama] || 0) + q;
      sellRevenue[item.nama] = (sellRevenue[item.nama] || 0) + (sellPrice * q);
    });
    
    const txDiscount = Math.max(0, txSubtotal - (Number(tx.total) || 0));
    const txNet = (txSubtotal - txBuyTotal) - txDiscount;
    
    netProfit += txNet;
    grossHpp += txBuyTotal;
    
    if (!isNonCash || tx.diganti_cash === true) {
      revenue += (Number(tx.total) || 0);
    }
    
    if (!paymentMethodsStats[metode]) {
      paymentMethodsStats[metode] = { count: 0, total: 0 };
    }
    paymentMethodsStats[metode].count += 1;
    paymentMethodsStats[metode].total += (Number(tx.total) || 0);
  });
  
  // 1. Render Metrik Keuangan
  const elRev = document.getElementById('print-rep-revenue');
  const elHpp = document.getElementById('print-rep-gross-profit');
  const elNet = document.getElementById('print-rep-net-profit');
  const elTxCount = document.getElementById('print-rep-tx-count');
  const elItemsSold = document.getElementById('print-rep-items-sold');
  
  if (elRev) elRev.textContent = `Rp ${formatRupiah(revenue)}`;
  if (elHpp) elHpp.textContent = `Rp ${formatRupiah(grossHpp)}`;
  if (elNet) elNet.textContent = `Rp ${formatRupiah(netProfit)}`;
  if (elTxCount) elTxCount.textContent = `${periodTxs.length} Transaksi`;
  if (elItemsSold) elItemsSold.textContent = `${totalItemsSold} Pcs`;
  
  // 2. Render Rincian Metode Pembayaran
  const printPaymentEl = document.getElementById('print-rep-payment-methods');
  if (printPaymentEl) {
    printPaymentEl.innerHTML = '';
    const methods = Object.keys(paymentMethodsStats);
    let hasMethods = false;
    methods.forEach(m => {
      const stat = paymentMethodsStats[m];
      if (stat.count > 0 || stat.total > 0) {
        hasMethods = true;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding: 0.25rem 0;">${m}</td>
          <td style="text-align: center; padding: 0.25rem 0;">${stat.count}x</td>
          <td style="text-align: right; padding: 0.25rem 0; font-weight: bold;">Rp ${formatRupiah(stat.total)}</td>
        `;
        printPaymentEl.appendChild(tr);
      }
    });
    if (!hasMethods) {
      printPaymentEl.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 0.4rem 0; color: #666;">Tidak ada transaksi</td></tr>';
    }
  }
  
  // 3. Render Produk Terlaris
  const printBestsellers = document.getElementById('print-rep-best-sellers');
  if (printBestsellers) {
    printBestsellers.innerHTML = '';
    const sortedNames = Object.keys(sellCounts).sort((a, b) => sellCounts[b] - sellCounts[a]);
    if (sortedNames.length === 0) {
      printBestsellers.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 0.5rem 0;">Belum ada penjualan.</td></tr>';
    } else {
      sortedNames.slice(0, 15).forEach((name, idx) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td style="padding: 0.25rem 0; width: 35px;">#${idx + 1}</td>
          <td style="padding: 0.25rem 0; text-align: left;">${name}</td>
          <td style="text-align: center; padding: 0.25rem 0;">${sellCounts[name]}</td>
          <td style="text-align: right; padding: 0.25rem 0; font-weight: bold;">Rp ${formatRupiah(sellRevenue[name])}</td>
        `;
        printBestsellers.appendChild(row);
      });
    }
  }
  
  // 4. Detail Transaksi ditiadakan sesuai preferensi, langsung ke Detail & Posisi Stok Barang
  
  // 5. Render Status Stok Barang Historis
  const printStockListEl = document.getElementById('print-rep-stock-status-list');
  if (printStockListEl) {
    printStockListEl.innerHTML = '';
    const historicalProducts = getHistoricalProductStock(targetDateForStock);
    
    if (historicalProducts.length === 0) {
      printStockListEl.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 0.5rem 0;">Tidak ada data produk.</td></tr>';
    } else {
      // Urutkan dari stok terkecil agar barang menipis/habis terlihat pertama
      historicalProducts.sort((a, b) => a.stok - b.stok);
      
      historicalProducts.forEach(prod => {
        const soldQty = sellCounts[prod.nama] || 0;
        let statusBadge = 'Aman';
        let statusStyle = 'color: #059669; font-weight: bold;';
        if (prod.stok <= 0) {
          statusBadge = 'HABIS';
          statusStyle = 'color: #e11d48; font-weight: bold;';
        } else if (prod.stok <= 2) {
          statusBadge = 'MENIPIS';
          statusStyle = 'color: #d97706; font-weight: bold;';
        }
        
        const rakName = prod.rak || '-';
        const hargaBeli = prod.harga_beli !== undefined ? prod.harga_beli : 0;
        const hargaJual = (prod.harga !== undefined) ? prod.harga : (prod.harga_jual || 0);

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px dotted #eee';
        tr.innerHTML = `
          <td style="padding: 0.25rem 0;">${prod.nama}</td>
          <td style="padding: 0.25rem 0; color: #475569; font-size: 0.75rem;">${rakName}</td>
          <td style="padding: 0.25rem 0; color: #666; font-size: 0.75rem;">${prod.kategori || 'UMUM'}</td>
          <td style="text-align: right; padding: 0.25rem 0; color: #64748b;">Rp ${formatRupiah(hargaBeli)}</td>
          <td style="text-align: right; padding: 0.25rem 0; font-weight: bold;">Rp ${formatRupiah(hargaJual)}</td>
          <td style="text-align: center; padding: 0.25rem 0; font-weight: ${soldQty > 0 ? 'bold' : 'normal'};">${soldQty}</td>
          <td style="text-align: right; padding: 0.25rem 0; font-weight: bold;">${prod.stok}</td>
          <td style="text-align: center; padding: 0.25rem 0; ${statusStyle}">${statusBadge}</td>
        `;
        printStockListEl.appendChild(tr);
      });
    }
  }
  
  document.body.classList.add('printing-daily-report');
  window.print();
}

// ==========================================================================
// MODUL CETAK DAFTAR BARANG DI RAK (FITUR PRINT PER RAK)
// ==========================================================================
function openPrintRackModal() {
  updateRacksList();
  
  const modal = document.getElementById('print-rack-modal');
  if (!modal) return;
  
  modal.style.display = 'flex';
  modal.classList.add('active');
  
  // Perbarui preview saat modal dibuka
  updatePrintRackPreview();
  
  // Pasang listener onchange ke select target jika belum ada
  const selTarget = document.getElementById('select-print-rack-target');
  if (selTarget) {
    selTarget.onchange = updatePrintRackPreview;
  }
}

function closePrintRackModal() {
  const modal = document.getElementById('print-rack-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function updatePrintRackPreview() {
  const selTarget = document.getElementById('select-print-rack-target');
  const previewText = document.getElementById('print-rack-preview-text');
  if (!selTarget || !previewText) return;
  
  const selectedRack = selTarget.value;
  let filtered = [];
  if (selectedRack === 'All') {
    filtered = [...products];
  } else {
    filtered = products.filter(p => (p.rak || '').toLowerCase().trim() === selectedRack.toLowerCase().trim());
  }
  
  const totalTypes = filtered.length;
  const totalUnits = filtered.reduce((acc, p) => acc + (Number(p.stok) || 0), 0);
  
  if (totalTypes === 0) {
    previewText.innerHTML = `<span style="color: var(--color-danger); font-weight: 500;">Belum ada barang di "${selectedRack === 'All' ? 'Semua Rak' : selectedRack}".</span>`;
  } else {
    previewText.innerHTML = `Terpilih <strong>${totalTypes} jenis produk</strong> (Total kuantitas: <strong>${totalUnits} pcs</strong>) siap dicetak.`;
  }
}

function executePrintRackReport() {
  const selTarget = document.getElementById('select-print-rack-target');
  const selectedRack = selTarget ? selTarget.value : 'All';
  
  let targetItems = [];
  if (selectedRack === 'All') {
    targetItems = [...products];
    // Urutkan berdasarkan rak lalu nama barang
    targetItems.sort((a, b) => {
      const rackA = a.rak || 'ZZZZ';
      const rackB = b.rak || 'ZZZZ';
      const cmp = rackA.localeCompare(rackB);
      return cmp !== 0 ? cmp : (a.nama || '').localeCompare(b.nama || '');
    });
  } else {
    targetItems = products.filter(p => (p.rak || '').toLowerCase().trim() === selectedRack.toLowerCase().trim());
    targetItems.sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));
  }
  
  if (targetItems.length === 0) {
    alert(`Tidak ada barang yang terdaftar di lokasi rak "${selectedRack === 'All' ? 'Semua Rak' : selectedRack}".`);
    return;
  }
  
  // 1. Set Info Header Toko
  const storeNameEl = document.getElementById('print-rack-store-name');
  const storeAddrEl = document.getElementById('print-rack-store-address');
  const subtitleEl = document.getElementById('print-rack-subtitle');
  const timestampEl = document.getElementById('print-rack-timestamp');
  
  if (storeNameEl) storeNameEl.textContent = (receiptSettings && receiptSettings.name) ? receiptSettings.name.toUpperCase() : 'TOKO SAHIL';
  if (storeAddrEl) storeAddrEl.textContent = (receiptSettings && receiptSettings.address) ? receiptSettings.address : 'Alamat Toko';
  if (subtitleEl) subtitleEl.textContent = selectedRack === 'All' ? 'Lokasi Rak: Semua Rak' : `Lokasi Rak: ${selectedRack}`;
  
  const now = new Date();
  const dateFormatted = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeFormatted = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (timestampEl) timestampEl.textContent = `Waktu Cetak: ${dateFormatted} ${timeFormatted}`;
  
  // 2. Render Tabel Barang
  const tbodyEl = document.getElementById('print-rack-items-body');
  if (tbodyEl) {
    tbodyEl.innerHTML = '';
    let totalStockCount = 0;
    
    targetItems.forEach((p, idx) => {
      const stockVal = Number(p.stok) || 0;
      totalStockCount += stockVal;
      
      let statusStr = 'Aman';
      let statusColor = '#059669';
      if (stockVal <= 0) {
        statusStr = 'HABIS';
        statusColor = '#e11d48';
      } else if (stockVal <= 2) {
        statusStr = 'MENIPIS';
        statusColor = '#d97706';
      }
      
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px dotted #ccc';
      tr.innerHTML = `
        <td style="padding: 0.35rem 0.25rem;">${idx + 1}</td>
        <td style="padding: 0.35rem 0.25rem; font-weight: bold;">${p.id || '-'}</td>
        <td style="padding: 0.35rem 0.25rem;">${p.nama || '-'}</td>
        <td style="padding: 0.35rem 0.25rem; font-weight: 600; color: #1e293b;">${p.rak || '<span style="color:#94a3b8;">-</span>'}</td>
        <td style="padding: 0.35rem 0.25rem; color: #555;">${p.kategori || 'Umum'}</td>
        <td style="text-align: right; padding: 0.35rem 0.25rem;">Rp ${formatRupiah(p.harga_jual || 0)}</td>
        <td style="text-align: center; padding: 0.35rem 0.25rem; font-weight: bold;">${stockVal}</td>
        <td style="text-align: center; padding: 0.35rem 0.25rem; color: ${statusColor}; font-weight: 700;">${statusStr}</td>
      `;
      tbodyEl.appendChild(tr);
    });
    
    // Set Total Summary
    const totalTypesEl = document.getElementById('print-rack-total-types');
    const totalStockEl = document.getElementById('print-rack-total-stock');
    if (totalTypesEl) totalTypesEl.textContent = `Total Jenis Produk: ${targetItems.length} jenis`;
    if (totalStockEl) totalStockEl.textContent = `Total Kuantitas Fisik: ${totalStockCount} pcs`;
  }
  
  // Tutup modal pilihan cetak
  closePrintRackModal();
  
  // Mulai cetak dengan class printing-rack-report
  document.body.classList.add('printing-rack-report');
  window.print();
}

// --- MODUL CETAK LABEL HARGA & BARCODE (FITUR BARU) ---
function openPrintLabelModal(productId, defaultType = 'shelf') {
  const p = products.find(prod => prod.id === productId);
  if (!p) {
    alert("Produk tidak ditemukan!");
    return;
  }
  
  document.getElementById('print-label-prod-id').value = productId;
  document.getElementById('print-label-type').value = defaultType;
  document.getElementById('print-label-qty').value = 1;
  
  updateLabelPreview();
  document.getElementById('print-label-modal').classList.add('active');
}

function closePrintLabelModal() {
  document.getElementById('print-label-modal').classList.remove('active');
  if (activeTab === 'products') focusProductListSearch();
}

function updateLabelPreview() {
  const productId = document.getElementById('print-label-prod-id').value;
  const p = products.find(prod => prod.id === productId);
  if (!p) return;
  
  const labelType = document.getElementById('print-label-type').value;
  const previewContainer = document.getElementById('label-preview-container');
  previewContainer.innerHTML = '';
  
  const labelHTML = buildLabelHTML(p, labelType);
  previewContainer.innerHTML = labelHTML;
}

function buildLabelHTML(p, labelType) {
  const storeName = receiptSettings.name || 'Toko Sahil POS';
  const priceFormatted = `Rp ${formatRupiah(p.harga_jual)}`;
  
  const barcodeVal = p.id; // Selalu gunakan ID produk agar pasti bisa discan dengan mudah
  
  let bcWidth = 1.5;
  let bcHeight = 32;
  if (labelType === 'product') {
    bcWidth = productLabelSettings.barcodeWidth || 1.5;
    bcHeight = productLabelSettings.barcodeHeight || 32;
  }
  const barcodeSVG = getBarcodeHTML(barcodeVal, { width: bcWidth, height: bcHeight });
  
  if (labelType === 'product') {
    // Product Label - use productLabelSettings
    let productName = p.nama || '';
    if (productName.length > productLabelSettings.chars) {
      productName = productName.substring(0, productLabelSettings.chars) + '...';
    }
    
    let storeNameHtml = '';
    if (productLabelSettings.showStoreName !== false) {
      storeNameHtml = `<div class="label-store">${storeName}</div>`;
    }
    
    let priceHtml = '';
    if (productLabelSettings.showPrice !== false) {
      priceHtml = `<div class="label-price">${priceFormatted}</div>`;
    }
    
    let barcodeHtml = '';
    if (productLabelSettings.showBarcode !== false) {
      barcodeHtml = `
        <div class="label-barcode-svg">${barcodeSVG}</div>
        <div class="label-barcode-text">${barcodeVal}</div>
      `;
    }
    
    return `
      <div class="label-item-print product-label" style="width: ${productLabelSettings.width}mm; height: ${productLabelSettings.height}mm;">
        ${storeNameHtml}
        <div class="label-name">${productName}</div>
        ${priceHtml}
        ${barcodeHtml}
      </div>
    `;
  } else {
    // Shelf Label
    let productName = p.nama || '';
    if (productName.length > labelSettings.chars) {
      productName = productName.substring(0, labelSettings.chars) + '...';
    }
    
    let barcodeHtmlStr = '';
    if (labelSettings.showBarcode) {
       barcodeHtmlStr = `<div class="label-barcode-svg" style="height: 24px; margin-top: 4px;">${barcodeSVG}</div>`;
    }
    
    let priceHtmlStr = '';
    if (labelSettings.showPrice) {
       const pfs = labelSettings.priceFontSize || 24;
       const pfw = labelSettings.priceFontWeight || 900;
       const priceStyle = getLabelFontStyle(pfs, pfw);
       priceHtmlStr = `
        <div class="label-price-box">
          <span class="label-price" style="${priceStyle}">${priceFormatted}</span>
        </div>
       `;
    }

    const nfs = labelSettings.nameFontSize || 12;
    const nfw = labelSettings.nameFontWeight || 800;
    const nameStyle = getLabelFontStyle(nfs, nfw);

    const rackHtmlStr = p.rak 
      ? `<div class="label-rack" style="font-size: 8pt; font-weight: 700; color: #333; margin-top: 2px;">Rak: ${p.rak}</div>` 
      : '';

    return `
      <div class="label-item-print shelf-label" style="width: ${labelSettings.width}mm; height: ${labelSettings.height}mm;">
        <div class="label-store">${storeName}</div>
        <div class="label-name" style="${nameStyle}">${productName}</div>
        ${rackHtmlStr}
        ${barcodeHtmlStr}
        ${priceHtmlStr}
      </div>
    `;
  }
}

// Helper: menghasilkan inline style untuk font label.
// Nilai > 900 menggunakan font-weight:900 + -webkit-text-stroke untuk ketebalan ekstra saat dicetak.
function getLabelFontStyle(fontSize, fontWeight) {
  let style = `font-size: ${fontSize}pt;`;
  if (fontWeight <= 900) {
    style += ` font-weight: ${fontWeight};`;
  } else {
    style += ` font-weight: 900;`;
    // Setiap 100 di atas 900 = +0.5px stroke
    const strokeWidth = ((fontWeight - 900) / 100) * 0.5;
    style += ` -webkit-text-stroke: ${strokeWidth}px #000; paint-order: stroke fill;`;
  }
  return style;
}

function printLabels() {
  const productId = document.getElementById('print-label-prod-id').value;
  const p = products.find(prod => prod.id === productId);
  if (!p) return;
  
  const labelType = document.getElementById('print-label-type').value;
  const qty = parseInt(document.getElementById('print-label-qty').value) || 1;
  const printArea = document.getElementById('labels-print-area');
  printArea.innerHTML = '';
  
  const container = document.createElement('div');
  container.className = 'labels-print-container';
  const marginLeft = labelType === 'product' ? productLabelSettings.marginLeft : labelSettings.marginLeft;
  container.style.paddingLeft = `${marginLeft}mm`;
  
  for (let i = 0; i < qty; i++) {
    const labelWrapper = document.createElement('div');
    labelWrapper.innerHTML = buildLabelHTML(p, labelType);
    container.appendChild(labelWrapper.firstElementChild);
  }
  
  printArea.appendChild(container);
  closePrintLabelModal();
  
  document.body.classList.add('printing-labels');
  window.print();
}

// Deteksi cetak label selesai
window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-labels');
});

// --- NOTIFIKASI KENAIKAN HARGA (FITUR BARU) ---
function showPriceChangeNotification(p, oldPrice, newPrice) {
  document.getElementById('price-change-prod-name').textContent = p.nama;
  document.getElementById('price-change-old').textContent = `Rp ${formatRupiah(oldPrice)}`;
  document.getElementById('price-change-new').textContent = `Rp ${formatRupiah(newPrice)}`;
  
  const btnPrint = document.getElementById('btn-print-change-label');
  btnPrint.onclick = () => {
    closePriceChangeModal();
    openPrintLabelModal(p.id, 'shelf');
  };
  
  document.getElementById('price-change-modal').classList.add('active');
}

function closePriceChangeModal() {
  document.getElementById('price-change-modal').classList.remove('active');
  if (activeTab === 'products') focusProductListSearch();
}

// --- FITUR CETAK LABEL MASSAL (BULK PRINTING - FITUR BARU) ---
function toggleProductSelection(productId, checkbox) {
  if (checkbox.checked) {
    selectedProductIds.add(productId);
  } else {
    selectedProductIds.delete(productId);
  }
  updateBulkActionButtonState();
}

function toggleSelectAllProducts(masterCheckbox) {
  const searchVal = document.getElementById('product-list-search').value.toLowerCase().trim();
  const matched = products.filter(p => {
    return String(p.nama).toLowerCase().includes(searchVal) || 
           String(p.id).toLowerCase().includes(searchVal) ||
           (p.barcode && String(p.barcode).toLowerCase().includes(searchVal)) ||
           (p.kategori && String(p.kategori).toLowerCase().includes(searchVal));
  });
  const itemsToRender = searchVal === '' ? matched.slice(0, 10) : matched;

  itemsToRender.forEach(p => {
    if (masterCheckbox.checked) {
      selectedProductIds.add(p.id);
    } else {
      selectedProductIds.delete(p.id);
    }
  });

  const checkboxes = document.querySelectorAll('.product-select-checkbox');
  checkboxes.forEach(cb => {
    const id = cb.getAttribute('data-id');
    cb.checked = selectedProductIds.has(id);
  });

  updateBulkActionButtonState();
}

function updateBulkActionButtonState() {
  const count = selectedProductIds.size;
  const btnBulk = document.getElementById('btn-bulk-print-labels');
  const countEl = document.getElementById('bulk-select-count');
  
  if (btnBulk && countEl) {
    if (count > 0) {
      countEl.textContent = count;
      btnBulk.style.display = 'inline-flex';
    } else {
      btnBulk.style.display = 'none';
    }
  }
  
  const masterCb = document.getElementById('select-all-products');
  if (masterCb) {
    const checkboxes = document.querySelectorAll('.product-select-checkbox');
    if (checkboxes.length > 0) {
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      masterCb.checked = allChecked;
    } else {
      masterCb.checked = false;
    }
  }
}

function openBulkPrintLabelModal() {
  if (selectedProductIds.size === 0) {
    alert("Pilih minimal satu produk!");
    return;
  }
  
  const listContainer = document.getElementById('bulk-print-products-list');
  listContainer.innerHTML = '';
  
  selectedProductIds.forEach(id => {
    const p = products.find(prod => prod.id === id);
    if (p) {
      const row = document.createElement('div');
      row.className = 'bulk-print-row';
      row.style.display = 'flex';
      row.style.justify = 'space-between';
      row.style.alignItems = 'center';
      row.style.padding = '0.5rem 0';
      row.style.borderBottom = '1px solid var(--border-color)';
      row.innerHTML = `
        <span style="font-weight: 600; font-size: 0.85rem; color: var(--text-main);">${p.nama} (${p.id})</span>
        <input type="number" class="bulk-print-qty-input" data-id="${p.id}" min="1" max="100" value="1" style="width: 70px; padding: 0.35rem 0.5rem; border: 1px solid var(--border-color); border-radius: var(--border-radius-sm); text-align: center; font-weight: bold; outline: none; font-family: var(--font-main);">
      `;
      listContainer.appendChild(row);
    }
  });
  
  document.getElementById('bulk-print-label-type').value = 'shelf';
  document.getElementById('bulk-print-label-modal').classList.add('active');
}

function closeBulkPrintLabelModal() {
  document.getElementById('bulk-print-label-modal').classList.remove('active');
  if (activeTab === 'products') focusProductListSearch();
}

function printBulkLabels() {
  const labelType = document.getElementById('bulk-print-label-type').value;
  const printArea = document.getElementById('labels-print-area');
  printArea.innerHTML = '';
  
  const qtyInputs = document.querySelectorAll('.bulk-print-qty-input');
  const storeName = receiptSettings.name || 'Toko Sahil POS';
  
  const container = document.createElement('div');
  container.className = 'labels-print-container';
  const marginLeft = labelType === 'product' ? productLabelSettings.marginLeft : labelSettings.marginLeft;
  container.style.paddingLeft = `${marginLeft}mm`;
  
  let totalPrinted = 0;
  
  qtyInputs.forEach(input => {
    const productId = input.getAttribute('data-id');
    const qty = parseInt(input.value) || 0;
    const p = products.find(prod => prod.id === productId);
    
    if (p && qty > 0) {
      totalPrinted += qty;
      
      for (let i = 0; i < qty; i++) {
        const labelWrapper = document.createElement('div');
        labelWrapper.innerHTML = buildLabelHTML(p, labelType);
        container.appendChild(labelWrapper.firstElementChild);
      }
    }
  });
  
  if (totalPrinted === 0) {
    alert("Tidak ada label yang dicetak!");
    return;
  }
  
  printArea.appendChild(container);
  closeBulkPrintLabelModal();
  
  document.body.classList.add('printing-labels');
  window.print();
  
  // Bersihkan pilihan setelah print sukses dipicu
  selectedProductIds.clear();
  renderProductsTable();
}

// --- LOGIKA PELUNASAN PIUTANG / BON (FITUR BARU) ---
function openSettleDebtModal(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  
  document.getElementById('settle-debt-tx-id').value = txId;
  document.getElementById('settle-debt-customer-name').textContent = tx.nama_pelanggan || 'Pelanggan Tanpa Nama';
  document.getElementById('settle-debt-remaining-amount').textContent = `Rp ${formatRupiah(tx.sisa_piutang)}`;
  
  const amountInput = document.getElementById('settle-debt-amount');
  amountInput.value = '';
  document.getElementById('btn-submit-settle-debt').disabled = true;
  
  document.getElementById('settle-debt-modal').classList.add('active');
  setTimeout(() => {
    amountInput.focus();
  }, 100);
}

function closeSettleDebtModal() {
  document.getElementById('settle-debt-modal').classList.remove('active');
}

function formatSettleDebtAmount(input) {
  const cleanVal = input.value.replace(/\D/g, "");
  if (cleanVal === "") {
    input.value = "";
  } else {
    input.value = new Intl.NumberFormat('id-ID').format(cleanVal);
  }
  
  const amount = parseFloat(cleanVal) || 0;
  const btnSubmit = document.getElementById('btn-submit-settle-debt');
  if (amount > 0) {
    btnSubmit.disabled = false;
  } else {
    btnSubmit.disabled = true;
  }
}

function submitSettleDebt() {
  const txId = document.getElementById('settle-debt-tx-id').value;
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  
  const amountInput = document.getElementById('settle-debt-amount');
  const cleanVal = amountInput.value.replace(/\./g, "");
  const payAmount = parseFloat(cleanVal) || 0;
  
  if (payAmount <= 0) {
    alert("Masukkan nominal pembayaran yang valid!");
    return;
  }
  
  const originalSisa = tx.sisa_piutang || 0;
  const originalBayar = tx.bayar || 0;
  
  if (payAmount >= originalSisa) {
    // Lunas
    tx.sisa_piutang = 0;
    tx.status_pembayaran = 'Lunas';
    tx.kembalian = payAmount - originalSisa;
    tx.bayar = originalBayar + originalSisa;
    alert(`Pelunasan berhasil! Bon lunas. Kembalian: Rp ${formatRupiah(tx.kembalian)}`);
  } else {
    // Cicil / bayar sebagian
    tx.sisa_piutang = originalSisa - payAmount;
    tx.status_pembayaran = 'Bon';
    tx.kembalian = 0;
    tx.bayar = originalBayar + payAmount;
    alert(`Pembayaran cicilan berhasil! Sisa piutang sekarang: Rp ${formatRupiah(tx.sisa_piutang)}`);
  }
  
  // Simpan ke LocalStorage
  saveTransactionsLocally();
  
  // Update UI
  closeSettleDebtModal();
  renderTransactionsTable();
  renderCustomerDebtBook();
  updateAnalytics();
  
  // Sinkronkan ke cloud
  syncSingleTransactionToCloud(tx);
}

// --- MODUL SHIFT KARYAWAN (SISTEM SHIFT BARU BERBASIS DAFTAR KARYAWAN) ---

function getStaffActiveShift(staffName) {
  if (!staffName) staffName = activeCashier;
  const staff = staffAccounts.find(s => s.name === staffName);
  if (staff && staff.shiftStatus === 'aktif' && staff.shiftData) {
    return staff.shiftData;
  }
  return null;
}

function updateShiftStatusUI() {
  const btnText = document.getElementById('shift-status-text');
  const btnStatus = document.getElementById('btn-shift-status');
  if (!btnText || !btnStatus) return;
  
  // Periksa shift aktif untuk kasir yang saat ini login
  const currentStaffShift = getStaffActiveShift(activeCashier);
  
  if (currentStaffShift) {
    btnText.textContent = `Shift: Aktif (${activeCashier})`;
    btnStatus.style.borderColor = '#16a34a';
    btnStatus.style.color = '#16a34a';
    btnStatus.style.background = 'rgba(22, 163, 74, 0.08)';
    btnStatus.style.boxShadow = '0 0 10px rgba(22, 163, 74, 0.2)';
  } else {
    btnText.textContent = `Buka Shift (${activeCashier || 'Kasir'})`;
    btnStatus.style.borderColor = 'var(--border-color)';
    btnStatus.style.color = 'var(--text-main)';
    btnStatus.style.background = 'var(--bg-surface-elevated)';
    btnStatus.style.boxShadow = '0 2px 4px rgba(0,0,0,0.02)';
  }
}

function openShiftModal() {
  const modal = document.getElementById('shift-modal');
  const body = document.getElementById('shift-modal-body');
  const title = document.getElementById('shift-modal-title');
  if (!modal || !body || !title) return;
  
  const currentStaff = staffAccounts.find(s => s.name === activeCashier) || {
    name: activeCashier || 'Kasir',
    assignedShift: 'Shift Pagi (07:00 - 15:00)',
    shiftStatus: 'off'
  };

  const currentShiftData = getStaffActiveShift(currentStaff.name);
  
  if (!currentShiftData) {
    // FORM BUKA SHIFT KARYAWAN
    title.textContent = `Buka Shift: ${currentStaff.name}`;
    
    let staffSelectOptions = staffAccounts.map(s => {
      const isSelected = s.name === currentStaff.name ? 'selected' : '';
      return `<option value="${s.name}" ${isSelected}>${s.name} (${s.assignedShift || 'Reguler'})</option>`;
    }).join('');

    if (!staffSelectOptions) {
      staffSelectOptions = `<option value="${activeCashier}">${activeCashier}</option>`;
    }

    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group" style="margin-bottom: 0;">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.4rem; display: block;">Karyawan Bertugas</label>
          <select id="shift-kasir-select" class="form-control" onchange="onShiftCashierChanged(this.value)" style="width: 100%; padding: 0.65rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background: var(--bg-surface-elevated); font-size: 0.95rem; font-weight: 600;">
            ${staffSelectOptions}
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
            <label style="font-weight: 600; color: var(--text-main); margin: 0;">Jadwal Shift Kerja</label>
            <span style="font-size: 0.75rem; color: var(--color-primary); cursor: pointer; font-weight: 600;" onclick="toggleOpenShiftEditHours()">✏️ Ubah Jam Shift Ini</span>
          </div>
          <input type="text" id="shift-jenis-display" class="form-control" value="${currentStaff.assignedShift || 'Shift Pagi (07:00 - 15:00)'}" style="width: 100%; padding: 0.65rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background: var(--bg-surface); font-size: 0.95rem; font-weight: 600; color: var(--text-main);">
          
          <!-- Panel Cepat Ganti Jam Shift -->
          <div id="open-shift-quick-edit" style="display: none; margin-top: 0.5rem; background: rgba(59,130,246,0.05); border: 1px dashed var(--color-primary); padding: 0.65rem; border-radius: 8px;">
            <div style="font-size: 0.78rem; font-weight: 700; color: var(--color-primary); margin-bottom: 0.35rem;">Pilih Template atau Atur Jam:</div>
            <div style="display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
              <button type="button" class="btn btn-secondary btn-sm" style="font-size: 0.73rem; padding: 2px 7px;" onclick="setShiftDisplayValue('Shift Pagi (07:00 - 15:00)')">Pagi (07-15)</button>
              <button type="button" class="btn btn-secondary btn-sm" style="font-size: 0.73rem; padding: 2px 7px;" onclick="setShiftDisplayValue('Shift Siang (15:00 - 21:00)')">Siang (15-21)</button>
              <button type="button" class="btn btn-secondary btn-sm" style="font-size: 0.73rem; padding: 2px 7px;" onclick="setShiftDisplayValue('Shift Malam (21:00 - 07:00)')">Malam (21-07)</button>
              <button type="button" class="btn btn-secondary btn-sm" style="font-size: 0.73rem; padding: 2px 7px;" onclick="setShiftDisplayValue('Shift Fleksibel / Full Day')">Fleksibel</button>
            </div>
            <div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
              <input type="time" id="open-shift-time-start" value="08:00" style="padding: 0.25rem 0.4rem; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.8rem; background: var(--bg-surface);">
              <span style="font-size: 0.8rem; color: var(--text-muted);">s/d</span>
              <input type="time" id="open-shift-time-end" value="16:00" style="padding: 0.25rem 0.4rem; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.8rem; background: var(--bg-surface);">
              <button type="button" class="btn btn-primary btn-sm" style="font-size: 0.75rem; padding: 3px 8px;" onclick="applyOpenShiftCustomHours()">Terapkan Jam</button>
            </div>
          </div>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.4rem; display: block;">Modal Awal / Uang Laci Kasir (Rp)</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-weight: 600;">Rp</span>
            <input type="text" id="shift-modal-awal" class="form-control" placeholder="100.000" onkeyup="formatRupiahInput(this)" style="width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); font-size: 1.1rem; font-weight: 700;">
          </div>
          <span style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-top: 0.35rem;">Masukkan uang tunai pecahan kecil yang ada di laci saat mulai kerja.</span>
        </div>
        <button class="btn btn-primary" style="width: 100%; padding: 0.85rem; font-size: 1rem; font-weight: 700; margin-top: 0.5rem; box-shadow: var(--shadow-md);" onclick="submitOpenStaffShift()">🚀 Mulai &amp; Buka Shift Karyawan</button>
      </div>
    `;
  } else {
    // FORM TUTUP SHIFT KARYAWAN
    title.textContent = `Tutup Shift: ${currentStaff.name}`;
    
    const startTime = new Date(currentShiftData.waktu_buka).getTime();
    let totalUangMasuk = 0;
    let totalTransaksiCount = 0;
    
    transactions.forEach(tx => {
      const txTime = new Date(tx.waktu).getTime();
      // 1. Transaksi baru selama shift ini
      if (txTime >= startTime) {
        if (!tx.kasir || tx.kasir === currentStaff.name) {
          totalTransaksiCount++;
          if (tx.metode_pembayaran === 'Tunai' || tx.diganti_cash === true) {
            const cashMasuk = (Number(tx.bayar) || 0) - (Number(tx.kembalian) || 0);
            if (cashMasuk > 0) totalUangMasuk += cashMasuk;
          }
        }
      }
      // 2. Pelunasan cicilan piutang / Bon yang dibayar tunai selama shift ini
      if (Array.isArray(tx.riwayat_pelunasan)) {
        tx.riwayat_pelunasan.forEach(p => {
          const pTime = p.waktu ? new Date(p.waktu).getTime() : 0;
          if (pTime >= startTime && (!p.kasir || p.kasir === currentStaff.name) && (p.metode === 'Tunai' || p.diganti_cash === true)) {
            totalUangMasuk += (Number(p.bayar) || 0);
          }
        });
      }
    });

    let kasMasukLaci = 0;
    let kasKeluarLaci = 0;
    if (Array.isArray(expenses)) {
      expenses.forEach(e => {
        if (e.sumberDana === 'laci_kasir') {
          const eTime = e.tanggal ? new Date(e.tanggal).getTime() : 0;
          if (eTime >= startTime) {
            if (e.tipe === 'masuk') kasMasukLaci += (Number(e.nominal) || 0);
            else kasKeluarLaci += (Number(e.nominal) || 0);
          }
        }
      });
    }
    
    const modalAwal = Number(currentShiftData.modal_awal) || 0;
    const estimasiLaci = Math.max(0, modalAwal + totalUangMasuk + kasMasukLaci - kasKeluarLaci);
    
    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1.1rem;">
        <div style="background: linear-gradient(135deg, rgba(22, 163, 74, 0.08) 0%, rgba(22, 163, 74, 0.03) 100%); padding: 1.25rem; border-radius: var(--border-radius-md); text-align: center; border: 1px solid rgba(22, 163, 74, 0.25);">
          <div style="display: flex; justify-content: center; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
            <span style="font-size: 0.82rem; font-weight: 700; color: #16a34a; text-transform: uppercase;">${currentShiftData.jenis_shift || 'Shift'}</span>
            <span style="font-size: 0.78rem; color: var(--text-muted);">• Dimulai: ${new Date(currentShiftData.waktu_buka).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem; font-weight: 600;">Estimasi Uang Laci Seharusnya</p>
          <h3 style="color: #16a34a; font-size: 1.9rem; margin: 0; font-weight: 800;">Rp ${formatRupiah(estimasiLaci)}</h3>
          <div style="display: flex; justify-content: center; flex-wrap: wrap; gap: 0.35rem 0.65rem; margin-top: 0.6rem; font-size: 0.78rem; color: var(--text-muted);">
            <span>Modal: <strong>Rp ${formatRupiah(modalAwal)}</strong></span>
            <span>+</span>
            <span>Tunai: <strong>Rp ${formatRupiah(totalUangMasuk)}</strong></span>
            ${kasMasukLaci > 0 ? `<span>+</span> <span style="color:#16a34a;">Kas Masuk: <strong>Rp ${formatRupiah(kasMasukLaci)}</strong></span>` : ''}
            ${kasKeluarLaci > 0 ? `<span>-</span> <span style="color:#dc2626;">Biaya Laci: <strong>Rp ${formatRupiah(kasKeluarLaci)}</strong></span>` : ''}
          </div>
        </div>
        
        <div class="form-group" style="margin-bottom: 0;">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.35rem; display: block;">Hitungan Fisik Uang di Laci Saat Ini (Rp)*</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-weight: 600;">Rp</span>
            <input type="text" id="shift-uang-fisik" class="form-control" placeholder="0" onkeyup="formatRupiahInput(this)" style="width: 100%; padding: 0.85rem 1rem 0.85rem 2.5rem; border-radius: var(--border-radius-md); border: 2px solid var(--border-color); font-size: 1.35rem; font-weight: 700; color: var(--text-main); background: var(--bg-surface-elevated);">
          </div>
          <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.35rem;">Hitung dan masukkan seluruh uang tunai yang ada di dalam laci kasir.</p>
        </div>
        <button class="btn btn-primary" style="width: 100%; padding: 0.9rem; font-size: 1.05rem; font-weight: 700; border-radius: var(--border-radius-md); box-shadow: var(--shadow-md); background: linear-gradient(to right, #ea580c, #c2410c); margin-top: 0.25rem;" onclick="submitCloseStaffShift('${currentStaff.name}', ${totalUangMasuk}, ${estimasiLaci}, ${kasMasukLaci}, ${kasKeluarLaci}, ${totalTransaksiCount})">🔒 Akhiri Shift &amp; Simpan Rekap</button>
      </div>
    `;
  }
  
  modal.classList.add('active');
}

function toggleOpenShiftEditHours() {
  const panel = document.getElementById('open-shift-quick-edit');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
}

function setShiftDisplayValue(val) {
  const display = document.getElementById('shift-jenis-display');
  if (display) display.value = val;
}

function applyOpenShiftCustomHours() {
  const start = document.getElementById('open-shift-time-start')?.value || '08:00';
  const end = document.getElementById('open-shift-time-end')?.value || '16:00';
  const display = document.getElementById('shift-jenis-display');
  if (display) {
    display.value = `Shift Kustom (${start} - ${end})`;
  }
  const panel = document.getElementById('open-shift-quick-edit');
  if (panel) panel.style.display = 'none';
}

function onShiftCashierChanged(selectedCashierName) {
  const staff = staffAccounts.find(s => s.name === selectedCashierName);
  const shiftDisplay = document.getElementById('shift-jenis-display');
  if (staff && shiftDisplay) {
    shiftDisplay.value = staff.assignedShift || 'Shift Pagi (07:00 - 15:00)';
  }
}

function submitOpenStaffShift() {
  const select = document.getElementById('shift-kasir-select');
  const staffName = select ? select.value : activeCashier;

  // Cek apakah kasir ini sudah punya shift aktif
  const existingShift = getStaffActiveShift(staffName);
  if (existingShift) {
    alert(`⚠️ Kasir "${staffName}" sudah memiliki shift yang aktif (${existingShift.jenis_shift})!\nShift hanya dapat dipilih satu kali. Untuk berganti shift, silakan tutup shift yang sedang berjalan terlebih dahulu.`);
    openShiftModal();
    return;
  }

  const modalAwalInput = document.getElementById('shift-modal-awal')?.value?.replace(/\./g, "") || "0";
  const modalAwal = parseFloat(modalAwalInput) || 0;

  // Baca jadwal shift langsung dari input (bisa diubah manual oleh pengguna)
  const shiftDisplay = document.getElementById('shift-jenis-display');
  const staff = staffAccounts.find(s => s.name === staffName);
  const shiftType = (shiftDisplay && shiftDisplay.value.trim()) 
    ? shiftDisplay.value.trim() 
    : (staff ? (staff.assignedShift || 'Shift Pagi (07:00 - 15:00)') : 'Shift Pagi (07:00 - 15:00)');

  const newShiftSession = {
    id_shift: 'SH-' + Date.now().toString().slice(-8),
    nama_kasir: staffName,
    jenis_shift: shiftType,
    waktu_buka: new Date().toISOString(),
    modal_awal: modalAwal,
    status: 'aktif'
  };

  // Update data karyawan
  if (staff) {
    staff.shiftStatus = 'aktif';
    staff.shiftData = newShiftSession;
    // Update juga assignedShift jika karyawan ingin memakai jam shift baru ini seterusnya
    staff.assignedShift = shiftType;
    localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));
  }

  // Set legacy activeShift juga agar kompatibel dengan modul lain tanpa konflik DB
  activeShift = newShiftSession;
  localStorage.setItem('kasir_active_shift', JSON.stringify(activeShift));
  
  activeCashier = staffName;
  localStorage.setItem('kasir_active_cashier', activeCashier);

  updateShiftStatusUI();
  renderCashierSettingsList();
  closeShiftModal();
  alert(`✅ Shift "${shiftType}" berhasil dimulai untuk ${staffName}. Modal awal: Rp ${formatRupiah(modalAwal)}.`);
}

function submitCloseStaffShift(staffName, totalUangMasuk, estimasiLaci, kasMasukLaci = 0, kasKeluarLaci = 0, txCount = 0) {
  const fisikInput = document.getElementById('shift-uang-fisik')?.value?.replace(/\./g, "");
  if (!fisikInput) {
    alert("Harap masukkan hitungan fisik uang laci!");
    return;
  }
  
  const uangFisik = parseFloat(fisikInput) || 0;
  const selisih = uangFisik - estimasiLaci;
  
  const staff = staffAccounts.find(s => s.name === staffName);
  const shiftData = (staff && staff.shiftData) ? staff.shiftData : (activeShift || {});

  const closedShift = {
    ...shiftData,
    id_shift: shiftData.id_shift || ('SH-' + Date.now().toString().slice(-8)),
    nama_kasir: staffName,
    jenis_shift: shiftData.jenis_shift || (staff ? staff.assignedShift : 'Shift Reguler'),
    waktu_tutup: new Date().toISOString(),
    total_uang_masuk: totalUangMasuk,
    total_transaksi: txCount,
    kas_masuk_laci: kasMasukLaci,
    kas_keluar_laci: kasKeluarLaci,
    estimasi_laci: estimasiLaci,
    uang_fisik: uangFisik,
    selisih: selisih,
    status: 'ditutup'
  };
  
  // Simpan ke riwayat shift lokal
  shifts.push(closedShift);
  localStorage.setItem('kasir_shifts', JSON.stringify(shifts));

  // Sinkronkan ke Firebase RTDB agar Owner bisa memantau tutup shift dari jarak jauh
  if (firebaseDb && typeof getStorePath === 'function') {
    firebaseDb.ref(getStorePath('shifts/' + closedShift.id_shift)).set(closedShift).catch(err => {
      console.warn('⚠️ Gagal sinkronisasi data tutup shift ke cloud:', err.message);
    });
  }

  // Reset shift status pada akun karyawan
  if (staff) {
    staff.shiftStatus = 'off';
    staff.shiftData = null;
    localStorage.setItem('kasir_staff_accounts', JSON.stringify(staffAccounts));
  }

  activeShift = null;
  localStorage.removeItem('kasir_active_shift');
  
  updateShiftStatusUI();
  renderCashierSettingsList();
  closeShiftModal();
  
  let msg = `Shift untuk ${staffName} berhasil ditutup.\nSelisih uang: Rp ${formatRupiah(selisih)}\n`;
  if (selisih < 0) msg += "(Minus / Uang Kurang)";
  else if (selisih > 0) msg += "(Lebih)";
  else msg += "(Uang Pas)";
  
  if (confirm(`${msg}\n\nApakah Anda ingin mengirimkan rekap tutup shift ini ke WhatsApp Toko / Owner?`)) {
    shareShiftReportToWhatsApp(closedShift);
  } else {
    alert(msg);
  }
}

function closeShiftModal() {
  const modal = document.getElementById('shift-modal');
  if (modal) modal.classList.remove('active');
}

function shareShiftReportToWhatsApp(shift) {
  if (!shift) return;
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : 'Toko Sahil';
  let ownerPhone = (receiptSettings && receiptSettings.phone) ? receiptSettings.phone.replace(/[^0-9]/g, '') : '';
  if (!ownerPhone) {
    const input = prompt("Masukkan nomor WhatsApp Owner / Toko (contoh: 08123456789):");
    if (!input) return;
    ownerPhone = input.replace(/[^0-9]/g, '');
  }
  if (ownerPhone.startsWith('0')) ownerPhone = '62' + ownerPhone.slice(1);

  const tBuka = shift.waktu_buka ? new Date(shift.waktu_buka).toLocaleString('id-ID') : '-';
  const tTutup = shift.waktu_tutup ? new Date(shift.waktu_tutup).toLocaleString('id-ID') : new Date().toLocaleString('id-ID');

  let statusSelisih = "Uang Pas (Cocok)";
  if (shift.selisih < 0) statusSelisih = `Kurang Rp ${formatRupiah(Math.abs(shift.selisih))}`;
  else if (shift.selisih > 0) statusSelisih = `Lebih Rp ${formatRupiah(shift.selisih)}`;

  let text = `*📋 LAPORAN TUTUP SHIFT KASIR*\n`;
  text += `*${storeName.toUpperCase()}*\n`;
  text += `--------------------------------\n`;
  text += `👤 Kasir: *${shift.nama_kasir || '-'}*\n`;
  text += `🖥️ Komputer / POS: *${shift.terminal || posTerminalName || 'Kasir 1'}*\n`;
  text += `🏷️ Jadwal Shift: *${shift.jenis_shift || 'Reguler'}*\n`;
  text += `🕒 Buka : ${tBuka}\n`;
  text += `🕒 Tutup: ${tTutup}\n`;
  text += `--------------------------------\n`;
  text += `💵 Modal Awal Laci: *Rp ${formatRupiah(shift.modal_awal || 0)}*\n`;
  text += `🛒 Total Penjualan Tunai: *Rp ${formatRupiah(shift.total_uang_masuk || 0)}*\n`;
  if (shift.kas_masuk_laci > 0) {
    text += `📥 Kas Masuk Tambahan: *Rp ${formatRupiah(shift.kas_masuk_laci)}*\n`;
  }
  if (shift.kas_keluar_laci > 0) {
    text += `📤 Pengeluaran/Biaya Laci: *Rp ${formatRupiah(shift.kas_keluar_laci)}*\n`;
  }
  text += `--------------------------------\n`;
  text += `📊 Estimasi Laci Sistem: *Rp ${formatRupiah(shift.estimasi_laci || 0)}*\n`;
  text += `💰 Uang Fisik Terhitung: *Rp ${formatRupiah(shift.uang_fisik || 0)}*\n`;
  text += `⚖️ Status Selisih: *${statusSelisih}*\n`;
  text += `--------------------------------\n`;
  text += `_Laporan otomatis dikirim dari Aplikasi Kasir._`;

  const waUrl = `https://api.whatsapp.com/send?phone=${ownerPhone}&text=${encodeURIComponent(text)}`;
  window.open(waUrl, '_blank');
}

function formatRupiahInput(input) {
  const cleanVal = input.value.replace(/\D/g, "");
  if (cleanVal === "") {
    input.value = "";
  } else {
    input.value = new Intl.NumberFormat('id-ID').format(cleanVal);
  }
}

// --- MODUL PELANGGAN & CRM ---

function clearCustomerSearch() {
  const searchInput = document.getElementById('customer-search');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('btn-clear-cust-search');
  if (clearBtn) clearBtn.style.display = 'none';
  renderCustomersTable();
  if (searchInput) searchInput.focus();
}

function saveLoyaltySettingsCloud() {
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('settings/loyalty')).set(loyaltySettings).catch(err => {
        console.warn('⚠️ Gagal sinkron loyaltySettings ke cloud:', err.message);
      });
    } catch (e) {}
  }
}

let tempPreviewLoyaltyMode = loyaltySettings.rewardMode || 'points';

function previewLoyaltyRewardMode(mode) {
  tempPreviewLoyaltyMode = mode;
  const isVoucher = (mode === 'voucher');
  const vchPanel = document.getElementById('voucher-settings-panel');
  const ptsPanel = document.getElementById('points-settings-panel');
  if (vchPanel) vchPanel.style.display = isVoucher ? 'block' : 'none';
  if (ptsPanel) ptsPanel.style.display = isVoucher ? 'none' : 'block';
}

function saveActiveLoyaltyRewardMode() {
  loyaltySettings.rewardMode = tempPreviewLoyaltyMode === 'voucher' ? 'voucher' : 'points';
  localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
  saveLoyaltySettingsCloud();
  syncLoyaltySettingsUI();
  renderCustomersTable();
  alert(`✅ Mode Program Reward berhasil disimpan: ${loyaltySettings.rewardMode === 'voucher' ? '🎟️ Program Voucher Bulanan' : '🪙 Program Poin Belanja'}`);
}

function switchLoyaltyRewardMode(mode) {
  tempPreviewLoyaltyMode = mode;
  saveActiveLoyaltyRewardMode();
}

function syncLoyaltySettingsUI() {
  const pointsModeAllowed = appConfig && appConfig.enableLoyaltyPointsMode === true;
  const lblPoints = document.getElementById('lbl-mode-points');
  if (lblPoints) {
    lblPoints.style.display = pointsModeAllowed ? 'flex' : 'none';
  }

  // Jika opsi poin tidak diaktifkan di Pengaturan Sistem Toko, paksa rewardMode ke voucher
  if (!pointsModeAllowed && loyaltySettings.rewardMode === 'points') {
    loyaltySettings.rewardMode = 'voucher';
    localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
    saveLoyaltySettingsCloud();
  }

  const isVoucher = (loyaltySettings.rewardMode === 'voucher');
  tempPreviewLoyaltyMode = loyaltySettings.rewardMode;

  const statusText = document.getElementById('loyalty-modal-status-text');
  if (statusText) {
    statusText.innerHTML = isVoucher
      ? 'Mode Aktif: <strong style="color:#d97706;">🎟️ Program Voucher Bulanan</strong> (Dapat diubah ke Poin di menu Pengaturan Sistem Toko).'
      : 'Mode Aktif: <strong style="color:#ea580c;">🪙 Program Poin Belanja</strong> (Dapat diubah ke Voucher di menu Pengaturan Sistem Toko).';
  }

  // Tampilkan panel pengaturan sesuai mode
  const vchPanel = document.getElementById('voucher-settings-panel');
  const ptsPanel = document.getElementById('points-settings-panel');
  if (vchPanel) vchPanel.style.display = isVoucher ? 'block' : 'none';
  if (ptsPanel) ptsPanel.style.display = isVoucher ? 'none' : 'block';

  // Isi input pengaturan voucher
  const targetSelect = document.getElementById('setting-voucher-target');
  const nominalInput = document.getElementById('setting-voucher-nominal');
  const quotaInput = document.getElementById('setting-voucher-monthly-quota');
  const activeMonthBadge = document.getElementById('voucher-active-month-badge');
  if (targetSelect) {
    targetSelect.value = loyaltySettings.voucherTarget || 'all';
    toggleVoucherTargetSelectionUI(targetSelect.value);
  }
  if (nominalInput) nominalInput.value = loyaltySettings.voucherRpValue || 10000;
  if (quotaInput) quotaInput.value = loyaltySettings.voucherMonthlyQuota || 2;
  if (activeMonthBadge) {
    const curMonth = getCurrentMonthKey();
    const d = new Date();
    const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    activeMonthBadge.textContent = `Periode: ${monthNames[d.getMonth()]} ${d.getFullYear()} (${curMonth})`;
  }

  // Isi input pengaturan poin di pane
  const ptsPerRpInput = document.getElementById('setting-points-per-rp-cust');
  const rpPerPtInput = document.getElementById('setting-rp-per-point-cust');
  if (ptsPerRpInput) ptsPerRpInput.value = loyaltySettings.pointsPerRp || 50000;
  if (rpPerPtInput) rpPerPtInput.value = loyaltySettings.rpPerPoint || 100;

  // Toggle elemen pada form tambah pelanggan
  const grpPoints = document.getElementById('group-cust-points');
  const grpVoucher = document.getElementById('group-cust-voucher-eligible');
  if (grpPoints) grpPoints.style.display = isVoucher ? 'none' : 'block';
  if (grpVoucher) grpVoucher.style.display = isVoucher ? 'block' : 'none';

  // Toggle tabs filter voucher
  const vfTabs = document.getElementById('voucher-filter-tabs-container');
  if (vfTabs) vfTabs.style.display = isVoucher ? 'block' : 'none';

  // Sesuaikan header tabel pelanggan
  const thReward = document.getElementById('th-customer-reward-status');
  if (thReward) {
    thReward.textContent = isVoucher ? 'Voucher Bulan Ini' : 'Poin';
  }

  // Update checkbox di Pengaturan Sistem Toko jika ada
  const chkPointsMode = document.getElementById('chk-loyalty-points-mode');
  if (chkPointsMode) {
    chkPointsMode.checked = !isVoucher;
  }

  // Update badge mode aktif di CRM header
  const modeBadge = document.getElementById('loyalty-mode-active-badge');
  if (modeBadge) {
    modeBadge.textContent = isVoucher ? '🎟️ Mode Voucher Aktif' : '🪙 Mode Poin Aktif';
  }

  // Update jumlah member di CRM header
  const crmCountBadge = document.getElementById('crm-member-count-badge');
  if (crmCountBadge) {
    crmCountBadge.textContent = `${customers.length} Member`;
  }
}

// ─── PENGATURAN PILIH MEMBER KHUSUS UNTUK VOUCHER ───────────────────────────
let voucherMemberSearchKeyword = '';

function toggleVoucherTargetSelectionUI(val) {
  const box = document.getElementById('voucher-selected-members-box');
  if (box) {
    box.style.display = (val === 'selected') ? 'block' : 'none';
  }
  if (val === 'selected') {
    renderVoucherMembersCheckboxList();
  }
}

function filterVoucherMembersList(keyword) {
  voucherMemberSearchKeyword = (keyword || '').toLowerCase().trim();
  renderVoucherMembersCheckboxList();
}

function renderVoucherMembersCheckboxList() {
  const container = document.getElementById('voucher-members-checkbox-list');
  if (!container) return;
  container.innerHTML = '';

  const filtered = customers.filter(c => {
    if (!voucherMemberSearchKeyword) return true;
    const nameMatch = (c.nama || '').toLowerCase().includes(voucherMemberSearchKeyword);
    const phoneMatch = (c.telepon || '').includes(voucherMemberSearchKeyword);
    return nameMatch || phoneMatch;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted); text-align:center; padding:1rem;">Tidak ada pelanggan yang cocok dengan pencarian.</div>`;
    updateVoucherMembersSelectedCount();
    return;
  }

  filtered.forEach(c => {
    const isChecked = (c.isVoucherEligible !== false);
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.justifyContent = 'space-between';
    label.style.padding = '0.35rem 0.55rem';
    label.style.borderRadius = '6px';
    label.style.background = isChecked ? 'rgba(234,88,12,0.06)' : 'var(--bg-surface)';
    label.style.border = isChecked ? '1px solid rgba(234,88,12,0.3)' : '1px solid var(--border-color)';
    label.style.cursor = 'pointer';
    label.style.fontSize = '0.82rem';

    label.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
        <input type="checkbox" class="chk-voucher-member" data-id="${c.id}" ${isChecked ? 'checked' : ''} onchange="onVoucherMemberCheckboxChange(this)" style="width: 16px; height: 16px; accent-color: #ea580c; cursor: pointer;">
        <div>
          <strong style="color: var(--text-main);">${escapeHtml(c.nama)}</strong>
          ${c.telepon ? `<span style="font-size: 0.74rem; color: var(--text-muted); margin-left: 0.35rem;">(${escapeHtml(c.telepon)})</span>` : ''}
        </div>
      </div>
      <span style="font-size: 0.72rem; font-weight: 700; color: ${isChecked ? '#059669' : '#94a3b8'};">
        ${isChecked ? 'Dapat Voucher' : 'Tidak Dapat'}
      </span>
    `;
    container.appendChild(label);
  });

  updateVoucherMembersSelectedCount();
  if (window.lucide) lucide.createIcons();
}

function onVoucherMemberCheckboxChange(cb) {
  const custId = cb.dataset.id;
  const c = customers.find(x => x.id === custId);
  if (c) {
    c.isVoucherEligible = cb.checked;
    const parentLabel = cb.closest('label');
    if (parentLabel) {
      parentLabel.style.background = cb.checked ? 'rgba(234,88,12,0.06)' : 'var(--bg-surface)';
      parentLabel.style.border = cb.checked ? '1px solid rgba(234,88,12,0.3)' : '1px solid var(--border-color)';
      const statusSpan = parentLabel.querySelector('span:last-child');
      if (statusSpan) {
        statusSpan.textContent = cb.checked ? 'Dapat Voucher' : 'Tidak Dapat';
        statusSpan.style.color = cb.checked ? '#059669' : '#94a3b8';
      }
    }
  }
  updateVoucherMembersSelectedCount();
}

function toggleAllVoucherMembers(select) {
  customers.forEach(c => {
    c.isVoucherEligible = select;
  });
  renderVoucherMembersCheckboxList();
}

function updateVoucherMembersSelectedCount() {
  const countEl = document.getElementById('voucher-members-selected-count');
  if (countEl) {
    const totalEligible = customers.filter(c => c.isVoucherEligible !== false).length;
    countEl.textContent = `${totalEligible} dari ${customers.length} member terpilih`;
  }
}

function saveVoucherSettingsFromPane() {
  const target = document.getElementById('setting-voucher-target')?.value || 'all';
  const nominal = parseInt(document.getElementById('setting-voucher-nominal')?.value) || 10000;
  const quota = parseInt(document.getElementById('setting-voucher-monthly-quota')?.value) || 2;

  loyaltySettings.voucherTarget = target;
  loyaltySettings.voucherRpValue = Math.max(1000, nominal);
  loyaltySettings.voucherMonthlyQuota = Math.max(1, quota);
  localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
  saveLoyaltySettingsCloud();

  // Simpan status isVoucherEligible pada setiap customer jika target selected
  saveCustomersLocally();
  if (firebaseDb && typeof saveCustomerCloud === 'function') {
    customers.forEach(c => saveCustomerCloud(c));
  }

  const eligibleCount = customers.filter(c => c.isVoucherEligible !== false).length;
  const infoTarget = target === 'all' 
    ? 'Semua Pelanggan Terdaftar' 
    : `Member Khusus (${eligibleCount} Pelanggan Terpilih)`;

  alert(`✅ Pengaturan Voucher Bulanan berhasil disimpan!\n• Target: ${infoTarget}\n• 1 Voucher = Rp ${formatRupiah(loyaltySettings.voucherRpValue)}\n• Kuota: ${loyaltySettings.voucherMonthlyQuota} voucher/bulan`);
  renderCustomersTable();
}

function savePointsSettingsFromPane() {
  const ptsPerRp = parseInt(document.getElementById('setting-points-per-rp-cust')?.value) || 50000;
  const rpPerPt = parseInt(document.getElementById('setting-rp-per-point-cust')?.value) || 100;

  loyaltySettings.pointsPerRp = Math.max(1, ptsPerRp);
  loyaltySettings.rpPerPoint = Math.max(1, rpPerPt);
  localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
  saveLoyaltySettingsCloud();

  const settingPts = document.getElementById('setting-points-per-rp');
  const settingRp = document.getElementById('setting-rp-per-point');
  if (settingPts) settingPts.value = loyaltySettings.pointsPerRp;
  if (settingRp) settingRp.value = loyaltySettings.rpPerPoint;

  alert(`✅ Pengaturan Poin Toko berhasil disimpan!\n• Belanja Rp ${formatRupiah(loyaltySettings.pointsPerRp)} dapat 1 poin\n• 1 Poin = Rp ${formatRupiah(loyaltySettings.rpPerPoint)}`);
  renderCustomersTable();
}

// Helper: ambil bulan yang sedang dipilih di filter voucher (atau bulan ini jika kosong)
function getVoucherFilterMonth() {
  const mSelect = document.getElementById('voucher-filter-month-select');
  const ySelect = document.getElementById('voucher-filter-year-select');
  if (mSelect && ySelect && mSelect.value && ySelect.value) {
    const val = `${ySelect.value}-${mSelect.value}`;
    const hiddenEl = document.getElementById('voucher-filter-month');
    if (hiddenEl) hiddenEl.value = val;
    return val;
  }
  const el = document.getElementById('voucher-filter-month');
  return (el && el.value) ? el.value : getCurrentMonthKey();
}

// Handler saat dropdown Bulan (Januari-Desember) atau Tahun berubah
function onVoucherDropdownMonthChange() {
  const mSelect = document.getElementById('voucher-filter-month-select');
  const ySelect = document.getElementById('voucher-filter-year-select');
  const hiddenEl = document.getElementById('voucher-filter-month');
  if (mSelect && ySelect) {
    const val = `${ySelect.value}-${mSelect.value}`;
    if (hiddenEl) hiddenEl.value = val;
  }
  onVoucherMonthFilterChange();
}

// Inisialisasi opsi tahun dan sinkronisasi dropdown bulan voucher
function initVoucherMonthDropdowns() {
  const ySelect = document.getElementById('voucher-filter-year-select');
  const mSelect = document.getElementById('voucher-filter-month-select');
  const curKey = getCurrentMonthKey(); // misal "2026-10"
  const [curY, curM] = curKey.split('-');

  if (ySelect && ySelect.options.length === 0) {
    const nowY = parseInt(curY, 10);
    for (let y = nowY - 2; y <= nowY + 2; y++) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      if (y === nowY) opt.selected = true;
      ySelect.appendChild(opt);
    }
  }

  if (mSelect && !mSelect.value) {
    mSelect.value = curM;
  }
  if (ySelect && !ySelect.value) {
    ySelect.value = curY;
  }
}

// Handler saat input bulan voucher berubah
function onVoucherMonthFilterChange() {
  const month = getVoucherFilterMonth();
  const curMonth = getCurrentMonthKey();
  const label = document.getElementById('voucher-filter-month-label');
  const thReward = document.getElementById('th-customer-reward-status');
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

  if (month && month.includes('-')) {
    const [y, m] = month.split('-');
    const mIdx = parseInt(m, 10) - 1;
    const monthName = (mIdx >= 0 && mIdx < monthNames.length) ? monthNames[mIdx] : month;
    if (label) {
      if (month === curMonth) {
        label.textContent = `(Periode: ${monthName} ${y} - Bulan Ini)`;
      } else {
        label.textContent = `(Periode: ${monthName} ${y})`;
      }
    }
    if (thReward && loyaltySettings.rewardMode === 'voucher') {
      thReward.textContent = `Voucher (${monthName} ${y})`;
    }
  }
  renderCustomersTable();
}

// Reset ke bulan ini
function resetVoucherMonthFilter() {
  const curMonth = getCurrentMonthKey();
  const [curY, curM] = curMonth.split('-');
  const mSelect = document.getElementById('voucher-filter-month-select');
  const ySelect = document.getElementById('voucher-filter-year-select');
  const hiddenEl = document.getElementById('voucher-filter-month');
  if (mSelect) mSelect.value = curM;
  if (ySelect) ySelect.value = curY;
  if (hiddenEl) hiddenEl.value = curMonth;
  onVoucherMonthFilterChange();
}

function setVoucherTableFilter(filter) {
  currentCustomerVoucherFilter = filter;
  ['all', 'used', 'unused'].forEach(f => {
    const btn = document.getElementById(`btn-vf-${f}`);
    if (btn) {
      if (f === filter) {
        btn.style.background = f === 'used' ? '#059669' : f === 'unused' ? '#ea580c' : '#ea580c';
        btn.style.color = '#fff';
        btn.style.border = 'none';
      } else {
        btn.style.background = '#f1f5f9';
        btn.style.color = '#64748b';
        btn.style.border = '1px solid #e2e8f0';
      }
    }
  });
  renderCustomersTable();
}


function renderCustomersTable() {
  const tbody = document.getElementById('customer-table-body');
  if (!tbody) return;
  const search = document.getElementById('customer-search')?.value.toLowerCase().trim() || '';
  
  const clearBtn = document.getElementById('btn-clear-cust-search');
  if (clearBtn) clearBtn.style.display = search ? 'block' : 'none';

  // Update total badge member
  const totalBadge = document.getElementById('customer-total-badge');
  if (totalBadge) {
    totalBadge.textContent = `${customers.length} Member`;
  }

  // Update CRM KPI Quick Stat Cards
  const statMembersEl = document.getElementById('crm-stat-total-members');
  if (statMembersEl) statMembersEl.textContent = customers.length;

  const statRewardEl = document.getElementById('crm-stat-reward-mode');
  if (statRewardEl) {
    statRewardEl.textContent = (loyaltySettings.rewardMode === 'voucher') ? 'Voucher Bulanan' : 'Poin Belanja';
  }

  // Hitung total piutang aktif
  let totalActiveDebt = 0;
  const debtorSet = new Set();
  transactions.forEach(tx => {
    const sisa = tx.sisa_piutang || 0;
    if (sisa > 0) {
      totalActiveDebt += sisa;
      if (tx.nama_pelanggan) debtorSet.add(tx.nama_pelanggan.toLowerCase());
    }
  });

  const statDebtEl = document.getElementById('crm-stat-active-debt');
  if (statDebtEl) statDebtEl.textContent = `Rp ${formatRupiah(totalActiveDebt)}`;

  const statDebtorsLabelEl = document.getElementById('crm-stat-debtors-label');
  if (statDebtorsLabelEl) statDebtorsLabelEl.textContent = `${debtorSet.size} pelanggan`;

  // Hitung transaksi terkait member
  const memberNames = new Set(customers.map(c => (c.nama || '').toLowerCase()));
  const memberTxCount = transactions.filter(tx => tx.nama_pelanggan && memberNames.has(tx.nama_pelanggan.toLowerCase())).length;

  const statMemberTxEl = document.getElementById('crm-stat-member-tx-count');
  if (statMemberTxEl) statMemberTxEl.textContent = memberTxCount;

  const isVoucher = (loyaltySettings.rewardMode === 'voucher');
  if (typeof initVoucherMonthDropdowns === 'function') initVoucherMonthDropdowns();
  // Gunakan bulan dari filter yang dipilih user, bukan selalu bulan ini
  const curMonth = getVoucherFilterMonth();
  const realCurMonth = getCurrentMonthKey();

  // Inisialisasi input month ke bulan ini jika masih kosong
  const monthInput = document.getElementById('voucher-filter-month');
  if (monthInput && !monthInput.value) monthInput.value = realCurMonth;

  // Update label periode bulan
  const label = document.getElementById('voucher-filter-month-label');
  const thReward = document.getElementById('th-customer-reward-status');
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  if (curMonth && curMonth.includes('-')) {
    const [y, m] = curMonth.split('-');
    const mIdx = parseInt(m, 10) - 1;
    const monthName = (mIdx >= 0 && mIdx < monthNames.length) ? monthNames[mIdx] : curMonth;
    if (label) {
      if (curMonth === realCurMonth) {
        label.textContent = `(Periode: ${monthName} ${y} - Bulan Ini)`;
      } else {
        label.textContent = `(Periode: ${monthName} ${y})`;
      }
    }
    if (thReward && isVoucher) {
      thReward.textContent = `Voucher (${monthName} ${y})`;
    }
  }

  // Hitung jumlah untuk filter monitoring voucher
  let usedCount = 0;
  let unusedCount = 0;
  customers.forEach(c => {
    const stats = getCustomerMonthlyVoucherStats(c, curMonth);
    if (stats.used > 0) usedCount++;
    else unusedCount++;
  });

  const countAllEl = document.getElementById('count-vf-all');
  const countUsedEl = document.getElementById('count-vf-used');
  const countUnusedEl = document.getElementById('count-vf-unused');
  if (countAllEl) countAllEl.textContent = customers.length;
  if (countUsedEl) countUsedEl.textContent = usedCount;
  if (countUnusedEl) countUnusedEl.textContent = unusedCount;

  tbody.innerHTML = '';
  
  let filtered = customers.filter(c => 
    String(c.nama || '').toLowerCase().includes(search) || 
    (c.telepon && String(c.telepon).toLowerCase().includes(search)) ||
    (c.domisili && String(c.domisili).toLowerCase().includes(search))
  );

  // Jika mode Voucher dan filter aktif (used atau unused)
  if (isVoucher) {
    if (currentCustomerVoucherFilter === 'used') {
      filtered = filtered.filter(c => {
        const stats = getCustomerMonthlyVoucherStats(c, curMonth);
        return stats.used > 0;
      });
    } else if (currentCustomerVoucherFilter === 'unused') {
      filtered = filtered.filter(c => {
        const stats = getCustomerMonthlyVoucherStats(c, curMonth);
        return stats.used === 0;
      });
    }
  }
  
  if (filtered.length === 0) {
    const isSearching = !!search;
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 3rem 1.5rem;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 68px; height: 68px; border-radius: 20px; background: rgba(234,88,12,0.08); color: #ea580c; margin-bottom: 1rem;">
            <i data-lucide="${isSearching ? 'search-x' : 'user-x'}" style="width: 32px; height: 32px;"></i>
          </div>
          <div style="font-weight: 800; color: var(--text-main); font-size: 1.05rem;">
            ${isSearching ? 'Pelanggan Tidak Ditemukan' : 'Belum Ada Data Pelanggan'}
          </div>
          <div style="font-size: 0.84rem; color: var(--text-muted); margin-top: 0.35rem; max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            ${isSearching 
              ? 'Tidak ada nama pelanggan, no. telepon, atau domisili yang cocok dengan kata kunci pencarian.' 
              : 'Daftarkan pelanggan setia toko Anda untuk mulai mengumpulkan poin atau membagikan voucher belanja bulanan.'}
          </div>
          ${!isSearching ? `
            <button type="button" onclick="openAddCustomerModal()" style="margin-top: 1.25rem; background: linear-gradient(135deg, #ea580c, #f97316); color: #fff; border: none; padding: 0.6rem 1.35rem; border-radius: 10px; font-weight: 800; font-size: 0.88rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.45rem; box-shadow: 0 4px 14px rgba(234,88,12,0.28);">
              <i data-lucide="user-plus" style="width: 16px; height: 16px;"></i>
              Tambah Pelanggan Pertama
            </button>
          ` : `
            <button type="button" onclick="clearCustomerSearch()" style="margin-top: 1rem; background: var(--bg-body); color: var(--text-main); border: 1px solid var(--border-color); padding: 0.5rem 1.1rem; border-radius: 8px; font-weight: 700; font-size: 0.82rem; cursor: pointer;">
              Reset Pencarian
            </button>
          `}
        </td>
      </tr>
    `;
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      try { lucide.createIcons(); } catch(e) {}
    }
    return;
  }
  
  const customersToRender = filtered.slice(0, 50);
  
  if (filtered.length > 50) {
    const infoTr = document.createElement('tr');
    infoTr.innerHTML = `<td colspan="5" style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem; background: var(--bg-body);">Ditemukan ${filtered.length} pelanggan. Menampilkan 50 teratas.</td>`;
    tbody.appendChild(infoTr);
  }
  
  customersToRender.forEach(c => {
    const tr = document.createElement('tr');

    let rewardColHtml = '';
    let actionButtonsHtml = '';

    if (isVoucher) {
      // Mode Voucher
      const vStats = getCustomerMonthlyVoucherStats(c, curMonth);
      const rpValue = vStats.remaining * (loyaltySettings.voucherRpValue || 10000);

      let statusBadge = '';
      if (!vStats.eligible) {
        statusBadge = `<span style="font-size: 0.72rem; color: #64748b; background: #e2e8f0; padding: 0.15rem 0.45rem; border-radius: 999px;">Non-Eligible</span>`;
      } else if (vStats.used === 0) {
        statusBadge = `<span style="font-size: 0.72rem; color: #059669; background: #ecfdf5; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid #a7f3d0;">Belum Digunakan</span>`;
      } else if (vStats.remaining === 0) {
        statusBadge = `<span style="font-size: 0.72rem; color: #dc2626; background: #fef2f2; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid #fecaca;">Habis (${vStats.used}/${vStats.quota})</span>`;
      } else {
        statusBadge = `<span style="font-size: 0.72rem; color: #d97706; background: #fffbeb; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid #fde68a;">Terpakai ${vStats.used}/${vStats.quota}</span>`;
      }

      rewardColHtml = `
        <div>
          <div style="display: inline-flex; align-items: center; gap: 0.4rem; background: rgba(245, 158, 11, 0.1); padding: 0.25rem 0.6rem; border-radius: 999px; border: 1px solid rgba(245, 158, 11, 0.3);">
            <span style="font-weight: 800; color: #d97706; font-size: 0.9rem;">${vStats.remaining}</span>
            <span style="font-size: 0.72rem; color: var(--text-muted);">Sisa (Rp ${formatRupiah(rpValue)})</span>
          </div>
          <div style="margin-top: 4px;">${statusBadge}</div>
        </div>
      `;

      actionButtonsHtml = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="openCustomerHistoryModal('${c.id}')" title="Lihat Riwayat Belanja Member (Detail Barang & Tanggal)" style="border-radius: 8px; padding: 0.35rem 0.65rem; font-weight: 700; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.3rem;">
          <i data-lucide="shopping-bag" style="width: 14px; height: 14px;"></i>
          <span>Belanja</span>
        </button>
        <button type="button" class="btn btn-success btn-sm" onclick="openVoucherWaReminderModal('${c.id}')" title="Kirim Pengingat Voucher ke WhatsApp Member" style="border-radius: 8px; padding: 0.35rem 0.65rem; font-weight: 700; font-size: 0.8rem; background: #25d366; border-color: #25d366; color: #fff; display: inline-flex; align-items: center; gap: 0.35rem;">
          <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: white; flex-shrink: 0;"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.2.662.591 1.221.774 1.394.86.173.086.275.072.376-.044.101-.116.433-.506.549-.68.116-.173.231-.145.39-.086s1.011.477 1.184.564.289.13.332.203c.043.071.043.419-.101.824z"/></svg>
          <span>WA</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="openEditCustomerModal('${c.id}')" title="Edit Data Pelanggan" style="border-radius: 8px; padding: 0.35rem 0.65rem; font-weight: 600; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.3rem;">
          <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
          <span>Edit</span>
        </button>
        <button type="button" class="btn btn-sm" onclick="openCustomerVoucherDetail('${c.id}')" title="Lihat Status & Riwayat Voucher" style="border-radius: 8px; padding: 0.35rem 0.7rem; font-weight: 700; font-size: 0.8rem; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #fff; border: none; display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer;">
          <i data-lucide="ticket" style="width: 14px; height: 14px;"></i>
          <span>Voucher</span>
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" title="Hapus Pelanggan" style="border-radius: 8px; padding: 0.35rem 0.5rem; font-size: 0.8rem; display: inline-flex; align-items: center;">
          <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
        </button>
      `;
    } else {
      // Mode Poin
      const points = c.poin || 0;
      const rpValue = points * (loyaltySettings.rpPerPoint || 100);

      rewardColHtml = `
        <div style="display: inline-flex; align-items: center; gap: 0.4rem; background: rgba(234, 88, 12, 0.08); padding: 0.25rem 0.6rem; border-radius: 999px; border: 1px solid rgba(234, 88, 12, 0.2);">
          <span style="font-weight: 800; color: #ea580c; font-size: 0.9rem;">${points}</span>
          <span style="font-size: 0.72rem; color: #64748b;">pts (Rp ${formatRupiah(rpValue)})</span>
        </div>
      `;

      actionButtonsHtml = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="openCustomerHistoryModal('${c.id}')" title="Lihat Riwayat Belanja Member (Detail Barang & Tanggal)" style="border-radius: 8px; padding: 0.35rem 0.65rem; font-weight: 700; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.3rem;">
          <i data-lucide="shopping-bag" style="width: 14px; height: 14px;"></i>
          <span>Belanja</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="openEditCustomerModal('${c.id}')" title="Edit Data Pelanggan" style="border-radius: 8px; padding: 0.35rem 0.65rem; font-weight: 600; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.3rem;">
          <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
          <span>Edit</span>
        </button>
        <button type="button" class="btn btn-sm" onclick="openRedeemPointsModal('${c.id}')" title="Tukar Poin Pelanggan" style="border-radius: 8px; padding: 0.35rem 0.7rem; font-weight: 700; font-size: 0.8rem; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; display: inline-flex; align-items: center; gap: 0.35rem; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.25); cursor: pointer;">
          <i data-lucide="gift" style="width: 14px; height: 14px;"></i>
          <span>Tukar Poin</span>
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" title="Hapus Pelanggan" style="border-radius: 8px; padding: 0.35rem 0.5rem; font-size: 0.8rem; display: inline-flex; align-items: center;">
          <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
        </button>
      `;
    }

    const phoneDisplay = c.telepon ? `<span style="display:inline-flex; align-items:center; gap:0.3rem;"><i data-lucide="phone" style="width:13px; height:13px; color:#64748b;"></i>${c.telepon}</span>` : '-';
    const domisiliDisplay = c.domisili ? `<span style="display:inline-flex; align-items:center; gap:0.3rem;"><i data-lucide="map-pin" style="width:13px; height:13px; color:#ea580c;"></i>${c.domisili}</span>` : '<span style="color:var(--text-muted); opacity:0.6;">-</span>';

    tr.innerHTML = `
      <td>
        <div style="font-weight: 700; color: var(--text-main);">${c.nama}</div>
      </td>
      <td>
        <span style="font-size: 0.88rem; color: var(--text-muted); font-family: monospace;">${phoneDisplay}</span>
      </td>
      <td>
        <span style="font-size: 0.85rem; color: var(--text-muted);">${domisiliDisplay}</span>
      </td>
      <td>
        ${rewardColHtml}
      </td>
      <td style="white-space: nowrap;">
        <div style="display: inline-flex; gap: 0.4rem; align-items: center;">
          ${actionButtonsHtml}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

let activeVoucherCardCustomerId = null;

// Lihat status voucher member individual dalam bentuk Kartu Digital Modern
function openCustomerVoucherDetail(customerId) {
  const c = customers.find(x => x.id === customerId);
  if (!c) return;
  activeVoucherCardCustomerId = customerId;

  const curMonth = getCurrentMonthKey();
  const vStats = getCustomerMonthlyVoucherStats(c, curMonth);
  const rpNominal = loyaltySettings.voucherRpValue || 10000;
  const totalRp = vStats.remaining * rpNominal;
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : ((appConfig && appConfig.storeName) ? appConfig.storeName : 'TOKO KAMI');

  const modal = document.getElementById('customer-voucher-card-modal');
  if (!modal) return;

  const elStore = document.getElementById('vcard-store-name');
  if (elStore) elStore.textContent = storeName;

  const elPeriod = document.getElementById('vcard-period');
  if (elPeriod) elPeriod.textContent = `Periode ${curMonth}`;

  const elCustName = document.getElementById('vcard-cust-name');
  if (elCustName) elCustName.textContent = c.nama || 'Pelanggan';

  const elCustPhone = document.getElementById('vcard-cust-phone');
  if (elCustPhone) elCustPhone.textContent = c.telepon ? `No. HP: ${c.telepon}` : 'No. HP: Belum terdaftar';

  const elQuotaStatus = document.getElementById('vcard-quota-status');
  if (elQuotaStatus) {
    if (vStats.remaining > 0) {
      elQuotaStatus.textContent = `Tersedia: ${vStats.remaining} Voucher`;
      elQuotaStatus.style.color = '#ffffff';
    } else {
      elQuotaStatus.textContent = `⚠️ Kuota Habis (0 Voucher)`;
      elQuotaStatus.style.color = '#fee2e2';
    }
  }

  const elQuotaDetail = document.getElementById('vcard-quota-detail');
  if (elQuotaDetail) {
    elQuotaDetail.textContent = `Terpakai: ${vStats.used} dari ${vStats.quota} voucher bulanan`;
  }

  const elTotalRp = document.getElementById('vcard-total-rp');
  if (elTotalRp) {
    elTotalRp.textContent = `Rp ${formatRupiah(totalRp)}`;
  }

  const elNominalUnit = document.getElementById('vcard-nominal-per-unit');
  if (elNominalUnit) {
    elNominalUnit.textContent = `@Rp ${formatRupiah(rpNominal)} / lembar voucher`;
  }

  const btnSendWa = document.getElementById('btn-vcard-send-wa');
  if (btnSendWa) {
    btnSendWa.style.display = c.telepon ? 'inline-flex' : 'none';
  }

  modal.classList.add('active');
  modal.style.display = 'flex';
}

function closeCustomerVoucherCardModal() {
  const modal = document.getElementById('customer-voucher-card-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function printCustomerVoucherCard() {
  const c = customers.find(x => x.id === activeVoucherCardCustomerId);
  if (!c) {
    alert("Pelanggan tidak ditemukan!");
    return;
  }
  const curMonth = getCurrentMonthKey();
  const vStats = getCustomerMonthlyVoucherStats(c, curMonth);
  const rpNominal = loyaltySettings.voucherRpValue || 10000;
  const totalRp = vStats.remaining * rpNominal;
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : 'TOKO KAMI';
  const storeAddress = (receiptSettings && receiptSettings.address) ? receiptSettings.address : '';
  const storePhone = (receiptSettings && receiptSettings.phone) ? receiptSettings.phone : '';

  const printWindow = window.open('', '_blank', 'width=650,height=750');
  if (!printWindow) {
    alert("Popup browser terblokir! Izinkan popup untuk mencetak kartu voucher.");
    return;
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Voucher Member - ${c.nama}</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #f8fafc;
          margin: 0;
          padding: 30px;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 90vh;
        }
        .voucher-card {
          width: 500px;
          border-radius: 20px;
          background: linear-gradient(135deg, #b45309 0%, #d97706 40%, #ea580c 100%);
          color: #ffffff;
          padding: 30px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.25);
          border: 2px dashed rgba(255,255,255,0.5);
          position: relative;
          overflow: hidden;
        }
        .top-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        .store-name {
          font-size: 1.1rem;
          font-weight: 800;
          letter-spacing: 1px;
          text-transform: uppercase;
        }
        .period-badge {
          background: rgba(255,255,255,0.25);
          padding: 4px 12px;
          border-radius: 999px;
          font-size: 0.8rem;
          font-weight: 700;
        }
        .cust-section {
          margin-bottom: 20px;
        }
        .cust-label {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: rgba(255,255,255,0.85);
        }
        .cust-name {
          font-size: 2rem;
          font-weight: 900;
          line-height: 1.2;
          margin: 4px 0;
        }
        .cust-phone {
          font-size: 0.9rem;
          opacity: 0.9;
          font-family: monospace;
        }
        .divider {
          border-top: 2px dashed rgba(255,255,255,0.45);
          margin: 20px 0;
        }
        .bottom-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
        }
        .status-title {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: rgba(255,255,255,0.85);
        }
        .quota-status {
          font-size: 1.3rem;
          font-weight: 900;
          margin: 3px 0;
        }
        .total-rp {
          font-size: 1.8rem;
          font-weight: 900;
          color: #fef08a;
          text-align: right;
        }
        .nominal-unit {
          font-size: 0.8rem;
          text-align: right;
          opacity: 0.9;
        }
        .voucher-footer {
          margin-top: 20px;
          padding-top: 15px;
          border-top: 1px solid rgba(255,255,255,0.25);
          font-size: 0.75rem;
          text-align: center;
          opacity: 0.85;
        }
        @media print {
          body { background: none; padding: 0; }
          .voucher-card { box-shadow: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      </style>
    </head>
    <body>
      <div class="voucher-card">
        <div class="top-row">
          <div class="store-name">✨ ${storeName}</div>
          <div class="period-badge">Periode ${curMonth}</div>
        </div>
        <div class="cust-section">
          <div class="cust-label">MEMBER PENERIMA:</div>
          <div class="cust-name">${c.nama}</div>
          <div class="cust-phone">No. HP: ${c.telepon || '-'}</div>
        </div>
        <div class="divider"></div>
        <div class="bottom-row">
          <div>
            <div class="status-title">STATUS KUOTA VOUCHER:</div>
            <div class="quota-status">${vStats.remaining > 0 ? 'Tersedia: ' + vStats.remaining + ' Lembar' : '⚠️ Kuota Habis (0 Voucher)'}</div>
            <div style="font-size:0.75rem; opacity:0.85;">Terpakai: ${vStats.used} dari ${vStats.quota} kuota bulanan</div>
          </div>
          <div>
            <div class="status-title" style="text-align:right;">TOTAL NILAI VOUCHER:</div>
            <div class="total-rp">Rp ${formatRupiah(totalRp)}</div>
            <div class="nominal-unit">@Rp ${formatRupiah(rpNominal)} / voucher</div>
          </div>
        </div>
        <div class="voucher-footer">
          💡 Berlaku tanpa kadaluarsa. Tunjukkan kartu voucher ini saat pembayaran di kasir ${storeName}.<br>
          ${storeAddress ? storeAddress + ' | ' : ''}${storePhone ? 'Telp: ' + storePhone : ''}
        </div>
      </div>
      <script>
        window.onload = function() {
          setTimeout(function() {
            window.print();
          }, 350);
        };
      <\/script>
    </body>
    </html>
  `;

  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

function openVoucherWaReminderModalFromCard() {
  if (!activeVoucherCardCustomerId) return;
  closeCustomerVoucherCardModal();
  openVoucherWaReminderModal(activeVoucherCardCustomerId);
}

function updateCustomerNameGlobally(id, oldName, newName, newPhone) {
  if (!oldName || String(oldName).trim().toLowerCase() === String(newName).trim().toLowerCase()) return;

  const oldClean = String(oldName).trim().toLowerCase();
  let updatedTxCount = 0;
  const txUpdates = {};

  transactions.forEach(t => {
    // Cek kecocokan berdasarkan ID pelanggan atau nama lama (case-insensitive & trimmed)
    const matchById = t.customerId && String(t.customerId) === String(id);
    const matchByName = t.nama_pelanggan && String(t.nama_pelanggan).trim().toLowerCase() === oldClean;
    
    if (matchById || matchByName) {
      t.nama_pelanggan = newName;
      if (newPhone) t.telepon_pelanggan = newPhone;
      updatedTxCount++;

      if (firebaseDb && typeof getStorePath === 'function') {
        txUpdates[getStorePath('transactions/' + t.id)] = JSON.parse(JSON.stringify(t));
      }
    }
  });

  if (updatedTxCount > 0) {
    saveTransactionsLocally();
    if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
    if (typeof renderCustomerDebtBook === 'function') renderCustomerDebtBook();
    if (typeof updateAnalytics === 'function') updateAnalytics();
    
    // Simpan pembaruan transaksi terkait ke Cloud
    if (firebaseDb && Object.keys(txUpdates).length > 0) {
      firebaseDb.ref('/').update(txUpdates).catch(err => {
        console.warn('⚠️ Gagal sync pembaruan nama member pada transaksi ke cloud:', err.message);
      });
    }
  }

  // Perbarui jika sedang ada di held carts (antrean belanja kasir)
  if (Array.isArray(heldCarts) && heldCarts.length > 0) {
    let heldUpdated = false;
    heldCarts.forEach(hc => {
      if (hc.customerName && hc.customerName.trim().toLowerCase() === oldClean) {
        hc.customerName = newName;
        heldUpdated = true;
      }
    });
    if (heldUpdated) {
      localStorage.setItem('kasir_held_carts', JSON.stringify(heldCarts));
    }
  }

  // Perbarui input kasir aktif jika sedang memilih nama lama
  const posCustInput = document.getElementById('customer-name-input');
  if (posCustInput && posCustInput.value.trim().toLowerCase() === oldClean) {
    posCustInput.value = newName;
  }

  // Refresh datalist pelanggan di POS kasir
  const datalist = document.getElementById('customer-list');
  if (datalist) {
    datalist.innerHTML = customers.map(c => `<option value="${c.nama}">`).join('');
  }
}

function saveCustomer(event) {
  event.preventDefault();
  
  const id = document.getElementById('edit-customer-id').value;
  const nama = document.getElementById('cust-name').value.trim();
  const telepon = document.getElementById('cust-phone').value.trim();
  const domisili = (document.getElementById('cust-address')?.value || '').trim();
  const poin = parseInt(document.getElementById('cust-points')?.value) || 0;
  const isVoucherEligible = document.getElementById('cust-voucher-eligible')?.checked ?? true;
  
  if (!nama) {
    alert("Nama pelanggan wajib diisi!");
    return;
  }
  
  if (id) {
    const index = customers.findIndex(c => c.id === id);
    if (index !== -1) {
      const oldName = customers[index].nama;
      customers[index] = { ...customers[index], nama, telepon, domisili, poin, isVoucherEligible };
      saveCustomersLocally();
      renderCustomersTable();
      saveCustomerCloud(customers[index]);

      updateCustomerNameGlobally(id, oldName, nama, telepon);
      alert("✅ Data pelanggan berhasil diperbarui di seluruh sistem!");
    }
  } else {
    customers.push({
      id: 'CUST-' + Date.now(),
      nama,
      telepon,
      domisili,
      poin,
      isVoucherEligible,
      voucherUsage: {}
    });
    saveCustomersLocally();
    renderCustomersTable();
  }
  
  // Sinkronkan ke Firebase jika terhubung
  const savedCustomer = id ? customers.find(c => c.id === id) : customers[customers.length - 1];
  if (savedCustomer) {
    saveCustomerCloud(savedCustomer);
  }
  
  resetCustomerForm();
}

function resetCustomerForm() {
  const form = document.getElementById('customer-form');
  if (form) form.reset();
  const editId = document.getElementById('edit-customer-id');
  if (editId) editId.value = '';
  const formTitle = document.getElementById('customer-form-title');
  if (formTitle) formTitle.textContent = 'Tambah Pelanggan Baru';
  const vCheck = document.getElementById('cust-voucher-eligible');
  if (vCheck) vCheck.checked = true;
  // Close the add-customer modal if open
  closeAddCustomerModal();
}

// ─── Modal: Tambah Pelanggan Baru ─────────────────────────────────────────────
function openAddCustomerModal() {
  // Reset form terlebih dahulu
  const form = document.getElementById('customer-form');
  if (form) form.reset();
  const editId = document.getElementById('edit-customer-id');
  if (editId) editId.value = '';
  const formTitle = document.getElementById('customer-form-title');
  if (formTitle) formTitle.textContent = 'Tambah Pelanggan Baru';
  // Sesuaikan field form dengan mode reward aktif
  const isVoucher = (loyaltySettings.rewardMode === 'voucher');
  const grpPoints = document.getElementById('group-cust-points');
  const grpVoucher = document.getElementById('group-cust-voucher-eligible');
  if (grpPoints) grpPoints.style.display = isVoucher ? 'none' : 'block';
  if (grpVoucher) grpVoucher.style.display = isVoucher ? 'block' : 'none';
  const vCheck = document.getElementById('cust-voucher-eligible');
  if (vCheck) vCheck.checked = true;
  const modal = document.getElementById('add-customer-modal');
  if (modal) { modal.style.display = 'flex'; modal.classList.add('active'); }
}

function closeAddCustomerModal() {
  const modal = document.getElementById('add-customer-modal');
  if (modal) { modal.style.display = 'none'; modal.classList.remove('active'); }
}

// ─── Modal: Pengaturan Loyalitas / Reward ─────────────────────────────────────
function openLoyaltySettingsModal() {
  syncLoyaltySettingsUI();
  const modal = document.getElementById('loyalty-settings-modal');
  if (modal) { modal.style.display = 'flex'; modal.classList.add('active'); }
}

function closeLoyaltySettingsModal() {
  const modal = document.getElementById('loyalty-settings-modal');
  if (modal) { modal.style.display = 'none'; modal.classList.remove('active'); }
}

function editCustomer(id) {
  openEditCustomerModal(id);
}

// Dialog / Modal Edit Pelanggan
function openEditCustomerModal(id) {
  const c = customers.find(x => x.id === id);
  if (!c) return;

  const isVoucher = (loyaltySettings.rewardMode === 'voucher');

  document.getElementById('modal-cust-id').value = c.id;
  document.getElementById('modal-cust-name').value = c.nama || '';
  document.getElementById('modal-cust-phone').value = c.telepon || '';
  document.getElementById('modal-cust-address').value = c.domisili || '';
  document.getElementById('modal-cust-points').value = c.poin || 0;

  const grpPoints = document.getElementById('modal-group-cust-points');
  const grpVoucher = document.getElementById('modal-group-cust-voucher');
  const checkVoucher = document.getElementById('modal-cust-voucher-eligible');
  if (grpPoints) grpPoints.style.display = isVoucher ? 'none' : 'block';
  if (grpVoucher) grpVoucher.style.display = isVoucher ? 'block' : 'none';
  if (checkVoucher) checkVoucher.checked = (c.isVoucherEligible !== false);

  const modal = document.getElementById('edit-customer-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeEditCustomerModal() {
  const modal = document.getElementById('edit-customer-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function saveCustomerModal(event) {
  event.preventDefault();

  const id = document.getElementById('modal-cust-id').value;
  const nama = document.getElementById('modal-cust-name').value.trim();
  const telepon = document.getElementById('modal-cust-phone').value.trim();
  const domisili = document.getElementById('modal-cust-address').value.trim();
  const poin = parseInt(document.getElementById('modal-cust-points').value) || 0;
  const isVoucherEligible = document.getElementById('modal-cust-voucher-eligible')?.checked ?? true;

  if (!nama) {
    alert("Nama pelanggan wajib diisi!");
    return;
  }

  const index = customers.findIndex(c => c.id === id);
  if (index !== -1) {
    const oldName = customers[index].nama;

    customers[index] = { ...customers[index], nama, telepon, domisili, poin, isVoucherEligible };
    saveCustomersLocally();
    renderCustomersTable();
    saveCustomerCloud(customers[index]);

    updateCustomerNameGlobally(id, oldName, nama, telepon);

    alert("✅ Data pelanggan berhasil diperbarui di seluruh sistem!");
  }

  closeEditCustomerModal();
}

// Modal Tukar Poin Pelanggan (CRM)
function openRedeemPointsModal(id) {
  const c = customers.find(x => x.id === id);
  if (!c) return;

  const currentPoints = c.poin || 0;
  const rpPerPt = (loyaltySettings && loyaltySettings.rpPerPoint) ? loyaltySettings.rpPerPoint : 100;
  const totalValueRp = currentPoints * rpPerPt;

  document.getElementById('redeem-modal-cust-id').value = c.id;
  document.getElementById('redeem-modal-cust-name').textContent = c.nama;
  document.getElementById('redeem-modal-current-points').textContent = `${currentPoints} Poin`;
  document.getElementById('redeem-modal-current-rp').textContent = `Rp ${formatRupiah(totalValueRp)}`;

  const pointsInput = document.getElementById('redeem-modal-points-input');
  pointsInput.value = '';
  pointsInput.max = currentPoints;
  document.getElementById('redeem-modal-notes').value = '';

  calculateRedeemModalValue();

  const modal = document.getElementById('redeem-points-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeRedeemPointsModal() {
  const modal = document.getElementById('redeem-points-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function calculateRedeemModalValue() {
  const id = document.getElementById('redeem-modal-cust-id').value;
  const c = customers.find(x => x.id === id);
  const currentPoints = c ? (c.poin || 0) : 0;
  const rpPerPt = (loyaltySettings && loyaltySettings.rpPerPoint) ? loyaltySettings.rpPerPoint : 100;

  const inputVal = parseInt(document.getElementById('redeem-modal-points-input').value) || 0;
  const clampedPoints = Math.max(0, Math.min(inputVal, currentPoints));

  const exchangeRp = clampedPoints * rpPerPt;
  const remainingPoints = currentPoints - clampedPoints;

  document.getElementById('redeem-modal-exchange-rp').textContent = `Rp ${formatRupiah(exchangeRp)}`;
  document.getElementById('redeem-modal-remaining-points').textContent = `${remainingPoints} Poin`;
}

function submitCustomerPointsRedemption(event) {
  event.preventDefault();

  const id = document.getElementById('redeem-modal-cust-id').value;
  const c = customers.find(x => x.id === id);
  if (!c) return;

  const pointsToRedeem = parseInt(document.getElementById('redeem-modal-points-input').value) || 0;
  const notes = document.getElementById('redeem-modal-notes').value.trim() || 'Hadiah / Souvenir CRM';

  if (pointsToRedeem <= 0) {
    alert("Jumlah poin yang ditukar harus lebih dari 0!");
    return;
  }

  if (pointsToRedeem > (c.poin || 0)) {
    alert(`Poin tidak cukup! Saldo poin saat ini hanya ${c.poin || 0} poin.`);
    return;
  }

  const rpPerPt = (loyaltySettings && loyaltySettings.rpPerPoint) ? loyaltySettings.rpPerPoint : 100;
  const nilaiRupiah = pointsToRedeem * rpPerPt;

  if (confirm(`Konfirmasi penukaran ${pointsToRedeem} poin (Senilai Rp ${formatRupiah(nilaiRupiah)})\nUntuk Pelanggan: ${c.nama}\nKeterangan: ${notes}`)) {
    c.poin = (c.poin || 0) - pointsToRedeem;
    saveCustomersLocally();
    renderCustomersTable();
    saveCustomerCloud(c);

    alert(`🎉 Berhasil menukarkan ${pointsToRedeem} poin untuk ${c.nama}!\nSisa saldo poin sekarang: ${c.poin} poin.`);
    closeRedeemPointsModal();
  }
}

function deleteCustomer(id) {
  if (confirm("Hapus pelanggan ini?")) {
    customers = customers.filter(c => c.id !== id);
    saveCustomersLocally();
    renderCustomersTable();
    deleteCustomerCloud(id);
  }
}


function saveCustomersLocally() {
  localStorage.setItem('kasir_customers', JSON.stringify(customers));
}

let activeCustomerDropdownIndex = -1;
let currentCustomerDropdownList = [];

function openCustomerDropdown() {
  const input = document.getElementById('customer-name-input');
  if (input) renderCustomerDropdown(input.value);
}

function closeCustomerDropdown() {
  const dropdown = document.getElementById('customer-dropdown-list');
  if (dropdown) dropdown.style.display = 'none';
  activeCustomerDropdownIndex = -1;
  currentCustomerDropdownList = [];
}

function handleCustomerInputKeydowns(e) {
  const dropdown = document.getElementById('customer-dropdown-list');
  const isDropdownVisible = dropdown && dropdown.style.display !== 'none' && currentCustomerDropdownList.length > 0;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!isDropdownVisible) {
      openCustomerDropdown();
      return;
    }
    if (activeCustomerDropdownIndex < currentCustomerDropdownList.length - 1) {
      activeCustomerDropdownIndex++;
    } else {
      activeCustomerDropdownIndex = 0; // loop back to top
    }
    updateCustomerDropdownActiveState();
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isDropdownVisible) {
      openCustomerDropdown();
      return;
    }
    if (activeCustomerDropdownIndex > 0) {
      activeCustomerDropdownIndex--;
    } else {
      activeCustomerDropdownIndex = currentCustomerDropdownList.length - 1; // loop to bottom
    }
    updateCustomerDropdownActiveState();
    return;
  }

  if (e.key === 'Enter') {
    if (isDropdownVisible && activeCustomerDropdownIndex >= 0 && activeCustomerDropdownIndex < currentCustomerDropdownList.length) {
      e.preventDefault();
      e.stopPropagation();
      const selected = currentCustomerDropdownList[activeCustomerDropdownIndex];
      selectCustomerFromDropdown(selected.id);
      return;
    }
    // Jika tidak memilih dari dropdown tapi menekan Enter, tetap pindahkan fokus ke nominal uang diterima
    e.preventDefault();
    e.stopPropagation();
    closeCustomerDropdown();
    const cashInput = document.getElementById('cash-received');
    if (cashInput && cashInput.offsetParent !== null) {
      cashInput.focus();
      cashInput.select();
    }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    closeCustomerDropdown();
  }
}

function updateCustomerDropdownActiveState() {
  const dropdown = document.getElementById('customer-dropdown-list');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.customer-dropdown-item');
  items.forEach((item, idx) => {
    const nameEl = item.querySelector('.customer-item-name');
    const metaEls = item.querySelectorAll('.customer-item-meta, .customer-item-meta span, .customer-item-meta i');
    const badgeEl = item.querySelector('.customer-item-badge');
    const subBadgeEl = item.querySelector('.customer-item-subbadge');

    if (idx === activeCustomerDropdownIndex) {
      item.style.backgroundColor = '#ea580c'; // Orange pekat sama seperti seleksi produk
      item.style.color = '#ffffff';
      if (nameEl) nameEl.style.color = '#ffffff';
      metaEls.forEach(el => el.style.color = 'rgba(255, 255, 255, 0.9)');
      if (badgeEl) {
        badgeEl.style.background = 'rgba(255, 255, 255, 0.25)';
        badgeEl.style.color = '#ffffff';
      }
      if (subBadgeEl) subBadgeEl.style.color = 'rgba(255, 255, 255, 0.85)';
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.style.backgroundColor = 'transparent';
      item.style.color = 'inherit';
      if (nameEl) nameEl.style.color = 'var(--text-main)';
      metaEls.forEach(el => el.style.color = 'var(--text-muted)');
      if (badgeEl) {
        badgeEl.style.background = badgeEl.dataset.originalBg || 'rgba(245, 158, 11, 0.15)';
        badgeEl.style.color = badgeEl.dataset.originalColor || '#d97706';
      }
      if (subBadgeEl) subBadgeEl.style.color = 'var(--text-muted)';
    }
  });
}

function onCustomerSearchInput(val) {
  const clearBtn = document.getElementById('btn-clear-customer');
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';

  renderCustomerDropdown(val);

  // Jika input pas dengan nama pelanggan
  const exactMatch = customers.find(c => c.nama.toLowerCase() === val.trim().toLowerCase());
  applySelectedCustomer(exactMatch || null);
}

function renderCustomerDropdown(keyword) {
  const dropdown = document.getElementById('customer-dropdown-list');
  if (!dropdown) return;

  const search = (keyword || '').toLowerCase().trim();
  const filtered = customers.filter(c =>
    String(c.nama || '').toLowerCase().includes(search) ||
    (c.telepon && String(c.telepon).toLowerCase().includes(search)) ||
    (c.domisili && String(c.domisili).toLowerCase().includes(search))
  );

  currentCustomerDropdownList = filtered.slice(0, 10);
  activeCustomerDropdownIndex = currentCustomerDropdownList.length > 0 ? 0 : -1;

  if (currentCustomerDropdownList.length === 0) {
    dropdown.innerHTML = `
      <div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.85rem; text-align: center;">
        Pelanggan tidak ditemukan. Tekan Enter untuk lanjut transaksi non-member.
      </div>
    `;
    dropdown.style.display = 'block';
    return;
  }

  const isVoucher = (loyaltySettings.rewardMode === 'voucher');
  const curMonth = getCurrentMonthKey();

  let html = '';
  currentCustomerDropdownList.forEach((c, idx) => {
    let rightBadgeHtml = '';
    if (isVoucher) {
      const vStats = getCustomerMonthlyVoucherStats(c, curMonth);
      const vNominal = (loyaltySettings.voucherRpValue || 10000) * vStats.remaining;
      rightBadgeHtml = `
        <div style="text-align: right;">
          <span class="customer-item-badge" data-original-bg="rgba(245, 158, 11, 0.15)" data-original-color="#d97706" style="background: rgba(245, 158, 11, 0.15); color: #d97706; font-weight: 700; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 999px;">
            🎟️ ${vStats.remaining} Voucher
          </span>
          <div class="customer-item-subbadge" style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
            (Rp ${formatRupiah(vNominal)})
          </div>
        </div>
      `;
    } else {
      const rpValue = (c.poin || 0) * (loyaltySettings.rpPerPoint || 100);
      rightBadgeHtml = `
        <div style="text-align: right;">
          <span class="customer-item-badge" data-original-bg="rgba(16, 185, 129, 0.12)" data-original-color="#059669" style="background: rgba(16, 185, 129, 0.12); color: #059669; font-weight: 700; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 999px;">
            🪙 ${c.poin || 0} Poin
          </span>
          <div class="customer-item-subbadge" style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
            (Rp ${formatRupiah(rpValue)})
          </div>
        </div>
      `;
    }

    const isFirstActive = idx === 0;
    const initialBg = isFirstActive ? '#ea580c' : 'transparent';
    const initialColor = isFirstActive ? '#ffffff' : 'var(--text-main)';
    const initialMetaColor = isFirstActive ? 'rgba(255, 255, 255, 0.9)' : 'var(--text-muted)';

    html += `
      <div class="customer-dropdown-item" onclick="selectCustomerFromDropdown('${c.id}')" style="padding: 0.65rem 0.95rem; border-bottom: 1px solid var(--border-color); cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s; background-color: ${initialBg};" onmouseenter="activeCustomerDropdownIndex=${idx}; updateCustomerDropdownActiveState();">
        <div>
          <div class="customer-item-name" style="font-weight: 700; font-size: 0.92rem; color: ${initialColor};">${c.nama}</div>
          <div class="customer-item-meta" style="font-size: 0.75rem; color: ${initialMetaColor}; display: flex; gap: 0.6rem; align-items: center; margin-top: 2px;">
            <span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="phone" style="width:12px; height:12px;"></i> ${c.telepon || '-'}</span>
            <span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="map-pin" style="width:12px; height:12px;"></i> ${c.domisili || '-'}</span>
          </div>
        </div>
        ${rightBadgeHtml}
      </div>
    `;
  });

  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

function selectCustomerFromDropdown(customerId) {
  const c = customers.find(x => x.id === customerId);
  if (!c) return;

  const input = document.getElementById('customer-name-input');
  if (input) input.value = c.nama;

  const clearBtn = document.getElementById('btn-clear-customer');
  if (clearBtn) clearBtn.style.display = 'block';

  closeCustomerDropdown();
  applySelectedCustomer(c);

  // Arahkan kursor langsung ke kolom "uang diterima dari konsumen"
  setTimeout(() => {
    const cashInput = document.getElementById('cash-received');
    if (cashInput && cashInput.offsetParent !== null) {
      cashInput.focus();
      cashInput.select();
    }
  }, 100);
}

function applySelectedCustomer(customer) {
  const input = document.getElementById('customer-name-input');
  if (input) {
    if (customer) {
      input.style.borderColor = '#ea580c';
      input.style.backgroundColor = '#fff7ed';
      input.style.color = '#9a3412';
      input.style.fontWeight = '700';
    } else {
      input.style.borderColor = 'var(--border-color)';
      input.style.backgroundColor = 'var(--bg-card)';
      input.style.color = 'var(--text-main)';
      input.style.fontWeight = 'normal';
    }
  }

  const ptsInfo = document.getElementById('customer-points-info');
  const vchInfo = document.getElementById('customer-voucher-info');
  const isVoucher = (loyaltySettings.rewardMode === 'voucher');

  if (isVoucher) {
    if (ptsInfo) ptsInfo.style.display = 'none';
    if (vchInfo) {
      if (customer) {
        vchInfo.style.display = 'block';
        const curMonth = getCurrentMonthKey();
        const vStats = getCustomerMonthlyVoucherStats(customer, curMonth);
        const rpNominal = loyaltySettings.voucherRpValue || 10000;
        const totalRp = vStats.remaining * rpNominal;

        const balEl = document.getElementById('customer-voucher-balance');
        const rpEl = document.getElementById('customer-voucher-rp');
        const badgeEl = document.getElementById('customer-voucher-eligibility-badge');
        const actionRow = document.getElementById('customer-voucher-action-row');

        if (balEl) balEl.textContent = vStats.remaining;
        if (rpEl) rpEl.textContent = `Rp ${formatRupiah(totalRp)}`;
        if (badgeEl) {
          if (!vStats.eligible) {
            badgeEl.textContent = 'Tidak Berhak Voucher';
            badgeEl.style.background = '#f1f5f9';
            badgeEl.style.color = '#64748b';
            if (actionRow) actionRow.style.display = 'none';
          } else {
            badgeEl.textContent = `Kuota: ${vStats.used}/${vStats.quota} Digunakan`;
            badgeEl.style.background = '#fef3c7';
            badgeEl.style.color = '#b45309';
            if (actionRow) actionRow.style.display = 'flex';
          }
        }
      } else {
        vchInfo.style.display = 'none';
        const vInput = document.getElementById('redeem-voucher-count');
        if (vInput) vInput.value = '0';
      }
    }
  } else {
    if (vchInfo) vchInfo.style.display = 'none';
    if (ptsInfo) {
      if (customer) {
        ptsInfo.style.display = 'block';
        const currentPoints = customer.poin || 0;
        const rpPerPt = (loyaltySettings && loyaltySettings.rpPerPoint) ? loyaltySettings.rpPerPoint : 100;
        const totalValueRp = currentPoints * rpPerPt;

        document.getElementById('customer-points-balance').textContent = currentPoints;
        document.getElementById('customer-points-rp').textContent = `Rp ${formatRupiah(totalValueRp)}`;
      } else {
        ptsInfo.style.display = 'none';
        const rInput = document.getElementById('redeem-points-input');
        if (rInput) rInput.value = '';
      }
    }
  }

  calculateChange();
}

function clearSelectedCustomer() {
  const input = document.getElementById('customer-name-input');
  if (input) {
    input.value = '';
    input.style.borderColor = 'var(--border-color)';
    input.style.backgroundColor = 'var(--bg-card)';
    input.style.color = 'var(--text-main)';
    input.style.fontWeight = 'normal';
  }

  const clearBtn = document.getElementById('btn-clear-customer');
  if (clearBtn) clearBtn.style.display = 'none';

  const ptsInfo = document.getElementById('customer-points-info');
  if (ptsInfo) ptsInfo.style.display = 'none';

  const vchInfo = document.getElementById('customer-voucher-info');
  if (vchInfo) vchInfo.style.display = 'none';

  const redeemInput = document.getElementById('redeem-points-input');
  if (redeemInput) redeemInput.value = '';

  const vInput = document.getElementById('redeem-voucher-count');
  if (vInput) vInput.value = '0';

  closeCustomerDropdown();
  calculateChange();
}

// Helper Interaksi Voucher di Dialog Pembayaran
function stepVoucherRedeem(delta) {
  const input = document.getElementById('redeem-voucher-count');
  if (!input) return;
  const currentVal = parseInt(input.value) || 0;
  const newVal = Math.max(0, currentVal + delta);
  input.value = newVal;
  calculateChange();
}

function useMaxVouchersForPayment() {
  const customerName = document.getElementById('customer-name-input')?.value.trim();
  const customer = customers.find(c => c.nama === customerName);
  if (!customer) {
    alert("Pilih pelanggan terlebih dahulu!");
    return;
  }
  const vStats = getCustomerMonthlyVoucherStats(customer);
  if (vStats.remaining <= 0) {
    alert("Pelanggan ini tidak memiliki sisa voucher bulan ini.");
    return;
  }

  const rpPerVoucher = parseInt(loyaltySettings.voucherRpValue) || 10000;
  const vouchersNeeded = Math.ceil(globalTotal / rpPerVoucher);
  const vouchersToUse = Math.min(vStats.remaining, vouchersNeeded);

  const input = document.getElementById('redeem-voucher-count');
  if (input) input.value = vouchersToUse;

  calculateChange();

  const totalPotongan = vouchersToUse * rpPerVoucher;
  const sisaBayar = Math.max(0, globalTotal - totalPotongan);

  if (sisaBayar === 0) {
    const cashInput = document.getElementById('cash-received');
    if (cashInput) cashInput.value = '0';
    calculateChange();
  } else {
    const cashInput = document.getElementById('cash-received');
    if (cashInput) {
      cashInput.value = new Intl.NumberFormat('id-ID').format(sisaBayar);
      cashInput.focus();
    }
    calculateChange();
  }
}

function resetRedeemVouchers() {
  const input = document.getElementById('redeem-voucher-count');
  if (input) input.value = '0';
  calculateChange();
}

// Fitur Bayar Pakai Poin Seketika
function useMaxPointsForPayment() {
  const customerName = document.getElementById('customer-name-input')?.value.trim();
  const customer = customers.find(c => c.nama === customerName);
  if (!customer || !customer.poin || customer.poin <= 0) {
    alert("Pelanggan ini belum memiliki saldo poin.");
    return;
  }

  const rpPerPt = (loyaltySettings && loyaltySettings.rpPerPoint) ? loyaltySettings.rpPerPoint : 100;
  const pointsNeeded = Math.ceil(globalTotal / rpPerPt);
  const pointsToUse = Math.min(customer.poin, pointsNeeded);

  const redeemInput = document.getElementById('redeem-points-input');
  if (redeemInput) {
    redeemInput.value = pointsToUse;
  }

  calculateChange();

  const totalPotongan = pointsToUse * rpPerPt;
  const sisaBayar = Math.max(0, globalTotal - totalPotongan);

  if (sisaBayar === 0) {
    const cashInput = document.getElementById('cash-received');
    if (cashInput) cashInput.value = '0';
    calculateChange();
  } else {
    const cashInput = document.getElementById('cash-received');
    if (cashInput) {
      cashInput.value = new Intl.NumberFormat('id-ID').format(sisaBayar);
      cashInput.focus();
    }
    calculateChange();
  }
}

function resetRedeemPoints() {
  const redeemInput = document.getElementById('redeem-points-input');
  if (redeemInput) redeemInput.value = '';
  calculateChange();
}

function onCustomerSelectChange() {
  const name = document.getElementById('customer-name-input').value.trim();
  const customer = customers.find(c => c.nama === name);
  applySelectedCustomer(customer);
}

function saveLoyaltySettings() {
  const ptsPerRp = parseInt(document.getElementById('setting-points-per-rp').value) || 50000;
  const rpPerPt = parseInt(document.getElementById('setting-rp-per-point').value) || 1000;
  
  loyaltySettings.pointsPerRp = ptsPerRp;
  loyaltySettings.rpPerPoint = rpPerPt;
  localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
  saveLoyaltySettingsCloud();
  alert('Pengaturan Poin Pelanggan berhasil disimpan!');
}

// --- MANAJEMEN ANTREAN / JEDA KERANJANG ---
function saveHeldCarts() {
  localStorage.setItem('kasir_held_carts', JSON.stringify(heldCarts));
}

function holdCurrentCart() {
  if (cart.length === 0) {
    alert('Keranjang saat ini kosong, tidak ada yang perlu dijeda.');
    return;
  }
  
  const currentCustName = (document.getElementById('customer-name-input')?.value || '').trim();
  const defaultLabel = currentCustName ? `Antrean: ${currentCustName}` : `Antrean ${heldCarts.length + 1}`;
  const customerName = prompt('Masukkan nama pelanggan atau catatan untuk antrean ini (Opsional):', defaultLabel);
  if (customerName === null) return; // Batal
  
  const heldItem = {
    id: 'HOLD-' + Date.now().toString().slice(-6),
    name: customerName || defaultLabel,
    customerName: currentCustName,
    time: new Date().toISOString(),
    items: [...cart]
  };
  
  heldCarts.push(heldItem);
  saveHeldCarts();
  
  cart = [];
  renderCart();
  if (typeof clearSelectedCustomer === 'function') {
    clearSelectedCustomer();
  }
  updateHeldCartsUI();
  alert('Keranjang berhasil dijeda dan masuk ke daftar antrean.');
}

function updateHeldCartsUI() {
  const badge = document.getElementById('held-carts-badge');
  if (badge) {
    badge.textContent = heldCarts.length;
    badge.style.display = heldCarts.length > 0 ? 'flex' : 'none';
  }
}

// Tutup menu sidebar hamburger jika mengklik di luar area menu
document.addEventListener('click', function(event) {
  const navTabs = document.querySelector('.nav-tabs');
  const hamburgerBtn = document.querySelector('.hamburger-btn');
  if (navTabs && navTabs.classList.contains('sidebar-active')) {
    if (!navTabs.contains(event.target) && hamburgerBtn && !hamburgerBtn.contains(event.target)) {
      navTabs.classList.remove('sidebar-active');
    }
  }
});

function openHeldCartsModal() {
  const tbody = document.getElementById('held-carts-tbody');
  tbody.innerHTML = '';
  
  if (heldCarts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 2rem;">Tidak ada antrean keranjang.</td></tr>`;
  } else {
    heldCarts.forEach((h, index) => {
      const dateObj = new Date(h.time);
      const timeStr = dateObj.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      
      let totalItems = h.items.reduce((sum, i) => sum + i.qty, 0);
      let totalHarga = h.items.reduce((sum, i) => sum + (i.harga * i.qty), 0);
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="padding: 0.5rem; border-bottom: 1px solid var(--border-color);"><strong>${h.name}</strong><br><small style="color: var(--text-muted)">${timeStr}</small></td>
        <td style="padding: 0.5rem; border-bottom: 1px solid var(--border-color);">${totalItems} item</td>
        <td style="padding: 0.5rem; border-bottom: 1px solid var(--border-color);">Rp ${formatRupiah(totalHarga)}</td>
        <td style="padding: 0.5rem; border-bottom: 1px solid var(--border-color); text-align: right;">
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button class="btn btn-primary btn-sm" onclick="restoreHeldCart(${index})" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">Lanjutkan</button>
            <button class="btn btn-danger btn-sm" onclick="deleteHeldCart(${index})" style="padding: 0.25rem 0.5rem; display: flex; align-items: center; justify-content: center;">
              <svg viewBox="0 0 24 24" class="icon-sm" style="margin:0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
  
  document.getElementById('held-carts-modal').classList.add('active');
}

function closeHeldCartsModal() {
  document.getElementById('held-carts-modal').classList.remove('active');
}

function restoreHeldCart(index) {
  if (cart.length > 0) {
    if (!confirm('Keranjang saat ini tidak kosong. Menarik antrean akan MENGGANTI keranjang saat ini. Lanjutkan?')) {
      return;
    }
  }
  
  const h = heldCarts[index];
  cart = [...h.items];
  heldCarts.splice(index, 1);
  saveHeldCarts();
  
  // Pulihkan data pelanggan jika ada
  if (h.customerName) {
    const cust = customers.find(c => c.nama.trim().toLowerCase() === h.customerName.trim().toLowerCase());
    if (cust && typeof selectCustomerFromDropdown === 'function') {
      selectCustomerFromDropdown(cust.id);
    } else {
      const posCustInput = document.getElementById('customer-name-input');
      if (posCustInput) posCustInput.value = h.customerName;
    }
  } else if (typeof clearSelectedCustomer === 'function') {
    clearSelectedCustomer();
  }
  
  renderCart();
  updateHeldCartsUI();
  closeHeldCartsModal();
}

function deleteHeldCart(index) {
  if (confirm('Yakin ingin menghapus antrean keranjang ini permanen?')) {
    heldCarts.splice(index, 1);
    saveHeldCarts();
    openHeldCartsModal();
    updateHeldCartsUI();
  }
}

// Inisialisasi awal UI antrean saat memuat
document.addEventListener('DOMContentLoaded', () => {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
  setTimeout(() => {
    updateHeldCartsUI();
    loadWeeklyTrendInBackground();
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      try { lucide.createIcons(); } catch(e) {}
    }
  }, 1000);

  // Registrasi PWA Service Worker (Hanya untuk Web Browser, jangan di Desktop Electron)
  if ('serviceWorker' in navigator && (!window.desktopAPI || !window.desktopAPI.isDesktop)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('Toko Sahil PWA Service Worker terdaftar:', reg.scope);
        })
        .catch((err) => {
          console.warn('Gagal mendaftarkan Service Worker:', err);
        });
    });
  }

  // Auto re-render grafik tren & sesuaikan elemen mobile saat resize/rotasi layar
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const pane = document.getElementById('pane-analytics');
      if (pane && pane.classList.contains('active')) {
        render7DayChart();
      }
      if (typeof updateMobileCartBadge === 'function') {
        updateMobileCartBadge();
      }
      if (window.innerWidth > 768 && typeof closeMobileCheckout === 'function') {
        closeMobileCheckout();
      }
    }, 150);
  });
});

// ============================================================================
// MODUL MANAJEMEN SALES, PENERIMAAN NOTA, RETUR & REKAP TRANSAKSI
// ============================================================================

let currentActiveSalesSubTab = 'sales';

// 1. Sub-tab Switcher dalam Halaman Sales & Kulak
function switchSalesSubTab(subtabId) {
  currentActiveSalesSubTab = subtabId;
  const subtabs = ['sales', 'invoices', 'returns', 'kulak-manual', 'logs', 'expenses'];
  
  subtabs.forEach(tab => {
    const pane = document.getElementById(`subpane-${tab}`);
    const btn = document.getElementById(`btn-subtab-${tab}`);
    if (pane) {
      pane.style.display = (tab === subtabId) ? 'block' : 'none';
    }
    if (btn) {
      if (tab === subtabId) {
        btn.classList.add('active');
        btn.style.background = '';
        btn.style.color = '';
      } else {
        btn.classList.remove('active');
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  });

  // Render konten sesuai sub-tab yang dibuka
  if (subtabId === 'sales') {
    renderSalesTable();
  } else if (subtabId === 'invoices') {
    updateSalesDropdowns();
    renderSalesDeliveriesTable();
  } else if (subtabId === 'returns') {
    updateSalesDropdowns();
    renderSalesReturnsTable();
  } else if (subtabId === 'kulak-manual') {
    closeKulakForm();
    focusKulakSearch();
  } else if (subtabId === 'logs') {
    updateSalesDropdowns();
    onSalesRekapFilterChange();
    renderSalesRekapView();
  } else if (subtabId === 'expenses') {
    renderExpensesTable();
  }
}

// 2. Sinkronisasi Data Sales, Deliveries, dan Returns ke LocalStorage & Firebase Realtime Database
function saveSalesLocally() {
  localStorage.setItem('kasir_sales_list', JSON.stringify(salesList));
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('salesList')).set(salesList).then(() => {
        if (typeof updateSyncStatus === 'function') updateSyncStatus('online', 'Database Terhubung');
      }).catch(err => {
        console.warn('Gagal sync salesList ke Firebase:', err);
      });
    } catch (e) {
      console.warn('Exception sync salesList:', e);
    }
  }
}

function saveSalesDeliveriesLocally() {
  localStorage.setItem('kasir_sales_deliveries', JSON.stringify(salesDeliveries));
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('salesDeliveries')).set(salesDeliveries).then(() => {
        if (typeof updateSyncStatus === 'function') updateSyncStatus('online', 'Database Terhubung');
      }).catch(err => {
        console.warn('Gagal sync salesDeliveries ke Firebase:', err);
      });
    } catch (e) {
      console.warn('Exception sync salesDeliveries:', e);
    }
  }
}

function saveSalesReturnsLocally() {
  localStorage.setItem('kasir_sales_returns', JSON.stringify(salesReturns));
  if (firebaseDb && typeof getStorePath === 'function') {
    try {
      firebaseDb.ref(getStorePath('salesReturns')).set(salesReturns).then(() => {
        if (typeof updateSyncStatus === 'function') updateSyncStatus('online', 'Database Terhubung');
      }).catch(err => {
        console.warn('Gagal sync salesReturns ke Firebase:', err);
      });
    } catch (e) {
      console.warn('Exception sync salesReturns:', e);
    }
  }
}

// 3. Update Dropdown Sales di semua Form / Filter
function updateSalesDropdowns() {
  const deliverySelect = document.getElementById('delivery-sales-select');
  const returnSelect = document.getElementById('return-sales-select');
  const filterInvoiceSales = document.getElementById('filter-invoice-sales');
  const filterReturnSales = document.getElementById('filter-return-sales');
  const rekapSalesSelect = document.getElementById('sales-rekap-sales-target');

  // Simpan nilai terpilih sebelumnya
  const prevDelivery = deliverySelect ? deliverySelect.value : '';
  const prevReturn = returnSelect ? returnSelect.value : '';
  const prevFilterInv = filterInvoiceSales ? filterInvoiceSales.value : 'All';
  const prevFilterRet = filterReturnSales ? filterReturnSales.value : 'All';
  const prevRekap = rekapSalesSelect ? rekapSalesSelect.value : 'All';

  if (deliverySelect) {
    deliverySelect.innerHTML = '<option value="">-- Pilih Sales --</option>';
    salesList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.nama} (${s.perusahaan || 'Independen'})`;
      if (s.id === prevDelivery) opt.selected = true;
      deliverySelect.appendChild(opt);
    });
  }

  if (returnSelect) {
    returnSelect.innerHTML = '<option value="">-- Pilih Sales --</option>';
    salesList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.nama} (${s.perusahaan || 'Independen'})`;
      if (s.id === prevReturn) opt.selected = true;
      returnSelect.appendChild(opt);
    });
  }

  if (filterInvoiceSales) {
    filterInvoiceSales.innerHTML = '<option value="All">-- Semua Sales --</option>';
    salesList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.nama;
      if (s.id === prevFilterInv) opt.selected = true;
      filterInvoiceSales.appendChild(opt);
    });
  }

  if (filterReturnSales) {
    filterReturnSales.innerHTML = '<option value="All">-- Semua Sales --</option>';
    salesList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.nama;
      if (s.id === prevFilterRet) opt.selected = true;
      filterReturnSales.appendChild(opt);
    });
  }

  if (rekapSalesSelect) {
    rekapSalesSelect.innerHTML = '<option value="All">Semua Sales</option>';
    salesList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.nama;
      if (s.id === prevRekap) opt.selected = true;
      rekapSalesSelect.appendChild(opt);
    });
  }
}

// 4. Render Tabel Sales (Daftar Sales, Produk Ditangani, Status Stok & WA Share)
function renderSalesTable() {
  const tbody = document.getElementById('sales-table-body');
  if (!tbody) return;

  const searchInput = document.getElementById('sales-list-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  let filtered = salesList;
  if (query) {
    filtered = salesList.filter(s => 
      (s.nama && s.nama.toLowerCase().includes(query)) ||
      (s.perusahaan && s.perusahaan.toLowerCase().includes(query)) ||
      (s.hp && s.hp.toLowerCase().includes(query))
    );
  }

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          ${query ? 'Tidak ada data sales yang cocok dengan pencarian.' : 'Belum ada data sales terdaftar. Silakan klik tombol <strong>+ Input Sales Baru</strong> di atas.'}
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach((s, idx) => {
    const tr = document.createElement('tr');

    // Hitung produk yang ditangani & produk yang stoknya habis / menipis (<= 2)
    const assignedIds = Array.isArray(s.productIds) ? s.productIds : [];
    const assignedProds = products.filter(p => assignedIds.includes(p.id));
    const emptyProds = assignedProds.filter(p => (Number(p.stok) || 0) <= 2);

    let stockBadge = '';
    if (assignedProds.length === 0) {
      stockBadge = '<span style="font-size: 0.8rem; color: var(--text-muted);">Belum ada produk</span>';
    } else if (emptyProds.length > 0) {
      stockBadge = `<span style="background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 0.25rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.25rem;">⚠️ ${emptyProds.length} Habis/Menipis</span>`;
    } else {
      stockBadge = '<span style="background: rgba(16, 185, 129, 0.15); color: #059669; padding: 0.25rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600;">✓ Stok Aman</span>';
    }

    // Tampilkan 3 nama produk pertama
    let prodPreviewHtml = '';
    if (assignedProds.length > 0) {
      const top3 = assignedProds.slice(0, 3).map(p => {
        const isLow = (Number(p.stok) || 0) <= 2;
        return `<span style="display: inline-block; background: var(--bg-surface-elevated); border: 1px solid var(--border-color); padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.78rem; margin: 0.1rem; ${isLow ? 'color: #dc2626; font-weight: 600;' : ''}">${p.nama} (${p.stok})</span>`;
      }).join(' ');
      const moreCount = assignedProds.length - 3;
      prodPreviewHtml = `<div>${top3} ${moreCount > 0 ? `<span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">+${moreCount} lainnya</span>` : ''}</div>`;
    } else {
      prodPreviewHtml = '<span style="color: var(--text-muted); font-size: 0.82rem;">-</span>';
    }

    tr.innerHTML = `
      <td style="text-align: center; font-weight: 600; color: var(--text-muted);">${idx + 1}</td>
      <td>
        <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">${s.nama}</div>
        ${s.catatan ? `<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem;">📌 ${s.catatan}</div>` : ''}
      </td>
      <td>${s.perusahaan ? `<span style="font-weight: 600; color: var(--color-primary);">${s.perusahaan}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
      <td>
        <div style="font-family: monospace; font-size: 0.9rem;">${s.hp || '-'}</div>
      </td>
      <td style="max-width: 250px;">${prodPreviewHtml}</td>
      <td>${stockBadge}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap;">
          <button type="button" class="btn btn-sm btn-success" onclick="openSalesWaModal('${s.id}')" title="Kirim & Custom Pesan WA Kulak ke Sales" style="padding: 0.35rem 0.65rem; font-size: 0.8rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.35rem; background: #25d366; border-color: #25d366; color: #fff; border-radius: 7px;">
            <svg viewBox="0 0 24 24" style="width: 15px; height: 15px; fill: white; flex-shrink: 0;"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.2.662.591 1.221.774 1.394.86.173.086.275.072.376-.044.101-.116.433-.506.549-.68.116-.173.231-.145.39-.086s1.011.477 1.184.564.289.13.332.203c.043.071.043.419-.101.824z"/></svg>
            <span>WA Kulak</span>
          </button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="editSales('${s.id}')" title="Edit Sales" style="padding: 0.35rem 0.55rem; font-size: 0.8rem; border-radius: 7px; display: inline-flex; align-items: center;">
            <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
          </button>
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteSales('${s.id}')" title="Hapus Sales" style="padding: 0.35rem 0.55rem; font-size: 0.8rem; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center;">
            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

// 5. Modal Tambah / Edit Sales & Pemilihan Produk
function openAddSalesModal() {
  const modal = document.getElementById('sales-form-modal');
  if (!modal) return;

  const formTitle = document.getElementById('sales-form-title');
  if (formTitle) {
    formTitle.innerHTML = '<span style="display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: rgba(37, 99, 235, 0.1); border-radius: 8px; color: #2563eb;"><i data-lucide="user-plus" style="width: 18px; height: 18px;"></i></span><span>Input Sales Baru</span>';
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
  }

  const editId = document.getElementById('sales-edit-id');
  if (editId) editId.value = '';

  const nameInput = document.getElementById('sales-input-name');
  if (nameInput) nameInput.value = '';

  const compInput = document.getElementById('sales-input-company');
  if (compInput) compInput.value = '';

  const phoneInput = document.getElementById('sales-input-phone');
  if (phoneInput) phoneInput.value = '';

  const notesInput = document.getElementById('sales-input-notes');
  if (notesInput) notesInput.value = '';

  const searchInput = document.getElementById('sales-product-search');
  if (searchInput) searchInput.value = '';

  renderSalesProductSelection([]);

  modal.classList.add('active');
  modal.style.display = 'flex';
  setTimeout(() => {
    if (nameInput) nameInput.focus();
  }, 100);
}

function editSales(salesId) {
  const s = salesList.find(x => x.id === salesId);
  if (!s) return;

  const modal = document.getElementById('sales-form-modal');
  if (!modal) return;

  const formTitle = document.getElementById('sales-form-title');
  if (formTitle) {
    formTitle.innerHTML = '<span style="display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: rgba(37, 99, 235, 0.1); border-radius: 8px; color: #2563eb;"><i data-lucide="user-cog" style="width: 18px; height: 18px;"></i></span><span>Edit Data Rekanan Sales</span>';
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
  }

  const editId = document.getElementById('sales-edit-id');
  if (editId) editId.value = s.id;

  const nameInput = document.getElementById('sales-input-name');
  if (nameInput) nameInput.value = s.nama || '';

  const compInput = document.getElementById('sales-input-company');
  if (compInput) compInput.value = s.perusahaan || '';

  const phoneInput = document.getElementById('sales-input-phone');
  if (phoneInput) phoneInput.value = s.hp || '';

  const notesInput = document.getElementById('sales-input-notes');
  if (notesInput) notesInput.value = s.catatan || '';

  const searchInput = document.getElementById('sales-product-search');
  if (searchInput) searchInput.value = '';

  renderSalesProductSelection(s.productIds || []);

  modal.classList.add('active');
  modal.style.display = 'flex';
  setTimeout(() => {
    if (nameInput) nameInput.focus();
  }, 100);
}

function closeSalesModal() {
  const modal = document.getElementById('sales-form-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function renderSalesProductSelection(selectedIds = []) {
  const container = document.getElementById('sales-products-checkbox-container');
  if (!container) return;

  container.innerHTML = '';
  if (products.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 1rem; text-align: center;">Belum ada produk di database toko.</div>';
    updateSelectedSalesCount();
    return;
  }

  // Urutkan produk berdasarkan nama
  const sorted = [...products].sort((a, b) => (a.nama || '').localeCompare(b.nama || ''));
  sorted.forEach(p => {
    const isChecked = selectedIds.includes(p.id);
    const label = document.createElement('label');
    label.className = 'sales-prod-item-row';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.justifyContent = 'space-between';
    label.style.gap = '0.75rem';
    label.style.cursor = 'pointer';
    label.style.padding = '0.45rem 0.65rem';
    label.style.borderRadius = '8px';
    label.style.background = isChecked ? 'rgba(37, 99, 235, 0.06)' : 'var(--bg-surface)';
    label.style.border = isChecked ? '1px solid rgba(37, 99, 235, 0.25)' : '1px solid var(--border-color)';
    label.style.transition = 'all 0.15s ease';

    const stockNum = Number(p.stok) || 0;
    const isLow = stockNum <= 2;

    label.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.6rem; flex: 1; min-width: 0;">
        <input type="checkbox" class="chk-sales-prod" value="${p.id}" ${isChecked ? 'checked' : ''} onchange="toggleSalesProdRowStyle(this)" style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--color-primary); flex-shrink: 0;">
        <div style="display: flex; flex-direction: column; min-width: 0;">
          <span style="font-weight: 600; font-size: 0.88rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.nama}</span>
          <span style="font-size: 0.72rem; color: var(--text-muted);">${p.kategori || 'Umum'}</span>
        </div>
      </div>
      <div style="flex-shrink: 0; text-align: right;">
        <span style="font-size: 0.75rem; font-weight: 700; padding: 0.15rem 0.45rem; border-radius: 4px; font-family: monospace; ${isLow ? 'background: rgba(239, 68, 68, 0.12); color: #dc2626;' : 'background: rgba(16, 185, 129, 0.12); color: #059669;'}">
          Stok: ${p.stok}
        </span>
      </div>
    `;
    container.appendChild(label);
  });

  updateSelectedSalesCount();
}

function toggleSalesProdRowStyle(cb) {
  const row = cb.closest('.sales-prod-item-row');
  if (row) {
    row.style.background = cb.checked ? 'rgba(37, 99, 235, 0.06)' : 'var(--bg-surface)';
    row.style.border = cb.checked ? '1px solid rgba(37, 99, 235, 0.25)' : '1px solid var(--border-color)';
  }
  updateSelectedSalesCount();
}

function filterSalesProductSelection() {
  const searchInput = document.getElementById('sales-product-search');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const rows = document.querySelectorAll('#sales-products-checkbox-container .sales-prod-item-row');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? 'flex' : 'none';
  });
}

function selectAllSalesProducts(shouldSelect) {
  const checkboxes = document.querySelectorAll('#sales-products-checkbox-container .chk-sales-prod');
  checkboxes.forEach(cb => {
    // Hanya pilih checkbox yang barisnya sedang terlihat jika ada filter pencarian
    const row = cb.closest('.sales-prod-item-row');
    if (row && row.style.display !== 'none') {
      cb.checked = shouldSelect;
      row.style.background = shouldSelect ? 'rgba(37, 99, 235, 0.06)' : 'var(--bg-surface)';
      row.style.border = shouldSelect ? '1px solid rgba(37, 99, 235, 0.25)' : '1px solid var(--border-color)';
    }
  });
  updateSelectedSalesCount();
}

function updateSelectedSalesCount() {
  const checked = document.querySelectorAll('#sales-products-checkbox-container .chk-sales-prod:checked');
  const countSpan = document.getElementById('sales-selected-products-count');
  if (countSpan) {
    countSpan.textContent = `${checked.length} produk dipilih`;
  }
}

function saveSales(e) {
  if (e) e.preventDefault();

  const editId = document.getElementById('sales-edit-id').value;
  const nama = document.getElementById('sales-input-name').value.trim();
  const perusahaan = document.getElementById('sales-input-company').value.trim();
  const hp = document.getElementById('sales-input-phone').value.trim();
  const catatan = document.getElementById('sales-input-notes').value.trim();

  if (!nama) {
    alert('Nama sales wajib diisi!');
    return;
  }
  if (!hp) {
    alert('No. WhatsApp / HP wajib diisi untuk keperluan order!');
    return;
  }

  // Kumpulkan product IDs yang dicentang
  const selectedProductIds = [];
  document.querySelectorAll('#sales-products-checkbox-container .chk-sales-prod:checked').forEach(cb => {
    selectedProductIds.push(cb.value);
  });

  if (editId) {
    // Mode Edit
    const s = salesList.find(x => x.id === editId);
    if (s) {
      s.nama = nama;
      s.perusahaan = perusahaan;
      s.hp = hp;
      s.catatan = catatan;
      s.productIds = selectedProductIds;
      s.updatedAt = new Date().toISOString();
    }
  } else {
    // Mode Tambah Baru
    const newSales = {
      id: 'SLS-' + Date.now(),
      nama: nama,
      perusahaan: perusahaan,
      hp: hp,
      catatan: catatan,
      productIds: selectedProductIds,
      createdAt: new Date().toISOString()
    };
    salesList.push(newSales);
  }

  saveSalesLocally();
  updateSalesDropdowns();
  renderSalesTable();
  closeSalesModal();
  alert('✅ Data sales berhasil disimpan!');
}

function deleteSales(salesId) {
  const s = salesList.find(x => x.id === salesId);
  if (!s) return;

  if (!confirm(`Yakin ingin menghapus data sales "${s.nama}"? Data riwayat nota sebelumnya akan tetap tersimpan.`)) {
    return;
  }

  salesList = salesList.filter(x => x.id !== salesId);
  saveSalesLocally();
  updateSalesDropdowns();
  renderSalesTable();
  alert(`✅ Sales "${s.nama}" berhasil dihapus.`);
}

function getSalesWaDefaultMessage(salesId) {
  const s = salesList.find(x => x.id === salesId);
  if (!s) return '';
  const assignedIds = Array.isArray(s.productIds) ? s.productIds : [];
  const assignedProds = products.filter(p => assignedIds.includes(p.id));
  const emptyOrLow = assignedProds.filter(p => (Number(p.stok) || 0) <= 2);
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : 'Toko Kami';
  const todayStr = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  let text = `Halo Mas/Mbak *${s.nama}* (${s.perusahaan || 'Sales'}),\n`;
  text += `Ini dari *${storeName}*.\n`;
  text += `Berikut adalah daftar barang pesanan/kulak yang stoknya sudah *KOSONG / MENIPIS* per ${todayStr}:\n\n`;

  if (emptyOrLow.length > 0) {
    emptyOrLow.forEach((p, idx) => {
      const isZero = (Number(p.stok) || 0) <= 0;
      text += `${idx + 1}. *${p.nama}* -> Sisa Stok: *${p.stok} pcs* ${isZero ? '⚠️ (HABIS)' : ''}\n`;
    });
  } else {
    text += `(Saat ini stok masih aman, namun mohon konfirmasi jadwal kunjungan berikutnya ya Mas/Mbak).\n`;
  }

  text += `\nMohon bantuannya untuk dijadwalkan pengiriman nota berikutnya ya. Terima kasih! 🙏`;
  return text;
}

function openSalesWaModal(salesId) {
  const s = salesList.find(x => x.id === salesId);
  if (!s) return;

  if (!s.hp) {
    alert(`Sales "${s.nama}" belum memiliki nomor WhatsApp/HP. Silakan klik tombol Edit untuk memasukkan nomor.`);
    return;
  }

  const assignedIds = Array.isArray(s.productIds) ? s.productIds : [];
  if (assignedIds.length === 0) {
    alert(`Sales ${s.nama} belum didaftarkan produk apa pun. Silakan edit data sales terlebih dahulu dan centang produk-produk yang disuplai olehnya.`);
    return;
  }

  document.getElementById('sales-wa-id').value = s.id;
  document.getElementById('sales-wa-name').textContent = s.nama;
  document.getElementById('sales-wa-phone').textContent = s.hp || '-';
  document.getElementById('sales-wa-company').textContent = s.perusahaan ? `Perusahaan: ${s.perusahaan}` : 'Sales Supplier';

  const defaultMsg = getSalesWaDefaultMessage(s.id);
  const textarea = document.getElementById('sales-wa-message-text');
  if (textarea) textarea.value = defaultMsg;

  const modal = document.getElementById('sales-wa-modal');
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('active');
  }
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

function closeSalesWaModal() {
  const modal = document.getElementById('sales-wa-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function resetSalesWaDefaultMessage() {
  const salesId = document.getElementById('sales-wa-id')?.value;
  if (!salesId) return;
  const defaultMsg = getSalesWaDefaultMessage(salesId);
  const textarea = document.getElementById('sales-wa-message-text');
  if (textarea) textarea.value = defaultMsg;
}

function sendCustomSalesWaMessage() {
  const salesId = document.getElementById('sales-wa-id')?.value;
  const s = salesList.find(x => x.id === salesId);
  if (!s) return;

  const msg = document.getElementById('sales-wa-message-text')?.value.trim();
  if (!msg) {
    alert("Pesan WhatsApp tidak boleh kosong!");
    return;
  }

  let cleanPhone = (s.hp || '').replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.substring(1);
  }

  const waUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
  closeSalesWaModal();
}

// 6. Share Barang Kosong / Menipis ke WhatsApp Sales Terkait (fallback direct)
function shareEmptyStockToSalesWhatsApp(salesId) {
  openSalesWaModal(salesId);
}

// Preview Gambar Nota Datang
function previewDeliveryImage(url) {
  const container = document.getElementById('delivery-image-preview-container');
  const img = document.getElementById('delivery-image-preview');
  if (!container || !img) return;

  if (url && url.trim().startsWith('http')) {
    img.src = url.trim();
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
    img.src = '';
  }
}

// 7. Modul Penerimaan Nota Sales (Input Pembelian Kirim Barang)
function openAddSalesDeliveryModal() {
  updateSalesDropdowns();
  const delvIdInput = document.getElementById('delivery-id');
  if (delvIdInput) delvIdInput.value = '';

  const titleEl = document.getElementById('sales-delivery-modal-title');
  if (titleEl) titleEl.textContent = 'Input Nota Pembelian & Kirim Barang dari Sales';

  document.getElementById('delivery-sales-select').value = '';
  document.getElementById('delivery-invoice-no').value = 'NOTA-' + Date.now().toString().slice(-6);
  
  // Set default tanggal hari ini
  const today = getLocalISODate();
  document.getElementById('delivery-date').value = today;
  document.getElementById('delivery-discount').value = 0;
  document.getElementById('delivery-bonus-info').value = '';

  // Reset input gambar nota
  const imgInput = document.getElementById('delivery-image-url');
  if (imgInput) imgInput.value = '';
  previewDeliveryImage('');

  // Reset status tempo / lunas
  const payStatusSelect = document.getElementById('delivery-pay-status');
  if (payStatusSelect) payStatusSelect.value = 'Lunas';
  const paidInput = document.getElementById('delivery-paid-amount');
  if (paidInput) paidInput.value = 0;

  // Set default jatuh tempo (misal 14 hari ke depan)
  const dueGroup = document.getElementById('delivery-tempo-due-group');
  const paidGroup = document.getElementById('delivery-tempo-paid-group');
  const balanceInfo = document.getElementById('delivery-tempo-balance-info');
  if (dueGroup) dueGroup.style.display = 'none';
  if (paidGroup) paidGroup.style.display = 'none';
  if (balanceInfo) balanceInfo.style.display = 'none';

  const defaultDue = new Date();
  defaultDue.setDate(defaultDue.getDate() + 14);
  const dueDateInput = document.getElementById('delivery-due-date');
  if (dueDateInput) dueDateInput.value = getLocalISODate(defaultDue);

  // Kosongkan baris barang dan buat 1 baris pertama
  const tbody = document.getElementById('delivery-items-tbody');
  if (tbody) tbody.innerHTML = '';
  addDeliveryItemRow();

  // Reset checklist pemotongan retur
  renderDeliveryReturnCheckboxes('');
  calculateDeliveryGrandTotal();

  const modal = document.getElementById('sales-delivery-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function editSalesDelivery(deliveryId) {
  const d = salesDeliveries.find(x => x.id === deliveryId);
  if (!d) {
    alert('Catatan nota tidak ditemukan!');
    return;
  }

  updateSalesDropdowns();
  const delvIdInput = document.getElementById('delivery-id');
  if (delvIdInput) delvIdInput.value = d.id;

  const titleEl = document.getElementById('sales-delivery-modal-title');
  if (titleEl) titleEl.textContent = `Edit Nota Penerimaan Barang: ${d.noNota}`;

  document.getElementById('delivery-sales-select').value = d.salesId || '';
  document.getElementById('delivery-invoice-no').value = d.noNota || '';
  document.getElementById('delivery-date').value = d.tanggal || '';
  document.getElementById('delivery-discount').value = d.diskon || 0;
  document.getElementById('delivery-bonus-info').value = d.bonus || '';

  const imgInput = document.getElementById('delivery-image-url');
  if (imgInput) imgInput.value = d.imageUrl || '';
  previewDeliveryImage(d.imageUrl || '');

  const isTempo = (d.statusBayar === 'Tempo');
  const payStatusSelect = document.getElementById('delivery-pay-status');
  if (payStatusSelect) payStatusSelect.value = isTempo ? 'Tempo' : 'Lunas';

  const dueGroup = document.getElementById('delivery-tempo-due-group');
  const paidGroup = document.getElementById('delivery-tempo-paid-group');
  const balanceInfo = document.getElementById('delivery-tempo-balance-info');
  if (dueGroup) dueGroup.style.display = isTempo ? 'block' : 'none';
  if (paidGroup) paidGroup.style.display = isTempo ? 'block' : 'none';
  if (balanceInfo) balanceInfo.style.display = isTempo ? 'block' : 'none';

  const dueDateInput = document.getElementById('delivery-due-date');
  if (dueDateInput) dueDateInput.value = d.jatuhTempo || '';

  const paidInput = document.getElementById('delivery-paid-amount');
  if (paidInput) paidInput.value = d.totalDibayar || 0;

  const fundSelect = document.getElementById('delivery-fund-source');
  if (fundSelect) fundSelect.value = d.sumberDana || 'saldo_penjualan';

  // Render checklist retur
  renderDeliveryReturnCheckboxes(d.salesId || '');
  if (d.deductedReturnIds && d.deductedReturnIds.length > 0) {
    document.querySelectorAll('#delivery-return-checkbox-list .chk-delivery-return-deduct').forEach(cb => {
      if (d.deductedReturnIds.includes(cb.value)) {
        cb.checked = true;
      }
    });
  }

  // Isi baris barang yang datang
  const tbody = document.getElementById('delivery-items-tbody');
  if (tbody) tbody.innerHTML = '';

  if (d.items && d.items.length > 0) {
    d.items.forEach(item => {
      addDeliveryItemRow(item);
    });
  } else {
    addDeliveryItemRow();
  }

  calculateDeliveryGrandTotal();

  const modal = document.getElementById('sales-delivery-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function onDeliveryPayStatusChanged() {
  const status = document.getElementById('delivery-pay-status').value;
  const isTempo = status === 'Tempo';
  const dueGroup = document.getElementById('delivery-tempo-due-group');
  const paidGroup = document.getElementById('delivery-tempo-paid-group');
  const balanceInfo = document.getElementById('delivery-tempo-balance-info');

  if (dueGroup) dueGroup.style.display = isTempo ? 'block' : 'none';
  if (paidGroup) paidGroup.style.display = isTempo ? 'block' : 'none';
  if (balanceInfo) balanceInfo.style.display = isTempo ? 'block' : 'none';

  calculateDeliveryGrandTotal();
}

function closeSalesDeliveryModal() {
  const modal = document.getElementById('sales-delivery-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function onDeliverySalesChanged() {
  // Ketika sales diubah, perbarui daftar opsi barang di baris nota
  const salesId = document.getElementById('delivery-sales-select').value;
  const s = salesList.find(x => x.id === salesId);
  const rows = document.querySelectorAll('#delivery-items-tbody tr');

  rows.forEach(tr => {
    const select = tr.querySelector('.delivery-item-prod-select');
    if (select) {
      const curVal = select.value;
      populateDeliveryProductSelect(select, s ? s.productIds : null, curVal);
    }
  });

  // Muat retur yang siap dipotong dari sales ini
  renderDeliveryReturnCheckboxes(salesId);
  calculateDeliveryGrandTotal();
}

function renderDeliveryReturnCheckboxes(salesId) {
  const container = document.getElementById('delivery-return-checkbox-list');
  const badge = document.getElementById('delivery-pending-returns-badge');
  if (!container) return;

  if (!salesId) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem; font-style: italic;">Pilih sales terlebih dahulu untuk melihat catatan retur yang belum dipotong.</div>';
    if (badge) badge.textContent = '0 Retur Siap Dipotong';
    return;
  }

  // Cari retur dari sales ini yang belum diselesaikan (status: Potong Tagihan Nota Berikutnya atau Menunggu Barang Pengganti)
  const availableReturns = salesReturns.filter(r => r.salesId === salesId && (r.status === 'Potong Tagihan Nota Berikutnya' || r.status === 'Menunggu Barang Pengganti'));

  if (availableReturns.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.8rem; padding: 0.35rem 0;">Tidak ada retur aktif untuk dipotong dari sales ini.</div>';
    if (badge) badge.textContent = '0 Retur Siap Dipotong';
    return;
  }

  if (badge) badge.textContent = `${availableReturns.length} Retur Siap Dipotong`;

  container.innerHTML = '';
  availableReturns.forEach(r => {
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.gap = '0.5rem';
    row.style.padding = '0.4rem 0.6rem';
    row.style.background = 'var(--bg-surface)';
    row.style.border = '1px solid var(--border-color)';
    row.style.borderRadius = '6px';
    row.style.cursor = 'pointer';

    const itemVal = (r.qty || 0) * (r.hargaBeli || 0);

    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
        <input type="checkbox" class="chk-delivery-return-deduct" value="${r.id}" data-amount="${itemVal}" onchange="calculateDeliveryGrandTotal()" style="transform: scale(1.15);">
        <div>
          <strong style="color: var(--text-main); font-size: 0.88rem;">${r.productName}</strong>
          <span style="color: #dc2626; font-weight: 700;"> (${r.qty} pcs)</span>
          <div style="font-size: 0.75rem; color: var(--text-muted);">${r.tanggal || ''} • Alasan: ${r.alasan}</div>
        </div>
      </div>
      <div style="font-weight: 700; color: #dc2626; font-family: monospace; white-space: nowrap; font-size: 0.9rem;">
        - ${formatRupiah(itemVal)}
      </div>
    `;
    container.appendChild(row);
  });
}

function populateDeliveryProductSelect(selectEl, filterProductIds = null, selectedId = '') {
  selectEl.innerHTML = '<option value="">-- Pilih Produk --</option>';

  // Hanya tampilkan produk yang didaftarkan ke sales tersebut jika ada filter
  if (filterProductIds && filterProductIds.length > 0) {
    const salesProducts = products.filter(p => filterProductIds.includes(p.id));

    if (salesProducts.length > 0) {
      salesProducts.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.nama} (Stok: ${p.stok})`;
        if (p.id === selectedId) opt.selected = true;
        selectEl.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = '-- Belum ada produk didaftarkan ke sales ini --';
      selectEl.appendChild(opt);
    }
  } else {
    // Jika belum pilih sales atau sales belum punya daftar produk khusus, tampilkan semua produk
    products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.nama} (Stok: ${p.stok})`;
      if (p.id === selectedId) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }
}

function addDeliveryItemRow(defaultData = null) {
  const tbody = document.getElementById('delivery-items-tbody');
  if (!tbody) return;

  const tr = document.createElement('tr');
  tr.style.borderBottom = '1px solid var(--border-color)';

  tr.innerHTML = `
    <td style="padding: 0.4rem;">
      <select class="delivery-item-prod-select" required onchange="onDeliveryItemSelectChanged(this)" style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.85rem; background: var(--bg-surface); color: var(--text-main);">
        <option value="">-- Pilih Produk --</option>
      </select>
    </td>
    <td style="padding: 0.4rem;">
      <input type="number" class="delivery-item-qty" required min="1" value="${defaultData ? defaultData.qty : 1}" oninput="calculateDeliveryRowSubtotal(this)" style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.85rem;">
    </td>
    <td style="padding: 0.4rem;">
      <input type="number" class="delivery-item-price-buy" required min="0" value="${defaultData ? defaultData.hargaBeli : 0}" oninput="calculateDeliveryRowSubtotal(this)" style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.85rem;">
    </td>
    <td style="padding: 0.4rem;">
      <input type="number" class="delivery-item-price-sell" required min="0" value="${defaultData ? defaultData.hargaJual : 0}" style="width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.85rem;">
    </td>
    <td style="padding: 0.4rem;">
      <input type="date" class="delivery-item-expiry" value="${defaultData ? defaultData.expired : ''}" style="width: 100%; padding: 0.35rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.82rem;">
    </td>
    <td style="padding: 0.4rem; text-align: right; font-weight: 700; font-family: monospace; font-size: 0.9rem;" class="delivery-item-subtotal">
      Rp 0
    </td>
    <td style="padding: 0.4rem; text-align: center;">
      <button type="button" class="btn btn-sm btn-danger" onclick="removeDeliveryItemRow(this)" style="padding: 0.25rem 0.45rem; font-size: 0.75rem;">✕</button>
    </td>
  `;

  tbody.appendChild(tr);

  // Isi opsi produk
  const select = tr.querySelector('.delivery-item-prod-select');
  const salesId = document.getElementById('delivery-sales-select').value;
  const s = salesList.find(x => x.id === salesId);
  populateDeliveryProductSelect(select, s ? s.productIds : null, defaultData ? defaultData.productId : '');

  if (defaultData) {
    calculateDeliveryRowSubtotal(select);
  }
}

function removeDeliveryItemRow(btn) {
  const tr = btn.closest('tr');
  if (tr) {
    tr.remove();
    calculateDeliveryGrandTotal();
  }
}

function onDeliveryItemSelectChanged(selectEl) {
  const prodId = selectEl.value;
  const tr = selectEl.closest('tr');
  if (!tr) return;

  const prod = products.find(p => p.id === prodId);
  if (prod) {
    const buyInput = tr.querySelector('.delivery-item-price-buy');
    const sellInput = tr.querySelector('.delivery-item-price-sell');
    const expiryInput = tr.querySelector('.delivery-item-expiry');

    if (buyInput) buyInput.value = prod.harga_beli || 0;
    if (sellInput) sellInput.value = prod.harga_jual || prod.harga || 0;
    if (expiryInput && prod.tanggal_kadaluarsa) expiryInput.value = prod.tanggal_kadaluarsa;

    calculateDeliveryRowSubtotal(selectEl);
  }
}

function calculateDeliveryRowSubtotal(el) {
  const tr = el.closest('tr');
  if (!tr) return;

  const qty = Number(tr.querySelector('.delivery-item-qty').value) || 0;
  const price = Number(tr.querySelector('.delivery-item-price-buy').value) || 0;
  const subtotal = qty * price;

  const subtotalCell = tr.querySelector('.delivery-item-subtotal');
  if (subtotalCell) {
    subtotalCell.textContent = formatRupiah(subtotal);
  }

  calculateDeliveryGrandTotal();
}

function calculateDeliveryGrandTotal() {
  let totalKotor = 0;
  document.querySelectorAll('#delivery-items-tbody tr').forEach(tr => {
    const qty = Number(tr.querySelector('.delivery-item-qty').value) || 0;
    const price = Number(tr.querySelector('.delivery-item-price-buy').value) || 0;
    totalKotor += (qty * price);
  });

  const diskon = Number(document.getElementById('delivery-discount').value) || 0;

  // Hitung total nilai retur yang dipilih untuk dipotong
  let totalReturPotongan = 0;
  document.querySelectorAll('#delivery-return-checkbox-list .chk-delivery-return-deduct:checked').forEach(cb => {
    totalReturPotongan += (Number(cb.dataset.amount) || 0);
  });

  const displayReturDeduct = document.getElementById('delivery-return-discount-display');
  if (displayReturDeduct) {
    displayReturDeduct.value = formatRupiah(totalReturPotongan);
  }

  const totalBersih = Math.max(0, totalKotor - diskon - totalReturPotongan);

  const displayEl = document.getElementById('delivery-grand-total-display');
  if (displayEl) {
    displayEl.textContent = formatRupiah(totalBersih);
  }

  // Hitung sisa hutang jika status tempo
  const payStatus = document.getElementById('delivery-pay-status') ? document.getElementById('delivery-pay-status').value : 'Lunas';
  if (payStatus === 'Tempo') {
    const paid = Number(document.getElementById('delivery-paid-amount').value) || 0;
    const remaining = Math.max(0, totalBersih - paid);
    const remDisplay = document.getElementById('delivery-remaining-balance-display');
    if (remDisplay) remDisplay.textContent = formatRupiah(remaining);
  }
}

function saveSalesDelivery(e) {
  if (e) e.preventDefault();

  const salesId = document.getElementById('delivery-sales-select').value;
  const noNota = document.getElementById('delivery-invoice-no').value.trim();
  const tanggal = document.getElementById('delivery-date').value;
  const diskon = Number(document.getElementById('delivery-discount').value) || 0;
  const bonusInfo = document.getElementById('delivery-bonus-info').value.trim();
  const imageUrl = document.getElementById('delivery-image-url') ? document.getElementById('delivery-image-url').value.trim() : '';

  // Status Pembayaran & Tempo
  const payStatus = document.getElementById('delivery-pay-status').value;
  const dueDate = document.getElementById('delivery-due-date').value;
  let paidAmount = Number(document.getElementById('delivery-paid-amount').value) || 0;

  if (!salesId) {
    alert('Pilih sales terlebih dahulu!');
    return;
  }
  if (!noNota) {
    alert('No. Nota / Faktur wajib diisi!');
    return;
  }
  if (!tanggal) {
    alert('Tanggal datang barang wajib diisi!');
    return;
  }
  if (payStatus === 'Tempo' && !dueDate) {
    alert('Pilih tanggal jatuh tempo tagihan!');
    return;
  }

  const s = salesList.find(x => x.id === salesId);
  const salesName = s ? s.nama : 'Sales Tidak Diketahui';

  // Kumpulkan item barang
  const items = [];
  const rows = document.querySelectorAll('#delivery-items-tbody tr');

  if (rows.length === 0) {
    alert('Tambahkan setidaknya 1 baris barang yang datang!');
    return;
  }

  let totalTagihan = 0;
  let hasValidItem = false;

  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const prodId = tr.querySelector('.delivery-item-prod-select').value;
    const qty = Number(tr.querySelector('.delivery-item-qty').value) || 0;
    const hargaBeli = Number(tr.querySelector('.delivery-item-price-buy').value) || 0;
    const hargaJual = Number(tr.querySelector('.delivery-item-price-sell').value) || 0;
    const expired = tr.querySelector('.delivery-item-expiry').value;

    if (!prodId) continue;
    if (qty <= 0) {
      alert(`Jumlah barang pada baris #${i + 1} harus lebih dari 0!`);
      return;
    }

    const prod = products.find(p => p.id === prodId);
    const subtotal = qty * hargaBeli;
    totalTagihan += subtotal;
    hasValidItem = true;

    items.push({
      productId: prodId,
      nama: prod ? prod.nama : 'Produk',
      qty: qty,
      hargaBeli: hargaBeli,
      hargaJual: hargaJual,
      expired: expired,
      subtotal: subtotal
    });
  }

  if (!hasValidItem || items.length === 0) {
    alert('Pilih produk yang datang dengan benar!');
    return;
  }

  // Kumpulkan retur yang dipotongkan langsung
  const deductedReturnIds = [];
  let totalReturPotongan = 0;
  document.querySelectorAll('#delivery-return-checkbox-list .chk-delivery-return-deduct:checked').forEach(cb => {
    deductedReturnIds.push(cb.value);
    totalReturPotongan += (Number(cb.dataset.amount) || 0);
  });

  const grandTotal = Math.max(0, totalTagihan - diskon - totalReturPotongan);

  // Jika bayar Lunas langsung, paidAmount disamakan dengan grandTotal
  if (payStatus === 'Lunas') {
    paidAmount = grandTotal;
  }
  const sisaTagihan = Math.max(0, grandTotal - paidAmount);
  const isFullyPaid = sisaTagihan <= 0;

  // Cek apakah mode Edit atau Baru
  const editingDeliveryId = document.getElementById('delivery-id')?.value;
  const existingDelivery = editingDeliveryId ? salesDeliveries.find(x => x.id === editingDeliveryId) : null;

  // 1. Update Stok, Harga Beli, Harga Jual, dan Tanggal Kadaluarsa pada masing-masing produk
  let updatedAnyProduct = false;

  // Jika sedang edit, kembalikan stok lama terlebih dahulu
  if (existingDelivery && existingDelivery.items) {
    existingDelivery.items.forEach(oldItem => {
      const p = products.find(prod => prod.id === oldItem.productId);
      if (p) {
        p.stok = Math.max(0, (Number(p.stok) || 0) - (Number(oldItem.qty) || 0));
        updatedAnyProduct = true;
      }
    });
  }

  // Tambahkan stok dari items baru
  items.forEach(item => {
    const prod = products.find(p => p.id === item.productId);
    if (prod) {
      prod.stok = (Number(prod.stok) || 0) + item.qty;
      prod.harga_beli = item.hargaBeli;
      prod.harga_jual = item.hargaJual;
      prod.harga = item.hargaJual; // fallback kompatibilitas
      if (item.expired) {
        prod.tanggal_kadaluarsa = item.expired;
      }
      updatedAnyProduct = true;
      if (firebaseDb && typeof saveProductCloud === 'function') {
        saveProductCloud(prod);
      }
    }
  });

  if (updatedAnyProduct) {
    saveProductsLocally();
    if (typeof renderProductsTable === 'function') renderProductsTable();
    if (typeof renderPosProducts === 'function') renderPosProducts();
  }

  // 2. Tandai data retur yang dipotong menjadi status "Sudah Diganti Fisik"
  if (deductedReturnIds.length > 0) {
    salesReturns.forEach(r => {
      if (deductedReturnIds.includes(r.id)) {
        r.status = 'Sudah Diganti Fisik';
        r.catatan = (r.catatan ? r.catatan + ' ' : '') + `[Dipotong di Nota: ${noNota}]`;
      }
    });
    saveSalesReturnsLocally();
    renderSalesReturnsTable();
  }

  // 3. Simpan Rekaman Penerimaan Nota Sales
  const deliveryRecord = {
    id: existingDelivery ? existingDelivery.id : ('DELV-' + Date.now()),
    noNota: noNota,
    salesId: salesId,
    salesName: salesName,
    tanggal: tanggal,
    items: items,
    totalTagihan: totalTagihan,
    diskon: diskon,
    returDeduction: totalReturPotongan,
    deductedReturnIds: deductedReturnIds,
    grandTotal: grandTotal,
    bonus: bonusInfo,
    imageUrl: imageUrl,
    statusBayar: isFullyPaid ? 'Lunas' : 'Tempo',
    jatuhTempo: payStatus === 'Tempo' ? dueDate : null,
    totalDibayar: paidAmount,
    sisaTagihan: sisaTagihan,
    sumberDana: (document.getElementById('delivery-fund-source')?.value) || 'saldo_penjualan',
    riwayatBayar: existingDelivery ? (existingDelivery.riwayatBayar || []) : (paidAmount > 0 ? [
      {
        tanggal: tanggal,
        nominal: paidAmount,
        sumberDana: (document.getElementById('delivery-fund-source')?.value) || 'saldo_penjualan',
        catatan: (payStatus === 'Lunas' ? 'Pembayaran lunas langsung' : 'DP / Uang muka saat barang datang') + 
                 ((document.getElementById('delivery-fund-source')?.value === 'dana_lain') ? ' [Dana Luar]' : ' [Potong Saldo Kasir]')
      }
    ] : []),
    createdAt: existingDelivery ? existingDelivery.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingDelivery) {
    const idx = salesDeliveries.findIndex(x => x.id === existingDelivery.id);
    if (idx !== -1) {
      salesDeliveries[idx] = deliveryRecord;
    }
  } else {
    salesDeliveries.unshift(deliveryRecord);
  }
  saveSalesDeliveriesLocally();

  renderSalesDeliveriesTable();
  renderSalesTable();
  closeSalesDeliveryModal();

  const statusMsg = isFullyPaid ? 'Status: LUNAS' : `Status: TEMPO (Sisa Hutang: ${formatRupiah(sisaTagihan)}, Jatuh Tempo: ${dueDate})`;
  const returMsg = totalReturPotongan > 0 ? `\n(Potongan retur langsung diterapkan: ${formatRupiah(totalReturPotongan)})` : '';
  alert(`✅ Nota ${noNota} dari ${salesName} berhasil disimpan!\n${statusMsg}${returMsg}\nStok ${items.length} jenis barang telah otomatis bertambah ke database.`);
}

function renderSalesDeliveriesTable() {
  const tbody = document.getElementById('sales-deliveries-body');
  if (!tbody) return;

  const salesFilter = document.getElementById('filter-invoice-sales') ? document.getElementById('filter-invoice-sales').value : 'All';
  const statusFilter = document.getElementById('filter-invoice-status') ? document.getElementById('filter-invoice-status').value : 'All';
  const monthFilter = document.getElementById('filter-invoice-month') ? document.getElementById('filter-invoice-month').value : '';

  let filtered = salesDeliveries;
  if (salesFilter && salesFilter !== 'All') {
    filtered = filtered.filter(d => d.salesId === salesFilter);
  }
  if (statusFilter && statusFilter !== 'All') {
    filtered = filtered.filter(d => {
      const isLunas = (d.statusBayar === 'Lunas') || ((d.sisaTagihan || 0) <= 0);
      return statusFilter === 'Lunas' ? isLunas : !isLunas;
    });
  }
  if (monthFilter) {
    filtered = filtered.filter(d => d.tanggal && d.tanggal.startsWith(monthFilter));
  }

  tbody.innerHTML = '';
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          Belum ada rekaman penerimaan nota pembelian sales untuk filter ini.
        </td>
      </tr>
    `;
    return;
  }

  const todayStr = getLocalISODate();

  filtered.forEach(d => {
    const tr = document.createElement('tr');

    // Ringkasan item barang
    const itemSummary = (d.items || []).map(i => {
      const expStr = i.expired ? ` (Exp: ${i.expired})` : '';
      return `<div>• <strong>${i.nama}</strong>: ${i.qty} pcs @${formatRupiah(i.hargaBeli)}${expStr}</div>`;
    }).join('');

    // Status Pembayaran & Tempo
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    const isLunas = sisa <= 0;

    let paymentBadge = '';
    if (isLunas) {
      paymentBadge = `<span style="background: rgba(16, 185, 129, 0.15); color: #059669; padding: 0.25rem 0.55rem; border-radius: 999px; font-weight: 700; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.25rem;">✅ Lunas</span>`;
    } else {
      const isOverdue = d.jatuhTempo && (d.jatuhTempo < todayStr);
      paymentBadge = `
        <div style="display: flex; flex-direction: column; gap: 0.2rem;">
          <span style="background: rgba(245, 158, 11, 0.15); color: #b45309; padding: 0.2rem 0.5rem; border-radius: 6px; font-weight: 700; font-size: 0.78rem;">
            ⏳ Tempo (Sisa: ${formatRupiah(sisa)})
          </span>
          ${d.jatuhTempo ? `
            <span style="font-size: 0.75rem; font-weight: 600; ${isOverdue ? 'color: #dc2626;' : 'color: var(--text-muted);'}">
              ${isOverdue ? '⚠️ Lewat Tempo: ' : 'Jatuh Tempo: '}${d.jatuhTempo}
            </span>
          ` : ''}
        </div>
      `;
    }

    // Diskon & Potongan Retur Badge
    let discountHtml = '';
    if (d.diskon) {
      discountHtml += `<div>Diskon: <span style="color: #dc2626;">-${formatRupiah(d.diskon)}</span></div>`;
    }
    if (d.returDeduction) {
      discountHtml += `<div>Retur: <span style="color: #dc2626; font-weight: 700;">-${formatRupiah(d.returDeduction)}</span></div>`;
    }
    if (!discountHtml) discountHtml = '<span style="color: var(--text-muted);">-</span>';

    // Foto Nota Thumbnail / Button
    let imageCellHtml = '<span style="color: var(--text-muted);">-</span>';
    if (d.imageUrl) {
      imageCellHtml = `
        <button type="button" class="btn btn-sm btn-secondary" onclick="viewReceiptImage('${escapeJsQuotes(d.imageUrl)}', 'Nota ${escapeJsQuotes(d.noNota)}')" title="Lihat Foto Nota" style="padding: 0.25rem 0.5rem; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 0.25rem;">
          <span>📸</span>
          <span>Foto</span>
        </button>
      `;
    }

    tr.innerHTML = `
      <td>${d.tanggal || '-'}</td>
      <td style="font-weight: 700; color: var(--color-primary); font-family: monospace;">${d.noNota || '-'}</td>
      <td><strong>${d.salesName || '-'}</strong></td>
      <td style="font-size: 0.85rem; max-width: 230px;">${itemSummary}</td>
      <td style="font-family: monospace;">${formatRupiah(d.totalTagihan || 0)}</td>
      <td style="font-size: 0.82rem; font-family: monospace;">${discountHtml}</td>
      <td style="font-family: monospace; font-weight: 800; color: #059669;">${formatRupiah(d.grandTotal || 0)}</td>
      <td>${paymentBadge}</td>
      <td style="font-size: 0.85rem;">${d.bonus ? `<span style="background: rgba(16, 185, 129, 0.12); color: #059669; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">🎁 ${d.bonus}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
      <td style="text-align: center;">${imageCellHtml}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.35rem; justify-content: center; align-items: center;">
          <button type="button" class="btn btn-sm btn-secondary" onclick="printSingleSalesDeliveryReceipt('${d.id}')" title="Cetak Bukti Nota Penerimaan" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="editSalesDelivery('${d.id}')" title="Edit Nota Penerimaan Barang" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center; color: var(--color-primary); background: rgba(234,88,12,0.1); border-color: rgba(234,88,12,0.25);">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          ${!isLunas ? `
            <button type="button" class="btn btn-sm btn-primary" onclick="openSalesPayModal('${d.id}')" title="Bayar / Lunasi Tagihan" style="padding: 0.25rem 0.55rem; font-size: 0.78rem; font-weight: 700; background: #2563eb; color: #fff;">
              💵 Bayar
            </button>
          ` : ''}
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteSalesDelivery('${d.id}')" title="Hapus Nota" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// 7b. Modal Pembayaran / Pelunasan Tagihan Nota Sales
let currentPayingDelivery = null;

function openSalesPayModal(deliveryId) {
  const d = salesDeliveries.find(x => x.id === deliveryId);
  if (!d) return;

  currentPayingDelivery = d;
  const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
  const paid = (d.totalDibayar !== undefined) ? d.totalDibayar : (d.grandTotal - sisa);

  document.getElementById('pay-delivery-id').value = d.id;
  document.getElementById('pay-nota-display').textContent = d.noNota;
  document.getElementById('pay-sales-display').textContent = d.salesName;
  document.getElementById('pay-grandtotal-display').textContent = formatRupiah(d.grandTotal);
  document.getElementById('pay-already-paid-display').textContent = formatRupiah(paid);
  document.getElementById('pay-remaining-display').textContent = formatRupiah(sisa);

  document.getElementById('pay-amount-input').value = sisa;
  document.getElementById('pay-amount-input').max = sisa;
  document.getElementById('pay-date-input').value = getLocalISODate();
  document.getElementById('pay-notes-input').value = `Pelunasan nota ke ${d.salesName}`;

  document.getElementById('sales-pay-modal').style.display = 'flex';
}

function setPayAmountFull() {
  if (!currentPayingDelivery) return;
  const sisa = (currentPayingDelivery.sisaTagihan !== undefined) ? currentPayingDelivery.sisaTagihan : currentPayingDelivery.grandTotal;
  document.getElementById('pay-amount-input').value = sisa;
}

function closeSalesPayModal() {
  document.getElementById('sales-pay-modal').style.display = 'none';
  currentPayingDelivery = null;
}

function saveSalesPayment(e) {
  if (e) e.preventDefault();

  const deliveryId = document.getElementById('pay-delivery-id').value;
  const nominal = Number(document.getElementById('pay-amount-input').value) || 0;
  const tanggal = document.getElementById('pay-date-input').value;
  const catatan = document.getElementById('pay-notes-input').value.trim();

  if (nominal <= 0) {
    alert('Nominal pembayaran harus lebih dari 0!');
    return;
  }
  if (!tanggal) {
    alert('Tanggal pembayaran wajib diisi!');
    return;
  }

  const d = salesDeliveries.find(x => x.id === deliveryId);
  if (!d) return;

  const currentSisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : d.grandTotal;
  const currentPaid = (d.totalDibayar !== undefined) ? d.totalDibayar : 0;

  const newPaid = currentPaid + nominal;
  const newSisa = Math.max(0, currentSisa - nominal);

  d.totalDibayar = newPaid;
  d.sisaTagihan = newSisa;
  d.statusBayar = (newSisa <= 0) ? 'Lunas' : 'Tempo';

  const sumberDana = document.getElementById('pay-source-input')?.value || 'saldo_penjualan';
  const sumberDanaLabel = (sumberDana === 'dana_lain') ? ' [Dana Luar]' : ' [Potong Saldo Kasir]';

  if (!Array.isArray(d.riwayatBayar)) {
    d.riwayatBayar = [];
  }
  d.riwayatBayar.push({
    tanggal: tanggal,
    nominal: nominal,
    sumberDana: sumberDana,
    catatan: (catatan ? catatan : 'Pelunasan tagihan nota') + sumberDanaLabel
  });

  saveSalesDeliveriesLocally();
  renderSalesDeliveriesTable();
  if (typeof renderSalesRekapView === 'function') renderSalesRekapView();
  closeSalesPayModal();

  if (newSisa <= 0) {
    alert(`✅ Pembayaran sebesar ${formatRupiah(nominal)} berhasil disimpan!\nStatus Nota ${d.noNota} kini SUDAH LUNAS.`);
  } else {
    alert(`✅ Pembayaran dicatat sebesar ${formatRupiah(nominal)}!\nSisa hutang nota ${d.noNota}: ${formatRupiah(newSisa)}.`);
  }
}


function resetInvoiceFilters() {
  if (document.getElementById('filter-invoice-sales')) document.getElementById('filter-invoice-sales').value = 'All';
  if (document.getElementById('filter-invoice-month')) document.getElementById('filter-invoice-month').value = '';
  renderSalesDeliveriesTable();
}

function deleteSalesDelivery(deliveryId) {
  const d = salesDeliveries.find(x => x.id === deliveryId);
  if (!d) return;

  if (!confirm(`Yakin ingin menghapus catatan nota "${d.noNota}" dari ${d.salesName}?\n(Perhatian: Penghapusan catatan ini tidak mengurangi stok barang yang sudah masuk).`)) {
    return;
  }

  salesDeliveries = salesDeliveries.filter(x => x.id !== deliveryId);
  saveSalesDeliveriesLocally();
  renderSalesDeliveriesTable();
  alert(`✅ Catatan nota ${d.noNota} berhasil dihapus.`);
}

// Preview Gambar Nota / Bukti Retur
function previewReturnImage(url) {
  const container = document.getElementById('return-image-preview-container');
  const img = document.getElementById('return-image-preview');
  if (!container || !img) return;

  if (url && url.trim().startsWith('http')) {
    img.src = url.trim();
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
    img.src = '';
  }
}

// Viewer Popup untuk foto nota / retur
function viewReceiptImage(url, title = 'Foto Nota') {
  if (!url) return;
  // Buka tab baru atau tampilkan lightbox
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { margin: 0; background: #0f172a; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; font-family: sans-serif; color: #fff; padding: 1rem; box-sizing: border-box; }
          img { max-width: 95vw; max-height: 85vh; object-fit: contain; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          .header { margin-bottom: 1rem; font-weight: 700; font-size: 1.1rem; }
          .btn { background: #2563eb; color: #fff; padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; font-size: 0.9rem; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="header">📄 ${title}</div>
        <img src="${url}" alt="${title}">
        <a href="${url}" target="_blank" class="btn">Buka Gambar Asli</a>
      </body>
      </html>
    `);
  } else {
    window.open(url, '_blank');
  }
}

// 8. Modul Retur Produk Bermasalah / Kadaluarsa ke Sales
function openAddSalesReturnModal() {
  updateSalesDropdowns();
  const retIdInput = document.getElementById('return-id');
  if (retIdInput) retIdInput.value = '';

  const titleEl = document.getElementById('sales-return-modal-title');
  if (titleEl) titleEl.textContent = 'Form Retur Produk Bermasalah ke Sales';

  document.getElementById('return-sales-select').value = '';
  document.getElementById('return-product-select').innerHTML = '<option value="">-- Pilih Sales Terlebih Dahulu --</option>';
  document.getElementById('return-current-stock-info').textContent = 'Stok saat ini di toko: -';
  const priceInfo = document.getElementById('return-price-buy-info');
  if (priceInfo) priceInfo.textContent = 'Harga Beli: -';

  document.getElementById('return-qty').value = '';
  
  const today = getLocalISODate();
  document.getElementById('return-date').value = today;
  document.getElementById('return-reason').value = 'Kadaluarsa / Expired';
  document.getElementById('return-status').value = 'Potong Tagihan Nota Berikutnya';
  document.getElementById('return-notes').value = '';

  const imgInput = document.getElementById('return-image-url');
  if (imgInput) imgInput.value = '';
  previewReturnImage('');

  calculateReturnEstimatedValue();

  const modal = document.getElementById('sales-return-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function editSalesReturn(returnId) {
  const r = salesReturns.find(x => x.id === returnId);
  if (!r) {
    alert('Catatan retur tidak ditemukan!');
    return;
  }

  updateSalesDropdowns();
  const retIdInput = document.getElementById('return-id');
  if (retIdInput) retIdInput.value = r.id;

  const titleEl = document.getElementById('sales-return-modal-title');
  if (titleEl) titleEl.textContent = `Edit Data Retur Produk: ${r.productName}`;

  document.getElementById('return-sales-select').value = r.salesId || '';
  
  // Isi opsi produk
  const prodSelect = document.getElementById('return-product-select');
  if (prodSelect) {
    prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
    const s = salesList.find(x => x.id === r.salesId);
    if (s && s.productIds && s.productIds.length > 0) {
      const sProds = products.filter(p => s.productIds.includes(p.id));
      sProds.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.nama} (Stok: ${p.stok})`;
        if (p.id === r.productId) opt.selected = true;
        prodSelect.appendChild(opt);
      });
    } else {
      products.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.nama} (Stok: ${p.stok})`;
        if (p.id === r.productId) opt.selected = true;
        prodSelect.appendChild(opt);
      });
    }
  }

  const prod = products.find(p => p.id === r.productId);
  document.getElementById('return-current-stock-info').textContent = `Stok saat ini di toko: ${prod ? prod.stok : 0} pcs`;
  const priceInfo = document.getElementById('return-price-buy-info');
  if (priceInfo) priceInfo.textContent = `Harga Beli: Rp ${formatRupiah(r.hargaBeli || (prod ? prod.harga_beli : 0) || 0)}`;

  document.getElementById('return-qty').value = r.qty || 1;
  document.getElementById('return-date').value = r.tanggal || '';
  document.getElementById('return-reason').value = r.alasan || 'Kadaluarsa / Expired';
  document.getElementById('return-status').value = r.status || 'Potong Tagihan Nota Berikutnya';
  document.getElementById('return-notes').value = r.catatan || '';

  const imgInput = document.getElementById('return-image-url');
  if (imgInput) imgInput.value = r.imageUrl || '';
  previewReturnImage(r.imageUrl || '');

  calculateReturnEstimatedValue();

  const modal = document.getElementById('sales-return-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeSalesReturnModal() {
  const modal = document.getElementById('sales-return-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function onReturnSalesChanged() {
  const salesId = document.getElementById('return-sales-select').value;
  const prodSelect = document.getElementById('return-product-select');
  if (!prodSelect) return;

  prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
  const s = salesList.find(x => x.id === salesId);

  if (s && s.productIds && s.productIds.length > 0) {
    const sProds = products.filter(p => s.productIds.includes(p.id));

    if (sProds.length > 0) {
      sProds.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.nama} (Stok: ${p.stok})`;
        prodSelect.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = '-- Belum ada produk didaftarkan ke sales ini --';
      prodSelect.appendChild(opt);
    }
  } else {
    products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.nama} (Stok: ${p.stok})`;
      prodSelect.appendChild(opt);
    });
  }

  onReturnProductChanged();
}

function onReturnProductChanged() {
  const prodId = document.getElementById('return-product-select').value;
  const infoSpan = document.getElementById('return-current-stock-info');
  const priceInfo = document.getElementById('return-price-buy-info');

  const prod = products.find(p => p.id === prodId);
  if (prod) {
    if (infoSpan) {
      infoSpan.textContent = `Stok saat ini di toko: ${prod.stok} pcs`;
      infoSpan.style.color = (Number(prod.stok) || 0) <= 0 ? '#dc2626' : 'var(--text-muted)';
    }
    if (priceInfo) {
      priceInfo.textContent = `Harga Beli: ${formatRupiah(prod.harga_beli || 0)}`;
    }
  } else {
    if (infoSpan) {
      infoSpan.textContent = 'Stok saat ini di toko: -';
      infoSpan.style.color = 'var(--text-muted)';
    }
    if (priceInfo) {
      priceInfo.textContent = 'Harga Beli: -';
    }
  }

  calculateReturnEstimatedValue();
}

function calculateReturnEstimatedValue() {
  const prodId = document.getElementById('return-product-select') ? document.getElementById('return-product-select').value : '';
  const qty = Number(document.getElementById('return-qty') ? document.getElementById('return-qty').value : 0) || 0;
  const display = document.getElementById('return-total-value-display');
  if (!display) return;

  const prod = products.find(p => p.id === prodId);
  const hargaBeli = prod ? (prod.harga_beli || 0) : 0;
  const total = qty * hargaBeli;
  display.textContent = formatRupiah(total);
}

function saveSalesReturn(e) {
  if (e) e.preventDefault();

  const salesId = document.getElementById('return-sales-select').value;
  const prodId = document.getElementById('return-product-select').value;
  const qty = Number(document.getElementById('return-qty').value) || 0;
  const tanggal = document.getElementById('return-date').value;
  const reason = document.getElementById('return-reason').value;
  const status = document.getElementById('return-status').value;
  const notes = document.getElementById('return-notes').value.trim();
  const imageUrl = document.getElementById('return-image-url') ? document.getElementById('return-image-url').value.trim() : '';

  if (!salesId) {
    alert('Pilih sales tujuan retur!');
    return;
  }
  if (!prodId) {
    alert('Pilih produk yang diretur!');
    return;
  }
  if (qty <= 0) {
    alert('Jumlah retur harus lebih dari 0!');
    return;
  }
  if (!tanggal) {
    alert('Tanggal retur wajib diisi!');
    return;
  }

  const prod = products.find(p => p.id === prodId);
  if (!prod) {
    alert('Produk tidak ditemukan!');
    return;
  }

  const s = salesList.find(x => x.id === salesId);
  const salesName = s ? s.nama : 'Sales Terkait';

  // Cek apakah mode Edit atau Baru
  const editingReturnId = document.getElementById('return-id')?.value;
  const existingReturn = editingReturnId ? salesReturns.find(x => x.id === editingReturnId) : null;

  // Jika sedang edit retur, kembalikan stok lama produk asal terlebih dahulu
  if (existingReturn) {
    const oldProd = products.find(p => p.id === existingReturn.productId);
    if (oldProd) {
      oldProd.stok = (Number(oldProd.stok) || 0) + (Number(existingReturn.qty) || 0);
    }
  }

  // Validasi stok di toko
  const currentStok = Number(prod.stok) || 0;
  if (qty > currentStok) {
    if (!confirm(`⚠️ Perhatian: Jumlah retur (${qty} pcs) melebihi stok yang ada di toko saat ini (${currentStok} pcs).\nStok akan menjadi 0. Lanjutkan?`)) {
      // Jika batal dan tadi dalam mode edit, kembalikan kembali stok yang dipulihkan
      if (existingReturn) {
        const oldProd = products.find(p => p.id === existingReturn.productId);
        if (oldProd) oldProd.stok = Math.max(0, (Number(oldProd.stok) || 0) - (Number(existingReturn.qty) || 0));
      }
      return;
    }
  }

  // 1. Kurangi stok produk secara otomatis di database
  const newStok = Math.max(0, currentStok - qty);
  prod.stok = newStok;

  if (firebaseDb && typeof saveProductCloud === 'function') {
    saveProductCloud(prod);
    if (existingReturn && existingReturn.productId !== prod.id) {
      const oldProd = products.find(p => p.id === existingReturn.productId);
      if (oldProd) saveProductCloud(oldProd);
    }
  }
  saveProductsLocally();
  if (typeof renderProductsTable === 'function') renderProductsTable();
  if (typeof renderPosProducts === 'function') renderPosProducts();

  // 2. Simpan Rekam Jejak Retur ke Database
  const returnRecord = {
    id: existingReturn ? existingReturn.id : ('RET-' + Date.now()),
    salesId: salesId,
    salesName: salesName,
    productId: prodId,
    productName: prod.nama,
    qty: qty,
    hargaBeli: prod.harga_beli || 0,
    totalNilai: qty * (prod.harga_beli || 0),
    tanggal: tanggal,
    alasan: reason,
    status: status,
    catatan: notes,
    imageUrl: imageUrl,
    createdAt: existingReturn ? existingReturn.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingReturn) {
    const idx = salesReturns.findIndex(x => x.id === existingReturn.id);
    if (idx !== -1) {
      salesReturns[idx] = returnRecord;
    }
  } else {
    salesReturns.unshift(returnRecord);
  }
  saveSalesReturnsLocally();

  renderSalesReturnsTable();
  renderSalesTable();
  closeSalesReturnModal();

  let statusText = status;
  if (status === 'Uang Dikembalikan') {
    statusText = `Tukar Uang Tunai (${formatRupiah(returnRecord.totalNilai)})`;
  } else if (status === 'Potong Tagihan Nota Berikutnya') {
    statusText = `Siap Dipotongkan ke Nota Pembelian Berikutnya`;
  }

  alert(`✅ Retur ${qty} pcs "${prod.nama}" ke Sales ${salesName} berhasil disimpan!\nStatus: ${statusText}\nStok toko otomatis disesuaikan menjadi ${newStok} pcs.`);
}

function renderSalesReturnsTable() {
  const tbody = document.getElementById('sales-returns-body');
  if (!tbody) return;

  const salesFilter = document.getElementById('filter-return-sales') ? document.getElementById('filter-return-sales').value : 'All';
  const monthFilter = document.getElementById('filter-return-month') ? document.getElementById('filter-return-month').value : '';

  let filtered = salesReturns;
  if (salesFilter && salesFilter !== 'All') {
    filtered = filtered.filter(r => r.salesId === salesFilter);
  }
  if (monthFilter) {
    filtered = filtered.filter(r => r.tanggal && r.tanggal.startsWith(monthFilter));
  }

  tbody.innerHTML = '';
  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          Belum ada catatan barang retur ke sales untuk filter ini.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach(r => {
    const tr = document.createElement('tr');

    // Badge status penggantian
    let statusBadge = '';
    if (r.status === 'Sudah Diganti Fisik') {
      statusBadge = `<span style="background: rgba(16, 185, 129, 0.15); color: #059669; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">✓ Diganti Fisik / Dipotong</span>`;
    } else if (r.status === 'Uang Dikembalikan') {
      statusBadge = `<span style="background: rgba(16, 185, 129, 0.15); color: #059669; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">💵 Uang Tunai Selesai</span>`;
    } else if (r.status === 'Potong Tagihan Nota Berikutnya') {
      statusBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #b45309; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">✂️ Siap Potong Nota</span>`;
    } else {
      statusBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #d97706; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">⏳ ${r.status}</span>`;
    }

    // Foto Bukti Retur Thumbnail / Button
    let imageCellHtml = '<span style="color: var(--text-muted);">-</span>';
    if (r.imageUrl) {
      imageCellHtml = `
        <button type="button" class="btn btn-sm btn-secondary" onclick="viewReceiptImage('${escapeJsQuotes(r.imageUrl)}', 'Bukti Retur ${escapeJsQuotes(r.productName)}')" title="Lihat Foto Bukti Retur" style="padding: 0.25rem 0.5rem; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 0.25rem;">
          <span>📸</span>
          <span>Foto</span>
        </button>
      `;
    }

    const itemVal = (r.qty || 0) * (r.hargaBeli || 0);

    tr.innerHTML = `
      <td>${r.tanggal || '-'}</td>
      <td><strong>${r.salesName || '-'}</strong></td>
      <td>
        <div style="font-weight: 600; color: var(--text-main);">${r.productName || '-'}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace;">@${formatRupiah(r.hargaBeli || 0)} = ${formatRupiah(itemVal)}</div>
      </td>
      <td style="font-weight: 800; color: #dc2626; font-family: monospace;">${r.qty} pcs</td>
      <td><span style="background: rgba(239, 68, 68, 0.1); color: #dc2626; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600;">${r.alasan}</span></td>
      <td>${statusBadge}</td>
      <td style="font-size: 0.85rem; color: var(--text-muted);">${r.catatan || '-'}</td>
      <td style="text-align: center;">${imageCellHtml}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.35rem; justify-content: center; align-items: center;">
          <button type="button" class="btn btn-sm btn-secondary" onclick="printSingleSalesReturnReceipt('${r.id}')" title="Cetak Surat Retur Barang" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="editSalesReturn('${r.id}')" title="Edit Data Retur Produk" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center; color: var(--color-danger, #ef4444); background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.25);">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteSalesReturn('${r.id}')" title="Hapus Data Retur" style="padding: 0.25rem 0.45rem; display: inline-flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function resetReturnFilters() {
  if (document.getElementById('filter-return-sales')) document.getElementById('filter-return-sales').value = 'All';
  if (document.getElementById('filter-return-month')) document.getElementById('filter-return-month').value = '';
  renderSalesReturnsTable();
}

function deleteSalesReturn(returnId) {
  const r = salesReturns.find(x => x.id === returnId);
  if (!r) return;

  if (!confirm(`Yakin ingin menghapus riwayat retur "${r.productName}" (${r.qty} pcs)?\n(Perhatian: Penghapusan catatan ini tidak mengembalikan stok produk yang telah dikurangi).`)) {
    return;
  }

  salesReturns = salesReturns.filter(x => x.id !== returnId);
  saveSalesReturnsLocally();
  renderSalesReturnsTable();
  alert(`✅ Catatan retur berhasil dihapus.`);
}

// 9. Modul Rekap Transaksi Harian / Bulanan Sales
function onSalesRekapFilterChange() {
  const filterType = document.getElementById('sales-rekap-type').value;
  const dateInput = document.getElementById('sales-rekap-date');
  const monthInput = document.getElementById('sales-rekap-month');

  const today = getLocalISODate();
  const thisMonth = today.slice(0, 7);

  if (filterType === 'hari') {
    dateInput.style.display = 'inline-block';
    monthInput.style.display = 'none';
    if (!dateInput.value) dateInput.value = today;
  } else {
    dateInput.style.display = 'none';
    monthInput.style.display = 'inline-block';
    if (!monthInput.value) monthInput.value = thisMonth;
  }

  renderSalesRekapView();
}

function renderSalesRekapView() {
  const tbody = document.getElementById('sales-rekap-body');
  if (!tbody) return;

  const filterType = document.getElementById('sales-rekap-type').value;
  const selectedDate = document.getElementById('sales-rekap-date').value;
  const selectedMonth = document.getElementById('sales-rekap-month').value;
  const selectedSales = document.getElementById('sales-rekap-sales-target').value;

  // 1. Filter Deliveries
  let deliveries = salesDeliveries.filter(d => {
    if (selectedSales !== 'All' && d.salesId !== selectedSales) return false;
    if (filterType === 'hari') {
      return d.tanggal === selectedDate;
    } else {
      return d.tanggal && d.tanggal.startsWith(selectedMonth);
    }
  });

  // 2. Filter Returns
  let returns = salesReturns.filter(r => {
    if (selectedSales !== 'All' && r.salesId !== selectedSales) return false;
    if (filterType === 'hari') {
      return r.tanggal === selectedDate;
    } else {
      return r.tanggal && r.tanggal.startsWith(selectedMonth);
    }
  });

  // Kalkulasi Ringkasan Stat Cards
  let totalBeliAmount = 0;
  let totalBeliCount = deliveries.length;
  let totalBonusCount = 0;
  let totalTempoAmount = 0;
  let totalTempoCount = 0;

  deliveries.forEach(d => {
    totalBeliAmount += (d.grandTotal || 0);
    if (d.bonus) totalBonusCount++;

    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    if (sisa > 0) {
      totalTempoAmount += sisa;
      totalTempoCount++;
    }
  });

  let totalReturQty = 0;
  let totalReturCount = returns.length;
  returns.forEach(r => {
    totalReturQty += (Number(r.qty) || 0);
  });

  // Tampilkan ke UI Cards
  const elBeliAmount = document.getElementById('rekap-total-beli-amount');
  const elBeliCount = document.getElementById('rekap-total-beli-count');
  const elTempoAmount = document.getElementById('rekap-total-tempo-amount');
  const elTempoCount = document.getElementById('rekap-total-tempo-count');
  const elReturQty = document.getElementById('rekap-total-retur-qty');
  const elReturCount = document.getElementById('rekap-total-retur-count');
  const elBonusCount = document.getElementById('rekap-total-bonus-count');

  if (elBeliAmount) elBeliAmount.textContent = formatRupiah(totalBeliAmount);
  if (elBeliCount) elBeliCount.textContent = `${totalBeliCount} Nota Pembelian`;
  if (elTempoAmount) elTempoAmount.textContent = formatRupiah(totalTempoAmount);
  if (elTempoCount) elTempoCount.textContent = `${totalTempoCount} Nota Belum Lunas`;
  if (elReturQty) elReturQty.textContent = `${totalReturQty} Pcs`;
  if (elReturCount) elReturCount.textContent = `${totalReturCount} Transaksi Retur`;
  if (elBonusCount) elBonusCount.textContent = `${totalBonusCount} Promo`;

  // Gabungkan ke dalam satu tabel kronologis
  const mergedLogs = [];
  deliveries.forEach(d => {
    const itemDetails = (d.items || []).map(i => `${i.nama} (${i.qty} pcs)`).join(', ');
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    const isLunas = sisa <= 0;

    let refText = `Nota: ${d.noNota}`;
    if (!isLunas) {
      refText += ` [⏳ Tempo: Sisa ${formatRupiah(sisa)}]`;
    }
    if (d.bonus) {
      refText += ` (Bonus: ${d.bonus})`;
    }

    mergedLogs.push({
      tanggal: d.tanggal,
      tipe: 'Pembelian Masuk',
      sales: d.salesName,
      ref: refText,
      detail: itemDetails,
      nilai: d.grandTotal || 0,
      isReturn: false,
      isLunas: isLunas,
      sisa: sisa
    });
  });

  returns.forEach(r => {
    mergedLogs.push({
      tanggal: r.tanggal,
      tipe: 'Retur Produk',
      sales: r.salesName,
      ref: `Retur (${r.alasan})`,
      detail: `${r.productName} (${r.qty} pcs)`,
      nilai: (r.qty * (r.hargaBeli || 0)),
      isReturn: true,
      isLunas: true,
      sisa: 0
    });
  });

  // Urutkan tanggal terbaru ke terlama
  mergedLogs.sort((a, b) => (b.tanggal || '').localeCompare(a.tanggal || ''));

  tbody.innerHTML = '';
  if (mergedLogs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          Tidak ada transaksi sales untuk periode ini.
        </td>
      </tr>
    `;
    return;
  }

  mergedLogs.forEach(log => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${log.tanggal || '-'}</td>
      <td>
        ${log.isReturn ? 
          `<span style="background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 700; font-size: 0.8rem;">🔄 Retur</span>` : 
          `<span style="background: rgba(37, 99, 235, 0.15); color: #2563eb; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 700; font-size: 0.8rem;">📦 Pembelian Nota</span>`
        }
      </td>
      <td><strong>${log.sales}</strong></td>
      <td style="font-family: monospace; font-size: 0.85rem;">${log.ref}</td>
      <td style="font-size: 0.85rem; max-width: 250px;">${log.detail}</td>
      <td style="text-align: right; font-family: monospace; font-weight: 700; ${log.isReturn ? 'color: #dc2626;' : 'color: #059669;'}">
        ${log.isReturn ? '-' : ''}${formatRupiah(log.nilai)}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ============================================================================
// 10. FITUR CETAK REKAPITULASI, CETAK NOTA KULAK & CETAK SURAT RETUR SALES
// ============================================================================

// Helper: Nama Toko & Header Resmi dari Pengaturan Struk/Toko
function getStorePrintHeader() {
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : ((appConfig && appConfig.namaToko) ? appConfig.namaToko : 'TOKO');
  const storeAddress = (receiptSettings && receiptSettings.address) ? receiptSettings.address : ((appConfig && appConfig.alamatToko) ? appConfig.alamatToko : '');
  const storePhone = (receiptSettings && receiptSettings.phone) ? `Telp/WA: ${receiptSettings.phone}` : ((appConfig && appConfig.teleponToko) ? `Telp/WA: ${appConfig.teleponToko}` : '');

  return `
    <div style="text-align: center; border-bottom: 2px dashed #000; padding-bottom: 8px; margin-bottom: 10px;">
      <div style="font-size: 16px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">${storeName}</div>
      ${storeAddress ? `<div style="font-size: 11px; color: #333; margin-top: 2px;">${storeAddress}</div>` : ''}
      ${storePhone ? `<div style="font-size: 11px; color: #333; margin-top: 1px;">${storePhone}</div>` : ''}
    </div>
  `;
}

// A. Cetak Rekapitulasi Pembelian & Retur Sales (Thermal & A4 Compatible)
function printSalesRekapReport() {
  const filterType = document.getElementById('sales-rekap-type').value;
  const selectedDate = document.getElementById('sales-rekap-date').value;
  const selectedMonth = document.getElementById('sales-rekap-month').value;
  const selectedSales = document.getElementById('sales-rekap-sales-target').value;

  const periodeLabel = (filterType === 'hari') ? `Tanggal: ${selectedDate || '-'}` : `Bulan: ${selectedMonth || '-'}`;
  let salesNameLabel = 'Semua Supplier / Sales';
  if (selectedSales !== 'All') {
    const s = salesList.find(x => x.id === selectedSales);
    if (s) salesNameLabel = s.nama + (s.perusahaan ? ` (${s.perusahaan})` : '');
  }

  // Data
  let deliveries = salesDeliveries.filter(d => {
    if (selectedSales !== 'All' && d.salesId !== selectedSales) return false;
    return (filterType === 'hari') ? (d.tanggal === selectedDate) : (d.tanggal && d.tanggal.startsWith(selectedMonth));
  });

  let returns = salesReturns.filter(r => {
    if (selectedSales !== 'All' && r.salesId !== selectedSales) return false;
    return (filterType === 'hari') ? (r.tanggal === selectedDate) : (r.tanggal && r.tanggal.startsWith(selectedMonth));
  });

  let totalBeli = 0;
  let totalTempo = 0;
  deliveries.forEach(d => {
    totalBeli += (d.grandTotal || 0);
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    if (sisa > 0) totalTempo += sisa;
  });

  let totalReturQty = 0;
  let totalReturVal = 0;
  returns.forEach(r => {
    const q = Number(r.qty) || 0;
    totalReturQty += q;
    totalReturVal += (q * (r.hargaBeli || 0));
  });

  let rowsHtml = '';
  deliveries.forEach((d, idx) => {
    const itemsText = (d.items || []).map(i => `${i.nama} (${i.qty}x)`).join(', ');
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    const statusText = sisa <= 0 ? 'Lunas' : `Tempo (Sisa ${formatRupiah(sisa)})`;

    rowsHtml += `
      <tr>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${d.tanggal}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;"><strong>${d.noNota}</strong><br><small>${d.salesName}</small></td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${itemsText}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${statusText}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px; text-align: right; font-family: monospace;">${formatRupiah(d.grandTotal)}</td>
      </tr>
    `;
  });

  let returnRowsHtml = '';
  returns.forEach(r => {
    const val = (r.qty || 0) * (r.hargaBeli || 0);
    returnRowsHtml += `
      <tr>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.tanggal}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.salesName}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.productName} (${r.qty} pcs)</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.alasan} - <em>${r.status}</em></td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px; text-align: right; font-family: monospace; color: #dc2626;">-${formatRupiah(val)}</td>
      </tr>
    `;
  });

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan Rekap Sales & Kulak</title>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Courier New', Courier, monospace, sans-serif; margin: 0; padding: 15px; color: #000; font-size: 12px; }
        .title { text-align: center; font-size: 14px; font-weight: bold; margin-bottom: 4px; text-transform: uppercase; }
        .meta-table { width: 100%; margin-bottom: 12px; border-collapse: collapse; font-size: 11px; }
        .meta-table td { padding: 2px 0; }
        .data-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
        .data-table th { background: #eee; font-size: 11px; padding: 5px; border-bottom: 1px solid #000; text-align: left; }
        .summary-box { border: 1.5px solid #000; padding: 8px; margin-bottom: 12px; border-radius: 4px; font-size: 11px; }
        .summary-box table { width: 100%; }
        .sign-area { display: flex; justify-content: space-between; margin-top: 25px; padding-top: 10px; font-size: 11px; text-align: center; }
        @media print {
          body { padding: 0; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <div class="title">REKAPITULASI PEMBELIAN &amp; RETUR SALES</div>
      <table class="meta-table">
        <tr><td><strong>Periode:</strong> ${periodeLabel}</td><td style="text-align: right;"><strong>Sales:</strong> ${salesNameLabel}</td></tr>
        <tr><td><strong>Dicetak Pada:</strong> ${new Date().toLocaleString('id-ID')}</td><td style="text-align: right;"><strong>Status:</strong> Resmi Toko</td></tr>
      </table>

      <div class="summary-box">
        <table>
          <tr><td>Total Pembelian (${deliveries.length} Nota):</td><td style="text-align: right; font-weight: bold;">${formatRupiah(totalBeli)}</td></tr>
          <tr><td>Total Tagihan Tempo (Hutang Belum Lunas):</td><td style="text-align: right; font-weight: bold; color: #b45309;">${formatRupiah(totalTempo)}</td></tr>
          <tr><td>Total Nilai Retur (${totalReturQty} pcs):</td><td style="text-align: right; font-weight: bold; color: #dc2626;">-${formatRupiah(totalReturVal)}</td></tr>
          <tr style="border-top: 1px dashed #000;">
            <td style="padding-top: 4px;"><strong>PENGELUARAN BERSIH KULAK:</strong></td>
            <td style="text-align: right; font-weight: 800; font-size: 13px; padding-top: 4px;">${formatRupiah(Math.max(0, totalBeli - totalReturVal))}</td>
          </tr>
        </table>
      </div>

      <div style="font-weight: bold; margin-bottom: 4px; font-size: 11px;">RINCIAN NOTA PEMBELIAN BARANG MASUK:</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Tgl</th>
            <th>No Nota / Sales</th>
            <th>Item Barang</th>
            <th>Status</th>
            <th style="text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="5" style="text-align:center; padding: 10px;">Tidak ada nota pembelian pada periode ini.</td></tr>'}
        </tbody>
      </table>

      ${returns.length > 0 ? `
        <div style="font-weight: bold; margin: 12px 0 4px 0; font-size: 11px;">RINCIAN BARANG RETUR:</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Tgl</th>
              <th>Sales</th>
              <th>Produk &amp; Qty</th>
              <th>Alasan &amp; Status</th>
              <th style="text-align: right;">Estimasi Nilai</th>
            </tr>
          </thead>
          <tbody>
            ${returnRowsHtml}
          </tbody>
        </table>
      ` : ''}

      <div class="sign-area">
        <div>
          Penanggung Jawab / Kasir<br><br><br><br>
          ( ........................... )
        </div>
        <div>
          Supplier / Rekanan Sales<br><br><br><br>
          ( ........................... )
        </div>
      </div>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// B. Cetak 1 Lembar Bukti Penerimaan Barang / Nota Masuk Sales (Struk Thermal 58mm/80mm atau Kertas Nota)
function printSingleSalesDeliveryReceipt(deliveryId) {
  const d = salesDeliveries.find(x => x.id === deliveryId);
  if (!d) {
    alert('Data nota pengiriman tidak ditemukan!');
    return;
  }

  const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
  const isLunas = sisa <= 0;

  let itemsHtml = '';
  (d.items || []).forEach((item, idx) => {
    const expStr = item.expired ? ` [Exp: ${item.expired}]` : '';
    itemsHtml += `
      <div style="margin-bottom: 4px;">
        <div style="font-weight: bold;">${idx + 1}. ${item.nama}</div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; padding-left: 8px;">
          <span>${item.qty} pcs @${formatRupiah(item.hargaBeli)}${expStr}</span>
          <span style="font-weight: 600;">${formatRupiah(item.subtotal)}</span>
        </div>
      </div>
    `;
  });

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bukti Masuk Nota - ${d.noNota}</title>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Courier New', Courier, monospace, sans-serif; max-width: 380px; margin: 0 auto; padding: 12px; color: #000; font-size: 12px; }
        .divider { border-top: 1px dashed #000; margin: 8px 0; }
        .double-divider { border-top: 2px dashed #000; margin: 8px 0; }
        .flex-row { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 2px; }
        .title { text-align: center; font-weight: bold; font-size: 13px; margin: 6px 0; }
        .sign { display: flex; justify-content: space-between; text-align: center; margin-top: 25px; font-size: 10px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <div class="title">BUKTI KEDATANGAN BARANG SALES</div>
      <div class="flex-row"><span>No. Nota:</span><strong>${d.noNota}</strong></div>
      <div class="flex-row"><span>Tanggal:</span><span>${d.tanggal}</span></div>
      <div class="flex-row"><span>Sales:</span><strong>${d.salesName}</strong></div>
      <div class="divider"></div>

      <div style="font-weight: bold; font-size: 11px; margin-bottom: 5px;">RINCIAN BARANG:</div>
      ${itemsHtml}

      <div class="divider"></div>
      <div class="flex-row"><span>Total Kotor:</span><span>${formatRupiah(d.totalTagihan)}</span></div>
      ${d.diskon ? `<div class="flex-row"><span>Diskon Toko:</span><span>-${formatRupiah(d.diskon)}</span></div>` : ''}
      ${d.returDeduction ? `<div class="flex-row" style="color: #dc2626;"><span>Potongan Retur:</span><span>-${formatRupiah(d.returDeduction)}</span></div>` : ''}
      <div class="double-divider"></div>
      <div class="flex-row" style="font-size: 13px; font-weight: 800;"><span>TOTAL BERSIH:</span><span>${formatRupiah(d.grandTotal)}</span></div>
      
      <div class="flex-row" style="margin-top: 4px;">
        <span>Status Bayar:</span>
        <strong>${isLunas ? 'LUNAS (TUNAI)' : 'TEMPO / TAGIHAN'}</strong>
      </div>
      ${!isLunas ? `
        <div class="flex-row"><span>Sudah Dibayar/DP:</span><span>${formatRupiah(d.totalDibayar || 0)}</span></div>
        <div class="flex-row" style="color: #dc2626; font-weight: bold;"><span>Sisa Hutang:</span><span>${formatRupiah(sisa)}</span></div>
        ${d.jatuhTempo ? `<div class="flex-row"><span>Jatuh Tempo:</span><span>${d.jatuhTempo}</span></div>` : ''}
      ` : ''}
      ${d.bonus ? `<div class="flex-row" style="margin-top: 4px;"><span>Bonus/Gratis:</span><span>🎁 ${d.bonus}</span></div>` : ''}

      <div class="sign">
        <div>Diterima Toko:<br><br><br>( ................. )</div>
        <div>Kurir / Sales:<br><br><br>( ................. )</div>
      </div>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// C. Cetak Surat Tanda Terima Retur Barang Bermasalah ke Sales
function printSingleSalesReturnReceipt(returnId) {
  const r = salesReturns.find(x => x.id === returnId);
  if (!r) {
    alert('Data retur tidak ditemukan!');
    return;
  }

  const totalNilai = (r.qty || 0) * (r.hargaBeli || 0);

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Surat Tanda Terima Retur - ${r.productName}</title>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Courier New', Courier, monospace, sans-serif; max-width: 380px; margin: 0 auto; padding: 12px; color: #000; font-size: 12px; }
        .divider { border-top: 1px dashed #000; margin: 8px 0; }
        .double-divider { border-top: 2px dashed #000; margin: 8px 0; }
        .flex-row { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
        .title { text-align: center; font-weight: bold; font-size: 13px; margin: 6px 0; }
        .sign { display: flex; justify-content: space-between; text-align: center; margin-top: 25px; font-size: 10px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <div class="title">SURAT TANDA TERIMA RETUR PRODUK</div>
      <div class="flex-row"><span>No. Bukti:</span><strong>${r.id}</strong></div>
      <div class="flex-row"><span>Tanggal:</span><span>${r.tanggal}</span></div>
      <div class="flex-row"><span>Sales Tujuan:</span><strong>${r.salesName}</strong></div>
      <div class="divider"></div>

      <div class="flex-row"><span>Nama Produk:</span><strong>${r.productName}</strong></div>
      <div class="flex-row"><span>Jumlah Diretur:</span><strong style="font-size: 13px;">${r.qty} pcs</strong></div>
      <div class="flex-row"><span>Harga Modal/Beli:</span><span>${formatRupiah(r.hargaBeli || 0)}</span></div>
      <div class="flex-row"><span>Estimasi Nilai Retur:</span><strong>${formatRupiah(totalNilai)}</strong></div>
      <div class="divider"></div>

      <div class="flex-row"><span>Alasan Retur:</span><span>${r.alasan}</span></div>
      <div class="flex-row"><span>Status Penggantian:</span><strong>${r.status}</strong></div>
      ${r.catatan ? `<div class="flex-row"><span>Catatan:</span><span>${r.catatan}</span></div>` : ''}

      <div class="double-divider"></div>
      <div style="font-size: 10px; color: #333; text-align: center; margin-top: 4px;">
        *Barang telah diserahkan ke pihak sales untuk ditindaklanjuti sesuai kesepakatan penggantian.
      </div>

      <div class="sign">
        <div>Toko (Yang Menyerahkan):<br><br><br>( ................. )</div>
        <div>Sales (Yang Menerima):<br><br><br>( ................. )</div>
      </div>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// D. Cetak Laporan Cepat Daftar Nota Sesuai Filter
function printFilteredDeliveriesReport() {
  const salesFilter = document.getElementById('filter-invoice-sales') ? document.getElementById('filter-invoice-sales').value : 'All';
  const statusFilter = document.getElementById('filter-invoice-status') ? document.getElementById('filter-invoice-status').value : 'All';
  const monthFilter = document.getElementById('filter-invoice-month') ? document.getElementById('filter-invoice-month').value : '';

  let filtered = salesDeliveries;
  if (salesFilter && salesFilter !== 'All') filtered = filtered.filter(d => d.salesId === salesFilter);
  if (statusFilter && statusFilter !== 'All') {
    filtered = filtered.filter(d => {
      const isLunas = (d.statusBayar === 'Lunas') || ((d.sisaTagihan || 0) <= 0);
      return statusFilter === 'Lunas' ? isLunas : !isLunas;
    });
  }
  if (monthFilter) filtered = filtered.filter(d => d.tanggal && d.tanggal.startsWith(monthFilter));

  if (filtered.length === 0) {
    alert('Tidak ada data nota pembelian untuk filter ini.');
    return;
  }

  let totalBeli = 0;
  let rowsHtml = '';
  filtered.forEach((d, idx) => {
    totalBeli += (d.grandTotal || 0);
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    rowsHtml += `
      <tr>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${idx + 1}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${d.tanggal}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;"><strong>${d.noNota}</strong></td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${d.salesName}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${sisa <= 0 ? 'Lunas' : 'Tempo (Sisa ' + formatRupiah(sisa) + ')'}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px; text-align: right; font-family: monospace;">${formatRupiah(d.grandTotal)}</td>
      </tr>
    `;
  });

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Daftar Nota Pembelian Sales</title>
      <style>
        body { font-family: sans-serif; padding: 15px; color: #000; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #f1f5f9; padding: 6px; text-align: left; border-bottom: 2px solid #cbd5e1; }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <h3 style="text-align: center; margin-bottom: 5px;">DAFTAR NOTA PEMBELIAN BARANG DARI SALES</h3>
      <div style="font-size: 11px; text-align: center; color: #555;">Total: ${filtered.length} Nota | Nilai Belanja: <strong>${formatRupiah(totalBeli)}</strong></div>
      <table>
        <thead>
          <tr>
            <th>No</th>
            <th>Tanggal</th>
            <th>No. Nota</th>
            <th>Sales</th>
            <th>Status Bayar</th>
            <th style="text-align: right;">Total Nilai</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// E. Cetak Laporan Cepat Daftar Retur Sesuai Filter
function printFilteredReturnsReport() {
  const salesFilter = document.getElementById('filter-return-sales') ? document.getElementById('filter-return-sales').value : 'All';
  const monthFilter = document.getElementById('filter-return-month') ? document.getElementById('filter-return-month').value : '';

  let filtered = salesReturns;
  if (salesFilter && salesFilter !== 'All') filtered = filtered.filter(r => r.salesId === salesFilter);
  if (monthFilter) filtered = filtered.filter(r => r.tanggal && r.tanggal.startsWith(monthFilter));

  if (filtered.length === 0) {
    alert('Tidak ada data barang retur untuk filter ini.');
    return;
  }

  let totalQty = 0;
  let totalVal = 0;
  let rowsHtml = '';
  filtered.forEach((r, idx) => {
    const q = Number(r.qty) || 0;
    const v = q * (r.hargaBeli || 0);
    totalQty += q;
    totalVal += v;

    rowsHtml += `
      <tr>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${idx + 1}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.tanggal}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.salesName}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;"><strong>${r.productName}</strong></td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px; text-align: center; font-weight: bold; color: #dc2626;">${r.qty} pcs</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.alasan}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px;">${r.status}</td>
        <td style="padding: 4px; border-bottom: 1px solid #ccc; font-size: 11px; text-align: right; font-family: monospace;">${formatRupiah(v)}</td>
      </tr>
    `;
  });

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Daftar Retur Barang ke Sales</title>
      <style>
        body { font-family: sans-serif; padding: 15px; color: #000; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { background: #fef2f2; padding: 6px; text-align: left; border-bottom: 2px solid #fca5a5; }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <h3 style="text-align: center; margin-bottom: 5px; color: #b91c1c;">DAFTAR RETUR PRODUK BERMASALAH KE SALES</h3>
      <div style="font-size: 11px; text-align: center; color: #555;">Total: ${filtered.length} Transaksi Retur | Total Barang: <strong>${totalQty} pcs</strong> | Nilai Retur: <strong>${formatRupiah(totalVal)}</strong></div>
      <table>
        <thead>
          <tr>
            <th>No</th>
            <th>Tanggal</th>
            <th>Sales</th>
            <th>Produk</th>
            <th style="text-align: center;">Qty</th>
            <th>Alasan</th>
            <th>Status</th>
            <th style="text-align: right;">Estimasi Nilai</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// F. Fitur Saran Tambahan: Export Rekapitulasi ke File CSV / Excel
function exportSalesRekapCSV() {
  const filterType = document.getElementById('sales-rekap-type').value;
  const selectedDate = document.getElementById('sales-rekap-date').value;
  const selectedMonth = document.getElementById('sales-rekap-month').value;
  const selectedSales = document.getElementById('sales-rekap-sales-target').value;

  let deliveries = salesDeliveries.filter(d => {
    if (selectedSales !== 'All' && d.salesId !== selectedSales) return false;
    return (filterType === 'hari') ? (d.tanggal === selectedDate) : (d.tanggal && d.tanggal.startsWith(selectedMonth));
  });

  let returns = salesReturns.filter(r => {
    if (selectedSales !== 'All' && r.salesId !== selectedSales) return false;
    return (filterType === 'hari') ? (r.tanggal === selectedDate) : (r.tanggal && r.tanggal.startsWith(selectedMonth));
  });

  if (deliveries.length === 0 && returns.length === 0) {
    alert('Tidak ada data transaksi untuk diekspor ke CSV.');
    return;
  }

  let csvContent = 'TANGGAL,TIPE,SALES,NO_NOTA_REFERENSI,RINCIAN_PRODUK,STATUS_BAYAR_GANTI,TOTAL_NILAI_RP\n';

  deliveries.forEach(d => {
    const itemsText = (d.items || []).map(i => `${i.nama} (${i.qty} pcs)`).join('; ');
    const sisa = (d.sisaTagihan !== undefined) ? d.sisaTagihan : (d.statusBayar === 'Tempo' ? d.grandTotal : 0);
    const statusText = sisa <= 0 ? 'Lunas' : `Tempo (Sisa ${sisa})`;
    csvContent += `"${d.tanggal}","Pembelian Masuk","${d.salesName}","${d.noNota}","${itemsText}","${statusText}",${d.grandTotal || 0}\n`;
  });

  returns.forEach(r => {
    const val = (r.qty || 0) * (r.hargaBeli || 0);
    csvContent += `"${r.tanggal}","Retur Produk","${r.salesName}","${r.alasan}","${r.productName} (${r.qty} pcs)","${r.status}",-${val}\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Rekap_Sales_${filterType === 'hari' ? selectedDate : selectedMonth}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ==========================================================================
   G. FITUR MANAJEMEN CRM: RIWAYAT BELANJA, PENGINGAT WA VOUCHER, & BUKU HUTANG
   ========================================================================== */

let currentCustomerDebtFilter = 'unpaid'; // 'unpaid' | 'paid' | 'all'
let currentActiveHistoryCustomerId = null;

// 1. Switcher Sub-View Pelanggan: Daftar Member vs Buku Hutang
function switchCustomerSubView(subview) {
  const membersView = document.getElementById('cust-subview-members');
  const debtView = document.getElementById('cust-subview-debt');
  const btnMembers = document.getElementById('tab-btn-cust-members');
  const btnDebt = document.getElementById('tab-btn-cust-debt');

  if (subview === 'debt') {
    if (membersView) membersView.style.display = 'none';
    if (debtView) debtView.style.display = 'block';

    if (btnMembers) {
      btnMembers.style.background = 'transparent';
      btnMembers.style.color = '#64748b';
      btnMembers.style.boxShadow = 'none';
    }
    if (btnDebt) {
      btnDebt.style.background = '#ef4444';
      btnDebt.style.color = '#fff';
      btnDebt.style.boxShadow = '0 2px 6px rgba(239,68,68,0.3)';
    }
    renderCustomerDebtBook();
  } else {
    if (membersView) membersView.style.display = 'block';
    if (debtView) debtView.style.display = 'none';

    if (btnMembers) {
      btnMembers.style.background = '#ea580c';
      btnMembers.style.color = '#fff';
      btnMembers.style.boxShadow = '0 2px 6px rgba(234,88,12,0.3)';
    }
    if (btnDebt) {
      btnDebt.style.background = 'transparent';
      btnDebt.style.color = '#64748b';
      btnDebt.style.boxShadow = 'none';
    }
    renderCustomersTable();
  }
}


// 2. Filter Status Hutang Member
function setCustomerDebtFilter(filter) {
  currentCustomerDebtFilter = filter;
  ['unpaid', 'paid', 'all'].forEach(f => {
    const btn = document.getElementById(`btn-debt-filter-${f}`);
    if (btn) {
      if (f === filter) {
        btn.style.background = (f === 'unpaid') ? '#ef4444' : ((f === 'paid') ? '#10b981' : '#ea580c');
        btn.style.color = '#fff';
      } else {
        btn.style.background = 'transparent';
        btn.style.color = '#64748b';
      }
    }
  });
  renderCustomerDebtBook();
}

// 3. Render Tabel & Ringkasan Buku Hutang Member
function renderCustomerDebtBook() {
  const tbody = document.getElementById('customer-debt-table-body');
  if (!tbody) return;

  // Selalu ambil dari localStorage sebagai sumber paling akurat
  // (global transactions bisa kosong jika cloud sync belum selesai)
  let txSource = transactions;
  if (!txSource || txSource.length === 0) {
    try {
      const cached = localStorage.getItem('kasir_transactions');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          txSource = parsed;
          transactions = parsed; // Update global
          console.log(`[DebtBook] Loaded ${txSource.length} tx from localStorage fallback`);
        }
      }
    } catch(e) { txSource = []; }
  }

  const monthFilter = document.getElementById('filter-debt-month')?.value || '';
  const now = new Date();
  const todayStr = getLocalISODate(now).slice(0, 10);

  // Filter semua transaksi yang pernah/masih Bon:
  // - status_pembayaran === 'Bon'  (aktif Bon)
  // - sisa_piutang > 0             (masih punya sisa, walaupun status mungkin belum diupdate)
  // - riwayat_pelunasan.length > 0 (pernah Bon, sudah lunas sebagian/penuh)
  // - total > bayar (DP kurang dari total, ini data lama yang tidak punya sisa_piutang)
  let debtTxs = txSource.filter(tx => {
    if (tx.status_pembayaran === 'Bon') return true;
    if ((tx.sisa_piutang || 0) > 0) return true;
    if (Array.isArray(tx.riwayat_pelunasan) && tx.riwayat_pelunasan.length > 0) return true;
    // Tangkap data lama: transaksi yang bayar < total dan nama pelanggan diisi
    if (tx.nama_pelanggan && (tx.bayar || 0) < (tx.total || 0) && tx.status_pembayaran !== 'Lunas') return true;
    return false;
  });

  // Perbaiki data lama yang sisa_piutang-nya belum dihitung
  debtTxs = debtTxs.map(tx => {
    if ((tx.sisa_piutang === undefined || tx.sisa_piutang === null) && tx.status_pembayaran === 'Bon') {
      const bayar = tx.bayar || 0;
      const total = tx.total || 0;
      tx.sisa_piutang = Math.max(0, total - bayar);
    }
    return tx;
  });

  // Filter Bulan jika dipilih
  if (monthFilter) {
    debtTxs = debtTxs.filter(tx => tx.waktu && parseTxDateStr(tx.waktu).startsWith(monthFilter));
  }

  // Hitung ringkasan & Peringatan Jatuh Tempo
  let unpaidCount = 0, paidCount = 0, totalUnpaidRp = 0, totalPaidRp = 0;
  let overdueCount = 0, overdueTotalRp = 0;
  const uniqueDebtorsSet = new Set();

  debtTxs.forEach(tx => {
    const sisa = tx.sisa_piutang || 0;
    if (sisa > 0) {
      unpaidCount++;
      totalUnpaidRp += sisa;
      if (tx.nama_pelanggan) uniqueDebtorsSet.add(tx.nama_pelanggan);

      // Cek jatuh tempo
      if (tx.jatuh_tempo && tx.jatuh_tempo <= todayStr) {
        overdueCount++;
        overdueTotalRp += sisa;
      }
    } else {
      paidCount++;
      if (Array.isArray(tx.riwayat_pelunasan) && tx.riwayat_pelunasan.length > 0) {
        totalPaidRp += tx.riwayat_pelunasan.reduce((s, p) => s + (p.bayar || 0), 0);
      } else {
        totalPaidRp += (tx.total || 0);
      }
    }
  });

  // Update badge & summary
  const badgeTotalDebtors = document.getElementById('badge-total-debtors');
  const countUnpaidEl = document.getElementById('count-debt-unpaid');
  const countPaidEl = document.getElementById('count-debt-paid');
  const sumUnpaidEl = document.getElementById('summary-total-unpaid-debt');
  const sumPaidEl = document.getElementById('summary-total-paid-debt');
  const sumDebtorsCountEl = document.getElementById('summary-debtors-count');
  const overdueCountEl = document.getElementById('summary-overdue-debt-count');
  const overdueAmountEl = document.getElementById('summary-overdue-debt-amount');

  if (badgeTotalDebtors) badgeTotalDebtors.textContent = uniqueDebtorsSet.size;
  if (countUnpaidEl) countUnpaidEl.textContent = unpaidCount;
  if (countPaidEl) countPaidEl.textContent = paidCount;
  if (sumUnpaidEl) sumUnpaidEl.textContent = `Rp ${formatRupiah(totalUnpaidRp)}`;
  if (sumPaidEl) sumPaidEl.textContent = `Rp ${formatRupiah(totalPaidRp)}`;
  if (sumDebtorsCountEl) sumDebtorsCountEl.textContent = `${uniqueDebtorsSet.size} Pelanggan Masih Memiliki Hutang`;
  if (overdueCountEl) overdueCountEl.textContent = `${overdueCount} Tagihan`;
  if (overdueAmountEl) overdueAmountEl.textContent = `Rp ${formatRupiah(overdueTotalRp)} Perlu Ditagih Segera`;

  // Filter tampilan sesuai tab aktif
  let displayTxs = debtTxs;
  if (currentCustomerDebtFilter === 'unpaid') {
    displayTxs = debtTxs.filter(tx => (tx.sisa_piutang || 0) > 0);
  } else if (currentCustomerDebtFilter === 'paid') {
    displayTxs = debtTxs.filter(tx => (tx.sisa_piutang || 0) <= 0);
  } else if (currentCustomerDebtFilter === 'overdue') {
    displayTxs = debtTxs.filter(tx => (tx.sisa_piutang || 0) > 0 && tx.jatuh_tempo && tx.jatuh_tempo <= todayStr);
  }

  // Filter Pencarian Nama Pelanggan / ID Transaksi / Produk
  const searchInput = document.getElementById('debt-search-customer');
  const query = (searchInput?.value || '').trim().toLowerCase();
  if (query) {
    displayTxs = displayTxs.filter(tx => {
      const matchName = (tx.nama_pelanggan || '').toLowerCase().includes(query);
      const matchId = (tx.id || '').toLowerCase().includes(query);
      const matchItems = Array.isArray(tx.items) && tx.items.some(it => (it.nama || '').toLowerCase().includes(query));
      const matchNotes = (tx.catatan_bon || '').toLowerCase().includes(query);
      return matchName || matchId || matchItems || matchNotes;
    });
  }

  // Urutkan: yang belum lunas dulu, lalu yang terlama
  displayTxs.sort((a, b) => {
    const aUnpaid = (a.sisa_piutang || 0) > 0 ? 1 : 0;
    const bUnpaid = (b.sisa_piutang || 0) > 0 ? 1 : 0;
    if (aUnpaid !== bUnpaid) return bUnpaid - aUnpaid;
    return new Date(a.waktu || 0) - new Date(b.waktu || 0);
  });

  tbody.innerHTML = '';

  if (displayTxs.length === 0) {
    // Tampilkan info berapa total transaksi ada
    const totalTx = txSource.length;
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 2.5rem 1rem;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🎉</div>
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">Tidak Ada Data Piutang</div>
          <div style="font-size: 0.8rem; margin-top: 0.25rem; color: #64748b;">
            ${currentCustomerDebtFilter === 'unpaid' ? 'Semua hutang sudah lunas atau belum ada transaksi Bon.' : 'Tidak ada data hutang yang cocok dengan filter.'}
          </div>
          <div style="font-size: 0.75rem; margin-top: 0.5rem; color: #94a3b8;">(Total transaksi tersimpan: ${totalTx})</div>
        </td>
      </tr>
    `;
    return;
  }


  displayTxs.forEach(tx => {
    const tr = document.createElement('tr');
    const sisa = tx.sisa_piutang || 0;
    const isLunas = sisa <= 0;
    const waktuStr = tx.waktu ? parseTxDate(tx.waktu).toLocaleString('id-ID', { hour12: false }) : '-';
    const dueDate = tx.jatuh_tempo || '-';
    const isOverdue = !isLunas && tx.jatuh_tempo && (tx.jatuh_tempo < todayStr);
    const isDueToday = !isLunas && tx.jatuh_tempo && (tx.jatuh_tempo === todayStr);

    let dueBadgeHtml = `<span style="font-size: 0.82rem; font-family: monospace;">${dueDate}</span>`;
    if (isOverdue) {
      dueBadgeHtml += `<div style="font-size: 0.7rem; color: #dc2626; font-weight: 700; background: #fef2f2; padding: 0.1rem 0.4rem; border-radius: 4px; display: inline-block; margin-top: 2px;">⚠️ Lewat Jatuh Tempo</div>`;
    } else if (isDueToday) {
      dueBadgeHtml += `<div style="font-size: 0.7rem; color: #d97706; font-weight: 700; background: #fffbeb; padding: 0.1rem 0.4rem; border-radius: 4px; display: inline-block; margin-top: 2px;">⏰ Jatuh Tempo Hari Ini</div>`;
    }

    // Rincian produk yang dihutang
    let productsHtml = '';
    if (Array.isArray(tx.items) && tx.items.length > 0) {
      productsHtml = `<div style="display: flex; flex-direction: column; gap: 3px; max-width: 250px;">`;
      tx.items.forEach(it => {
        const itemSubtotal = it.subtotal !== undefined ? it.subtotal : ((it.harga || 0) * (it.qty || 1));
        productsHtml += `
          <div style="font-size: 0.78rem; line-height: 1.3; color: var(--text-main); display: flex; justify-content: space-between; gap: 6px; border-bottom: 1px dotted var(--border-color); padding-bottom: 2px;">
            <span>• <b>${it.nama}</b> <span style="color:var(--text-muted);">&times;${it.qty || 1}</span></span>
            <span style="font-weight: 600; white-space: nowrap; color: #64748b;">Rp ${formatRupiah(itemSubtotal)}</span>
          </div>
        `;
      });
      productsHtml += `</div>`;
    } else {
      productsHtml = `<span style="font-size: 0.78rem; color: var(--text-muted); font-style: italic;">Hutang Manual (Tanpa Rincian POS)</span>`;
    }

    // Riwayat pelunasan & tanggal lunas
    let settlementHistoryHtml = '';
    const hasHistory = Array.isArray(tx.riwayat_pelunasan) && tx.riwayat_pelunasan.length > 0;
    if (isLunas) {
      let lunasDateStr = '-';
      if (hasHistory) {
        const lastPayment = tx.riwayat_pelunasan[tx.riwayat_pelunasan.length - 1];
        if (lastPayment && lastPayment.waktu) {
          lunasDateStr = parseTxDate(lastPayment.waktu).toLocaleString('id-ID', { hour12: false });
        }
      }
      settlementHistoryHtml = `
        <div style="margin-top: 4px; font-size: 0.73rem; color: #059669; background: #ecfdf5; padding: 0.25rem 0.5rem; border-radius: 6px; border: 1px solid #a7f3d0;">
          <div><b>✓ Lunas pada:</b> ${lunasDateStr}</div>
          ${hasHistory ? `<div style="font-size: 0.7rem; color: #047857; margin-top: 2px;">Melunasi seluruh produk di transaksi ini (${tx.riwayat_pelunasan.length}x pembayaran)</div>` : ''}
        </div>
      `;
    } else if (hasHistory) {
      let totalPaidSoFar = tx.riwayat_pelunasan.reduce((sum, p) => sum + (p.bayar || 0), 0);
      const lastPayment = tx.riwayat_pelunasan[tx.riwayat_pelunasan.length - 1];
      const lastPaymentStr = lastPayment && lastPayment.waktu ? parseTxDate(lastPayment.waktu).toLocaleDateString('id-ID') : '-';
      settlementHistoryHtml = `
        <div style="margin-top: 4px; font-size: 0.72rem; color: #0284c7; background: #f0f9ff; padding: 0.25rem 0.5rem; border-radius: 6px; border: 1px solid #bae6fd;">
          <div><b>Dicicil:</b> Rp ${formatRupiah(totalPaidSoFar)}</div>
          <div style="font-size: 0.68rem; color: #0369a1;">Terakhir: ${lastPaymentStr}</div>
        </div>
      `;
    }

    let statusBadgeHtml = isLunas
      ? `<span style="font-size: 0.75rem; color: #059669; background: #ecfdf5; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid #a7f3d0; display: inline-block;">Lunas</span>`
      : `<span style="font-size: 0.75rem; color: #dc2626; background: #fef2f2; font-weight: 800; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid #fecaca; display: inline-block;">Belum Lunas</span>`;

    let actionBtnHtml = '';
    if (isLunas) {
      actionBtnHtml = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="showReceipt(transactions.find(t=>t.id==='${tx.id}'), transactions.find(t=>t.id==='${tx.id}')?.items)" title="Lihat Struk Transaksi Lengkap" style="font-size: 0.75rem; padding: 0.35rem 0.65rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 0.25rem;">
          <i data-lucide="receipt" style="width: 13px; height: 13px;"></i>
          <span>Struk</span>
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteCustomerDebt('${tx.id}')" title="Hapus Catatan Hutang Ini" style="font-size: 0.75rem; padding: 0.35rem 0.6rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 0.25rem; background: #ef4444; border-color: #ef4444; color: #fff;">
          <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
          <span>Hapus</span>
        </button>
      `;
    } else {
      actionBtnHtml = `
        <button type="button" class="btn btn-primary btn-sm" onclick="openPayDebtModal('${tx.id}')" title="Bayar / Cicil Hutang Transaksi Ini" style="font-size: 0.78rem; font-weight: 700; padding: 0.35rem 0.7rem; border-radius: 6px; background: #10b981; border-color: #10b981; display: inline-flex; align-items: center; gap: 0.25rem;">
          <svg viewBox="0 0 24 24" style="width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2.2;"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          <span>Bayar</span>
        </button>
        <button type="button" class="btn btn-success btn-sm" onclick="sendWhatsAppDebtReminder('${tx.id}')" title="Kirim Tagihan &amp; Rincian Bon via WhatsApp" style="font-size: 0.75rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 6px; background: #25d366; border-color: #25d366; color: #fff; display: inline-flex; align-items: center; gap: 0.25rem;">
          <span>💬 WA</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="quickPayFullDebt('${tx.id}')" title="Langsung Tandai Lunas Cepat" style="font-size: 0.75rem; font-weight: 600; padding: 0.35rem 0.5rem; border-radius: 6px;">
          <span>⚡ Lunas</span>
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="deleteCustomerDebt('${tx.id}')" title="Hapus Catatan Hutang Ini" style="font-size: 0.75rem; padding: 0.35rem 0.6rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 0.25rem; background: #ef4444; border-color: #ef4444; color: #fff;">
          <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
          <span>Hapus</span>
        </button>
      `;
    }

    const noteText = tx.catatan_bon ? `<div style="font-size: 0.73rem; color: var(--text-muted); font-style: italic; margin-top: 2px;">Catatan: ${tx.catatan_bon}</div>` : '';

    tr.innerHTML = `
      <td>
        <strong style="color: var(--text-main); font-size: 0.9rem;">${tx.nama_pelanggan || 'Pelanggan Umum'}</strong>
        ${noteText}
      </td>
      <td>
        <div style="font-family: monospace; font-size: 0.8rem; font-weight: 700; color: #ea580c;">${tx.id}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 1px; display: flex; align-items: center; gap: 3px;">
          <i data-lucide="clock" style="width: 11px; height: 11px;"></i> ${waktuStr}
        </div>
      </td>
      <td>
        ${productsHtml}
      </td>
      <td>${dueBadgeHtml}</td>
      <td style="font-size: 0.88rem; font-weight: 600;">Rp ${formatRupiah(tx.total || 0)}</td>
      <td style="font-size: 0.92rem; font-weight: 800; color: ${isLunas ? '#059669' : '#dc2626'};">
        Rp ${formatRupiah(sisa)}
      </td>
      <td>
        ${statusBadgeHtml}
        ${settlementHistoryHtml}
      </td>
      <td style="text-align: center;">
        <div style="display: inline-flex; gap: 0.35rem; align-items: center; justify-content: center; flex-wrap: wrap;">
          ${actionBtnHtml}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

// 4. Modal Pelunasan Hutang Member Langsung di CRM
function openPayDebtModal(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }

  const sisa = tx.sisa_piutang || 0;
  if (sisa <= 0) {
    alert("Tagihan transaksi ini sudah lunas!");
    return;
  }

  document.getElementById('pay-debt-tx-id').value = tx.id;
  document.getElementById('pay-debt-cust-name').value = tx.nama_pelanggan || '';
  document.getElementById('pay-debt-display-name').textContent = tx.nama_pelanggan || 'Pelanggan Umum';
  document.getElementById('pay-debt-display-tx').textContent = tx.id;
  document.getElementById('pay-debt-display-due').textContent = tx.jatuh_tempo || 'Tanpa Jatuh Tempo';
  document.getElementById('pay-debt-display-balance').textContent = `Rp ${formatRupiah(sisa)}`;

  const amountInput = document.getElementById('pay-debt-amount');
  if (amountInput) {
    amountInput.value = formatRupiah(sisa);
    amountInput.dataset.max = sisa;
  }
  const notesInput = document.getElementById('pay-debt-notes');
  if (notesInput) notesInput.value = '';

  const modal = document.getElementById('pay-debt-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
    setTimeout(() => {
      if (amountInput) amountInput.focus();
    }, 100);
  }
}

function closePayDebtModal() {
  const modal = document.getElementById('pay-debt-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function setPayDebtFullAmount() {
  const amountInput = document.getElementById('pay-debt-amount');
  const maxSisa = parseFloat(amountInput?.dataset?.max) || 0;
  if (amountInput && maxSisa > 0) {
    amountInput.value = formatRupiah(maxSisa);
  }
}

let isSubmittingPayDebt = false;

async function submitPayDebt(event) {
  if (event) event.preventDefault();
  if (isSubmittingPayDebt) return;

  const submitBtn = document.querySelector('#pay-debt-modal button[type="submit"]');
  const txId = document.getElementById('pay-debt-tx-id').value;
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;

  const rawAmount = document.getElementById('pay-debt-amount').value.replace(/\./g, '');
  const payAmount = parseFloat(rawAmount) || 0;
  const payMethod = document.getElementById('pay-debt-method')?.value || 'Tunai';
  const payNotes = (document.getElementById('pay-debt-notes')?.value || '').trim();

  if (payAmount <= 0) {
    alert("Jumlah pembayaran harus lebih dari Rp 0!");
    return;
  }

  try {
    isSubmittingPayDebt = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Menyimpan...';
    }

    const sisaSebelumnya = tx.sisa_piutang || 0;
    const sisaBaru = Math.max(0, sisaSebelumnya - payAmount);
    tx.sisa_piutang = sisaBaru;

    if (sisaBaru <= 0) {
      tx.status_pembayaran = 'Lunas';
    }

    if (!Array.isArray(tx.riwayat_pelunasan)) {
      tx.riwayat_pelunasan = [];
    }

    const pelunasanEntry = {
      waktu: new Date().toISOString(),
      bayar: payAmount,
      metode: payMethod,
      kasir: activeCashier || 'Admin',
      catatan: payNotes || (sisaBaru <= 0 ? 'Pelunasan Penuh' : 'Cicilan Hutang')
    };
    tx.riwayat_pelunasan.push(pelunasanEntry);

    // Jika dibayar Tunai, otomatis catat kas masuk ke Laci Kasir agar klop saat tutup shift
    if (payMethod === 'Tunai') {
      const debtCashExpense = {
        id: 'EXP_' + Date.now(),
        tanggal: new Date().toISOString(),
        tipe: 'masuk',
        nominal: payAmount,
        kategori: 'Pelunasan Piutang',
        sumberDana: 'laci_kasir',
        keterangan: `Pelunasan Bon #${tx.id} (${tx.nama_pelanggan || 'Pelanggan'})`,
        staff: activeCashier || 'Admin'
      };
      if (!Array.isArray(expenses)) expenses = [];
      expenses.unshift(debtCashExpense);
      saveExpensesLocally();
      if (firebaseDb && typeof getStorePath === 'function') {
        firebaseDb.ref(getStorePath('expenses/' + debtCashExpense.id)).set(debtCashExpense);
      }
    }

    saveTransactionsLocally();
    renderCustomerDebtBook();
    renderTransactionsTable();
    updateAnalytics();

    // Sinkronkan update transaksi ke Cloud jika aktif
    syncSingleTransactionToCloud(tx);

    alert(`✅ Pembayaran sebesar Rp ${formatRupiah(payAmount)} berhasil dicatat!\n• Sisa Hutang: Rp ${formatRupiah(sisaBaru)}\n• Status: ${tx.status_pembayaran}`);
    closePayDebtModal();
  } finally {
    isSubmittingPayDebt = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Simpan Pembayaran';
    }
  }
}

// Cepat tandai lunas transaksi hutang
function quickPayFullDebt(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;
  const sisa = tx.sisa_piutang || 0;
  if (sisa <= 0) {
    alert("Transaksi ini sudah lunas!");
    return;
  }

  if (confirm(`Konfirmasi pelunasan penuh sebesar Rp ${formatRupiah(sisa)} untuk ${tx.nama_pelanggan || 'Pelanggan'}?`)) {
    tx.sisa_piutang = 0;
    tx.status_pembayaran = 'Lunas';

    if (!Array.isArray(tx.riwayat_pelunasan)) tx.riwayat_pelunasan = [];
    tx.riwayat_pelunasan.push({
      waktu: new Date().toISOString(),
      bayar: sisa,
      metode: 'Tunai',
      kasir: activeCashier || 'Admin',
      catatan: 'Pelunasan Cepat Penuh'
    });

    saveTransactionsLocally();
    renderCustomerDebtBook();
    updateAnalytics();
    syncSingleTransactionToCloud(tx);
    alert(`✅ Tagihan sebesar Rp ${formatRupiah(sisa)} berhasil dilunasi!`);
  }
}

// Hapus catatan hutang dari Buku Hutang
async function deleteCustomerDebt(txId) {
  if (!canPerformAction('deleteTx')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk menghapus catatan hutang/transaksi!");
    return;
  }

  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Catatan hutang tidak ditemukan!");
    return;
  }

  const debtor = tx.nama_pelanggan || 'Pelanggan';
  const sisaStr = tx.sisa_piutang ? `sebesar Rp ${formatRupiah(tx.sisa_piutang)}` : '';
  const isManual = tx.is_manual_debt === true || (Array.isArray(tx.items) && tx.items.length === 0);

  const confirmMsg = isManual
    ? `⚠️ Hapus Catatan Hutang Manual?\n\nDebitur: ${debtor} ${sisaStr}\nCatatan: ${tx.catatan_bon || '-'}\n\nApakah Anda yakin ingin menghapus catatan hutang ini secara permanen?`
    : `⚠️ Hapus Catatan Hutang Transaksi "${txId}"?\n\nPelanggan: ${debtor} ${sisaStr}\n\nPerhatian: Transaksi ini memiliki barang penjualan. Menghapus hutang ini akan membatalkan transaksi dan mengembalikan seluruh stok barang ke toko.\n\nLanjutkan hapus?`;

  if (!confirm(confirmMsg)) return;

  // Gunakan fungsi deleteTransaction yang sudah aman menangani pengembalian stok (termasuk bundling) dan sync cloud
  await deleteTransaction(txId);
  renderCustomerDebtBook();
}

// 5. Cetak Laporan Rekapitulasi Piutang & Hutang Member
function printCustomerDebtReport() {
  const monthFilter = document.getElementById('filter-debt-month')?.value || '';
  const now = new Date();
  const todayStr = getLocalISODate(now).slice(0, 10);

  let debtTxs = transactions.filter(tx => {
    const isBon = tx.status_pembayaran === 'Bon' || (tx.sisa_piutang > 0);
    const wasEverBon = Array.isArray(tx.riwayat_pelunasan) && tx.riwayat_pelunasan.length > 0;
    return isBon || wasEverBon;
  });

  if (monthFilter) {
    debtTxs = debtTxs.filter(tx => tx.waktu && parseTxDateStr(tx.waktu).startsWith(monthFilter));
  }

  if (currentCustomerDebtFilter === 'unpaid') {
    debtTxs = debtTxs.filter(tx => (tx.sisa_piutang || 0) > 0);
  } else if (currentCustomerDebtFilter === 'paid') {
    debtTxs = debtTxs.filter(tx => (tx.sisa_piutang || 0) <= 0);
  }

  if (debtTxs.length === 0) {
    alert("Tidak ada data piutang untuk dicetak.");
    return;
  }

  let totalUnpaid = 0;
  let totalPaid = 0;
  let rowsHtml = '';

  debtTxs.forEach((tx, idx) => {
    const sisa = tx.sisa_piutang || 0;
    const isLunas = sisa <= 0;
    if (isLunas) totalPaid += (tx.total || 0);
    else totalUnpaid += sisa;

    const tgl = tx.waktu ? parseTxDateStr(tx.waktu) : '-';
    const tempo = tx.jatuh_tempo || '-';
    const statusText = isLunas ? 'LUNAS' : 'BELUM LUNAS';

    rowsHtml += `
      <tr>
        <td style="padding: 6px; border: 1px solid #000; text-align: center;">${idx + 1}</td>
        <td style="padding: 6px; border: 1px solid #000;"><strong>${tx.nama_pelanggan || 'Pelanggan Umum'}</strong></td>
        <td style="padding: 6px; border: 1px solid #000; font-family: monospace;">${tx.id}</td>
        <td style="padding: 6px; border: 1px solid #000;">${tgl}</td>
        <td style="padding: 6px; border: 1px solid #000;">${tempo}</td>
        <td style="padding: 6px; border: 1px solid #000; text-align: right;">${formatRupiah(tx.total || 0)}</td>
        <td style="padding: 6px; border: 1px solid #000; text-align: right; font-weight: bold; color: ${isLunas ? '#059669' : '#dc2626'};">${formatRupiah(sisa)}</td>
        <td style="padding: 6px; border: 1px solid #000; text-align: center; font-weight: bold;">${statusText}</td>
      </tr>
    `;
  });

  const filterText = monthFilter ? `Bulan: ${monthFilter}` : 'Semua Periode';
  const printContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan Rekapitulasi Piutang & Hutang Member</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #000; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th { background: #f1f5f9; padding: 7px; text-align: left; border: 1px solid #000; font-size: 11px; }
        td { font-size: 11px; }
      </style>
    </head>
    <body>
      ${getStorePrintHeader()}
      <h3 style="text-align: center; margin: 10px 0 3px 0; text-decoration: underline;">LAPORAN REKAPITULASI PIUTANG &amp; HUTANG MEMBER</h3>
      <div style="text-align: center; font-size: 11px; color: #444; margin-bottom: 12px;">${filterText} | Status: ${currentCustomerDebtFilter.toUpperCase()}</div>
      
      <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; font-weight: bold;">
        <span>Total Piutang Belum Lunas: <span style="color: #dc2626;">Rp ${formatRupiah(totalUnpaid)}</span></span>
        <span>Total Piutang Sudah Lunas: <span style="color: #059669;">Rp ${formatRupiah(totalPaid)}</span></span>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width: 30px; text-align: center;">No</th>
            <th>Pelanggan</th>
            <th>No. Transaksi</th>
            <th>Tgl Pinjam</th>
            <th>Jatuh Tempo</th>
            <th style="text-align: right;">Total Belanja (Rp)</th>
            <th style="text-align: right;">Sisa Hutang (Rp)</th>
            <th style="text-align: center;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printContent);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 400);
  }
}

// Filter Cepat Tagihan Jatuh Tempo & Lewat Waktu
function filterOverdueDebts() {
  currentCustomerDebtFilter = 'overdue';
  const btnUnpaid = document.getElementById('btn-debt-filter-unpaid');
  const btnPaid = document.getElementById('btn-debt-filter-paid');
  const btnAll = document.getElementById('btn-debt-filter-all');
  if (btnUnpaid) { btnUnpaid.style.background = 'transparent'; btnUnpaid.style.color = 'var(--text-muted)'; }
  if (btnPaid) { btnPaid.style.background = 'transparent'; btnPaid.style.color = 'var(--text-muted)'; }
  if (btnAll) { btnAll.style.background = '#d97706'; btnAll.style.color = '#fff'; }
  renderCustomerDebtBook();
}

// Kirim Pengingat Tagihan Hutang / Piutang Otomatis ke WhatsApp Pelanggan
function sendWhatsAppDebtReminder(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Data transaksi tidak ditemukan!");
    return;
  }

  const sisa = tx.sisa_piutang || 0;
  if (sisa <= 0) {
    alert("Tagihan ini sudah lunas!");
    return;
  }

  // Cari nomor HP pelanggan dari transaksi atau data master Member
  let phone = tx.telepon_pelanggan || '';
  if (!phone && tx.nama_pelanggan) {
    const cust = customers.find(c => c.nama && c.nama.trim().toLowerCase() === tx.nama_pelanggan.trim().toLowerCase());
    if (cust && cust.telepon) phone = cust.telepon;
  }

  // Jika belum ada nomor HP, tanyakan ke kasir/owner
  if (!phone) {
    phone = prompt(`Masukkan Nomor WhatsApp pelanggan "${tx.nama_pelanggan || 'Pelanggan'}":`, '08');
    if (!phone) return;
  }

  let cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);

  const storeName = (receiptSettings && receiptSettings.name) || 'Toko Kami';
  const storePhone = (receiptSettings && receiptSettings.phone) ? `\nKontak: ${receiptSettings.phone}` : '';
  const customerName = tx.nama_pelanggan || 'Bapak/Ibu Pelanggan';
  const dueDateStr = tx.jatuh_tempo || '-';
  const txDateStr = tx.waktu ? parseTxDateStr(tx.waktu) : '-';

  // Rincian barang
  let itemsListText = '';
  if (Array.isArray(tx.items) && tx.items.length > 0) {
    itemsListText = '\n📦 *Rincian Belanjaan:*\n' + tx.items.map(it => `• ${it.nama} (${it.qty}x) = Rp ${formatRupiah(it.subtotal || (it.harga * it.qty))}`).join('\n');
  }

  const msg = 
`Halo Kak *${customerName}*, salam hangat dari *${storeName}* 😊

Kami ingin menginfokan rincian catatan bon / tagihan belanja Anda:
--------------------------------------------
🧾 *No. Transaksi:* #${tx.id}
📅 *Tanggal Belanja:* ${txDateStr}
⏰ *Jatuh Tempo:* ${dueDateStr}
💰 *Total Belanja:* Rp ${formatRupiah(tx.total || 0)}
💳 *Sisa Tagihan:* *Rp ${formatRupiah(sisa)}*
${itemsListText}
--------------------------------------------
Mohon kesediaannya untuk melakukan pembayaran sebelum atau pada tanggal jatuh tempo.

Pembayaran dapat dilakukan langsung di kasir toko atau via transfer.
Terima kasih banyak atas kepercayaannya berbelanja di toko kami! 🙏${storePhone}`;

  const waUrl = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

function openCustomerHistoryModal(customerId) {
  const c = customers.find(x => x.id === customerId);
  if (!c) return;

  currentActiveHistoryCustomerId = customerId;

  document.getElementById('cust-history-title').textContent = `Riwayat Belanja: ${c.nama}`;
  document.getElementById('cust-history-subtitle').textContent = `No. HP: ${c.telepon || '-'} | Alamat: ${c.domisili || '-'}`;

  const monthInput = document.getElementById('filter-cust-history-month');
  if (monthInput) monthInput.value = '';

  const searchInput = document.getElementById('cust-history-search-input');
  if (searchInput) searchInput.value = '';

  const daySelect = document.getElementById('cust-history-day');
  if (daySelect) daySelect.value = '';

  const sortSelect = document.getElementById('cust-history-sort');
  if (sortSelect) sortSelect.value = 'desc';

  refreshCustomerHistoryList();

  const modal = document.getElementById('customer-history-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeCustomerHistoryModal() {
  const modal = document.getElementById('customer-history-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
  currentActiveHistoryCustomerId = null;
}

function resetCustomerHistoryFilter() {
  const monthInput = document.getElementById('filter-cust-history-month');
  if (monthInput) monthInput.value = '';
  const searchInput = document.getElementById('cust-history-search-input');
  if (searchInput) searchInput.value = '';
  const daySelect = document.getElementById('cust-history-day');
  if (daySelect) daySelect.value = '';
  const sortSelect = document.getElementById('cust-history-sort');
  if (sortSelect) sortSelect.value = 'desc';
  refreshCustomerHistoryList();
}

function refreshCustomerHistoryList() {
  if (!currentActiveHistoryCustomerId) return;
  const c = customers.find(x => x.id === currentActiveHistoryCustomerId);
  if (!c) return;

  const container = document.getElementById('cust-history-list-container');
  if (!container) return;

  const selectedMonth = document.getElementById('filter-cust-history-month')?.value || '';
  const selectedDay = document.getElementById('cust-history-day')?.value || '';
  const searchKeyword = (document.getElementById('cust-history-search-input')?.value || '').trim().toLowerCase();
  const sortOrder = document.getElementById('cust-history-sort')?.value || 'desc';

  // Filter transaksi yang nama pelanggannya sesuai
  let memberTxs = transactions.filter(tx => tx.nama_pelanggan && tx.nama_pelanggan.toLowerCase() === c.nama.toLowerCase());

  if (selectedMonth) {
    memberTxs = memberTxs.filter(tx => tx.waktu && parseTxDateStr(tx.waktu).startsWith(selectedMonth));
  }

  // Filter berdasarkan tanggal tertentu (1 s/d 31)
  if (selectedDay) {
    const targetDay = parseInt(selectedDay, 10);
    memberTxs = memberTxs.filter(tx => {
      if (!tx.waktu) return false;
      const d = parseTxDate(tx.waktu);
      return d.getDate() === targetDay;
    });
  }

  // Filter pencarian berdasarkan nama produk atau nomor nota / ID transaksi
  if (searchKeyword) {
    memberTxs = memberTxs.filter(tx => {
      const matchTxId = tx.id && tx.id.toLowerCase().includes(searchKeyword);
      const matchItem = Array.isArray(tx.items) && tx.items.some(it => it.nama && it.nama.toLowerCase().includes(searchKeyword));
      return matchTxId || matchItem;
    });
  }

  // Sortir berdasarkan tanggal transaksi
  memberTxs.sort((a, b) => {
    const timeA = a.waktu ? parseTxDate(a.waktu).getTime() : 0;
    const timeB = b.waktu ? parseTxDate(b.waktu).getTime() : 0;
    return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
  });

  let grandTotal = 0;
  memberTxs.forEach(tx => grandTotal += (tx.total || 0));

  const grandTotalEl = document.getElementById('cust-history-grand-total');
  if (grandTotalEl) grandTotalEl.textContent = `Rp ${formatRupiah(grandTotal)}`;

  container.innerHTML = '';

  if (memberTxs.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 2.5rem 1rem;">
        <div style="display: flex; justify-content: center; margin-bottom: 0.5rem; color: #94a3b8;">
          <i data-lucide="shopping-bag" style="width: 38px; height: 38px;"></i>
        </div>
        <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">Belum Ada Riwayat Belanja</div>
        <div style="font-size: 0.8rem; margin-top: 0.25rem;">Tidak ada transaksi yang cocok dengan filter atau kata kunci pencarian.</div>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  memberTxs.forEach(tx => {
    const card = document.createElement('div');
    card.style.background = 'var(--bg-surface-elevated, #fff)';
    card.style.border = '1px solid var(--border-color)';
    card.style.borderRadius = '12px';
    card.style.padding = '1rem';
    card.style.marginBottom = '0.85rem';

    const tglStr = tx.waktu ? parseTxDate(tx.waktu).toLocaleString('id-ID', { hour12: false }) : '-';
    const isBon = (tx.sisa_piutang || 0) > 0;
    const statusBadge = isBon
      ? `<span style="font-size: 0.72rem; color: #dc2626; background: #fef2f2; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px;">Hutang / Bon (Sisa Rp ${formatRupiah(tx.sisa_piutang)})</span>`
      : `<span style="font-size: 0.72rem; color: #059669; background: #ecfdf5; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px;">Lunas</span>`;

    let itemsHtml = '';
    (tx.items || []).forEach(it => {
      const sub = (it.harga || 0) * (it.qty || 0);
      itemsHtml += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0; border-bottom: 1px dashed var(--border-color); font-size: 0.82rem;">
          <div>
            <strong style="color: var(--text-main);">${it.nama}</strong>
            <span style="color: var(--text-muted); margin-left: 0.35rem;">&times; ${it.qty}</span>
          </div>
          <span style="font-weight: 700; color: var(--text-main);">Rp ${formatRupiah(sub)}</span>
        </div>
      `;
    });

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.65rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
        <div>
          <span style="font-family: monospace; font-weight: 700; font-size: 0.82rem; color: #ea580c;">${tx.id}</span>
          <div style="font-size: 0.75rem; color: #64748b; margin-top: 1px; display: flex; align-items: center; gap: 4px;">
            <i data-lucide="calendar" style="width: 12px; height: 12px;"></i> ${tglStr}
          </div>
        </div>
        <div style="text-align: right;">
          ${statusBadge}
          <div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">Metode: ${tx.metode_pembayaran || 'Tunai'}</div>
        </div>
      </div>
      
      <div style="margin-bottom: 0.65rem;">
        ${itemsHtml}
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.9rem; font-weight: 800; border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
        <span>Total Belanja:</span>
        <span style="color: #ea580c;">Rp ${formatRupiah(tx.total || 0)}</span>
      </div>
    `;
    container.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

// 7. Pengingat Voucher ke WhatsApp Member (Tanpa Kadaluarsa, Pesan Custom)
function openVoucherWaReminderModal(customerId) {
  const c = customers.find(x => x.id === customerId);
  if (!c) return;

  const curMonth = getCurrentMonthKey();
  const vStats = getCustomerMonthlyVoucherStats(c, curMonth);

  document.getElementById('wa-reminder-cust-id').value = c.id;
  document.getElementById('wa-reminder-cust-name').textContent = c.nama;
  document.getElementById('wa-reminder-cust-phone').textContent = c.telepon ? `📞 ${c.telepon}` : '⚠️ Belum ada No HP';
  document.getElementById('wa-reminder-cust-vouchers').textContent = `${vStats.remaining} Voucher (Rp ${formatRupiah(vStats.remaining * (loyaltySettings.voucherRpValue || 10000))})`;

  // Siapkan teks default kustom sesuai format yang diminta
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : ((appConfig && appConfig.storeName) ? appConfig.storeName : 'Toko Kami');
  const rpTotal = vStats.remaining * (loyaltySettings.voucherRpValue || 10000);
  const voucherCountStr = `${vStats.remaining} voucher`;
  const voucherValStr = `Rp ${formatRupiah(rpTotal)}`;

  const defaultMsg = `Assalamualaikum Pak/Bu *${c.nama}*, kami dari *${storeName}* menginformasikan bahwa bapak/ibu masih memiliki *${voucherCountStr}* (senilai *${voucherValStr}*) yang belum digunakan.\n\nVoucher ini berlaku *tanpa batas kadaluarsa* dan bisa langsung ditukarkan kapan saja saat belanja di toko kami.\n\nDitunggu kehadirannya ya Pak/Bu, terima kasih! 🙏✨`;

  const textarea = document.getElementById('wa-reminder-message-text');
  if (textarea) textarea.value = defaultMsg;

  const modal = document.getElementById('voucher-wa-reminder-modal');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
  }
}

function closeVoucherWaReminderModal() {
  const modal = document.getElementById('voucher-wa-reminder-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
}

function resetVoucherWaDefaultMessage() {
  const custId = document.getElementById('wa-reminder-cust-id').value;
  const c = customers.find(x => x.id === custId);
  if (!c) return;

  const curMonth = getCurrentMonthKey();
  const vStats = getCustomerMonthlyVoucherStats(c, curMonth);
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : ((appConfig && appConfig.storeName) ? appConfig.storeName : 'Toko Kami');
  const rpTotal = vStats.remaining * (loyaltySettings.voucherRpValue || 10000);
  const voucherCountStr = `${vStats.remaining} voucher`;
  const voucherValStr = `Rp ${formatRupiah(rpTotal)}`;

  const defaultMsg = `Assalamualaikum Pak/Bu *${c.nama}*, kami dari *${storeName}* menginformasikan bahwa bapak/ibu masih memiliki *${voucherCountStr}* (senilai *${voucherValStr}*) yang belum digunakan.\n\nVoucher ini berlaku *tanpa batas kadaluarsa* dan bisa langsung ditukarkan kapan saja saat belanja di toko kami.\n\nDitunggu kehadirannya ya Pak/Bu, terima kasih! 🙏✨`;

  const textarea = document.getElementById('wa-reminder-message-text');
  if (textarea) textarea.value = defaultMsg;
}

function sendCustomVoucherWaMessage() {
  const custId = document.getElementById('wa-reminder-cust-id').value;
  const c = customers.find(x => x.id === custId);
  if (!c) return;

  if (!c.telepon) {
    alert("Pelanggan ini belum memiliki nomor telepon WhatsApp. Silakan edit nomor telepon pelanggan terlebih dahulu!");
    return;
  }

  const message = document.getElementById('wa-reminder-message-text')?.value || '';
  if (!message.trim()) {
    alert("Pesan WhatsApp tidak boleh kosong!");
    return;
  }

  // Bersihkan format nomor WA
  let cleanPhone = String(c.telepon).replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.slice(1);
  } else if (!cleanPhone.startsWith('62')) {
    cleanPhone = '62' + cleanPhone;
  }

  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
  window.open(waUrl, '_blank');
  closeVoucherWaReminderModal();
}


// ============================================================
// MODUL: IMPORT PELANGGAN MASSAL DARI EXCEL
// ============================================================

/**
 * Download file template Excel untuk import pelanggan massal.
 * Kolom: Nama Pelanggan, No Telepon, Domisili, Poin Awal
 */
function downloadCustomerExcelTemplate() {
  if (typeof XLSX === 'undefined') {
    alert('Library Excel belum termuat. Coba refresh halaman terlebih dahulu.');
    return;
  }

  const wsData = [
    ['TEMPLATE IMPORT DATA PELANGGAN MASSAL - TOKO KASIR'],
    ['Petunjuk: Isi data mulai baris ke-4. Jangan ubah nama kolom pada baris ke-3.'],
    ['Nama Pelanggan *', 'No Telepon', 'Domisili / Alamat', 'Poin Awal'],
    ['Budi Santoso', '08123456789', 'Surabaya', 100],
    ['Siti Rahayu', '08987654321', 'Malang', 250],
    ['Ahmad Fauzi', '085678901234', 'Sidoarjo', 0],
    ['Dewi Kusuma', '', 'Gresik', 50],
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 25 }, { wch: 12 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data Pelanggan');
  XLSX.writeFile(wb, 'template_import_pelanggan.xlsx');
}

/**
 * Import pelanggan dari file Excel / CSV yang dipilih user.
 */
function importCustomersFromExcel(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  if (typeof XLSX === 'undefined') {
    alert('Library Excel belum termuat. Refresh halaman dan coba lagi.');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Cari baris header
      let headerRowIdx = 0;
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const rowStr = rows[i].join('|').toLowerCase();
        if (rowStr.includes('nama pelanggan') || rowStr.includes('nama')) {
          headerRowIdx = i;
          break;
        }
      }

      const headerRow = rows[headerRowIdx].map(h => String(h).trim().toLowerCase());
      const dataRows = rows.slice(headerRowIdx + 1);

      const colNama     = findColIdx(headerRow, ['nama pelanggan', 'nama', 'name', 'pelanggan']);
      const colTelepon  = findColIdx(headerRow, ['no telepon', 'telepon', 'hp', 'no hp', 'phone', 'no. telepon']);
      const colDomisili = findColIdx(headerRow, ['domisili', 'alamat', 'address', 'kota']);
      const colPoin     = findColIdx(headerRow, ['poin awal', 'poin', 'points', 'point']);

      if (colNama === -1) {
        alert('Kolom "Nama Pelanggan" tidak ditemukan.\nUnduh file contoh terlebih dahulu dengan klik "Contoh Excel".');
        return;
      }

      let added = 0, skipped = 0;
      const skippedNames = [], addedNames = [];

      dataRows.forEach((row, i) => {
        const nama = String(row[colNama] || '').trim();
        if (!nama) return;

        const telepon  = colTelepon  !== -1 ? String(row[colTelepon]  || '').trim() : '';
        const domisili = colDomisili !== -1 ? String(row[colDomisili] || '').trim() : '';
        const poin     = colPoin     !== -1 ? (parseInt(row[colPoin]) || 0) : 0;

        const existing = customers.find(c => c.nama.toLowerCase() === nama.toLowerCase());
        if (existing) { skipped++; skippedNames.push(nama); return; }

        const newCust = {
          id: 'CUST-IMPORT-' + Date.now() + '-' + i,
          nama, telepon, domisili, poin,
          isVoucherEligible: true,
          voucherUsage: {}
        };
        customers.push(newCust);
        addedNames.push(nama);
        added++;
        saveCustomerCloud(newCust);
      });

      saveCustomersLocally();
      renderCustomersTable();

      const total = dataRows.filter(r => String(r[colNama] || '').trim()).length;
      showImportCustomerResult({ added, skipped, skippedNames, addedNames, total });

    } catch(err) {
      console.error('Import error:', err);
      alert('Gagal membaca file Excel.\nPastikan format file benar (.xlsx/.xls/.csv).\nDetail: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function findColIdx(headerRow, possibleNames) {
  for (const name of possibleNames) {
    const idx = headerRow.findIndex(h => h.includes(name));
    if (idx !== -1) return idx;
  }
  return -1;
}

function showImportCustomerResult({ added, skipped, skippedNames, addedNames, total }) {
  const modal = document.getElementById('import-customer-result-modal');
  const body  = document.getElementById('import-customer-result-body');
  if (!modal || !body) return;

  const skippedListHtml = skippedNames.length > 0
    ? `<ul style="margin:0.4rem 0 0 0;padding-left:1.2rem;font-size:0.82rem;color:#dc2626;">${skippedNames.map(n => `<li>${n}</li>`).join('')}</ul>`
    : '';
  const addedListHtml = addedNames.length > 0
    ? `<ul style="margin:0.4rem 0 0 0;padding-left:1.2rem;font-size:0.82rem;color:#059669;">${addedNames.map(n => `<li>${n}</li>`).join('')}</ul>`
    : '';

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
      <div style="background:#ecfdf5;border:1.5px solid #a7f3d0;border-radius:10px;padding:0.75rem;text-align:center;">
        <div style="font-size:1.8rem;font-weight:900;color:#059669;">${added}</div>
        <div style="font-size:0.78rem;font-weight:700;color:#065f46;">Berhasil Ditambah</div>
      </div>
      <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:0.75rem;text-align:center;">
        <div style="font-size:1.8rem;font-weight:900;color:#dc2626;">${skipped}</div>
        <div style="font-size:0.78rem;font-weight:700;color:#991b1b;">Dilewati (Duplikat)</div>
      </div>
      <div style="background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:10px;padding:0.75rem;text-align:center;">
        <div style="font-size:1.8rem;font-weight:900;color:#334155;">${total}</div>
        <div style="font-size:0.78rem;font-weight:700;color:#475569;">Total di File</div>
      </div>
    </div>
    ${added > 0 ? `<div style="margin-bottom:0.75rem;"><strong style="font-size:0.85rem;color:#059669;">✅ Pelanggan berhasil ditambahkan:</strong>${addedListHtml}</div>` : ''}
    ${skipped > 0 ? `<div><strong style="font-size:0.85rem;color:#dc2626;">⚠️ Dilewati (nama sudah terdaftar):</strong>${skippedListHtml}</div>` : ''}
    ${added === 0 && skipped === 0 ? '<p style="text-align:center;color:#64748b;">Tidak ada data yang ditemukan. Periksa format file.</p>' : ''}
  `;
  modal.style.display = 'flex';
}

function closeImportCustomerResultModal() {
  const m = document.getElementById('import-customer-result-modal');
  if (m) m.style.display = 'none';
}


// ============================================================
// MODUL: HUTANG MANUAL (Tanpa Transaksi Barang)
// ============================================================

function openManualDebtModal(editTxId) {
  const modal = document.getElementById('manual-debt-modal');
  if (!modal) return;

  const form = document.getElementById('manual-debt-form');
  if (form) form.reset();

  // Reset semua hidden fields dan state
  document.getElementById('manual-debt-edit-id').value = '';
  document.getElementById('manual-debt-member-id').value = '';
  document.getElementById('manual-debt-telepon').value = '';

  // Reset UI autocomplete
  const dropdown = document.getElementById('manual-debt-dropdown');
  const memberInfo = document.getElementById('manual-debt-member-info');
  const notFound = document.getElementById('manual-debt-notfound-warn');
  const clearBtn = document.getElementById('manual-debt-clear-btn');
  if (dropdown) dropdown.style.display = 'none';
  if (memberInfo) memberInfo.style.display = 'none';
  if (notFound) notFound.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';

  // Default tanggal hari ini (Zona Waktu Lokal)
  const today = getLocalISODate(new Date()).slice(0, 10);
  const tanggalEl = document.getElementById('manual-debt-tanggal');
  if (tanggalEl) tanggalEl.value = today;

  if (editTxId) {
    const tx = transactions.find(t => t.id === editTxId);
    if (tx) {
      document.getElementById('manual-debt-edit-id').value = tx.id;
      document.getElementById('manual-debt-nama').value    = tx.nama_pelanggan || '';
      document.getElementById('manual-debt-telepon').value = tx.telepon_pelanggan || '';
      document.getElementById('manual-debt-jumlah').value  = formatRupiah(tx.total || 0);
      document.getElementById('manual-debt-keterangan').value = tx.catatan_bon || tx.keterangan_manual || '';
      if (tanggalEl && tx.waktu) tanggalEl.value = tx.waktu.slice(0, 10);
      const jtEl = document.getElementById('manual-debt-jatuh-tempo');
      if (jtEl && tx.jatuh_tempo) jtEl.value = tx.jatuh_tempo;
      const dpPaid = (tx.total || 0) - (tx.sisa_piutang || 0);
      const dpEl = document.getElementById('manual-debt-dp');
      if (dpEl && dpPaid > 0) dpEl.value = formatRupiah(dpPaid);

      // Cari customer terkait dan set member-id
      if (tx.nama_pelanggan) {
        const cust = customers.find(c => c.nama.toLowerCase() === tx.nama_pelanggan.toLowerCase());
        if (cust) {
          document.getElementById('manual-debt-member-id').value = cust.id;
          selectManualDebtMember(cust, false);
        }
      }
    }
  }

  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('manual-debt-nama')?.focus(), 100);
}

// Autocomplete: saat user mengetik nama
function onManualDebtNameInput(val) {
  const dropdown = document.getElementById('manual-debt-dropdown');
  const memberInfo = document.getElementById('manual-debt-member-info');
  const notFound = document.getElementById('manual-debt-notfound-warn');
  const clearBtn = document.getElementById('manual-debt-clear-btn');
  const memberId = document.getElementById('manual-debt-member-id');

  // Jika sudah ada member terpilih dan teks tidak berubah, skip
  if (!dropdown) return;

  const query = (val || '').trim().toLowerCase();

  // Reset member terpilih saat user mengetik ulang
  if (memberId) memberId.value = '';
  if (memberInfo) memberInfo.style.display = 'none';
  if (notFound) notFound.style.display = 'none';
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';

  if (!query || query.length < 1) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  // Cari dari daftar customers
  const matches = customers.filter(c =>
    c.nama.toLowerCase().includes(query) ||
    (c.telepon && c.telepon.includes(query))
  ).slice(0, 8);

  if (matches.length === 0) {
    dropdown.innerHTML = `
      <div style="padding:0.75rem 1rem; font-size:0.83rem; color:#991b1b;">
        <strong>Tidak ditemukan</strong> — member belum terdaftar.
        <button type="button" onclick="closeManualDebtModal();openAddCustomerModal();" 
          style="display:block; margin-top:0.4rem; background:#ea580c; color:#fff; border:none; padding:0.3rem 0.7rem; border-radius:6px; font-size:0.78rem; font-weight:700; cursor:pointer; width:100%;">
          + Tambah Member Baru
        </button>
      </div>
    `;
    dropdown.style.display = 'block';
    if (notFound) notFound.style.display = 'block';
    return;
  }

  if (notFound) notFound.style.display = 'none';

  dropdown.innerHTML = matches.map(c => {
    const poin = loyaltySettings.rewardMode === 'voucher' ? '' : `<span style="font-size:0.72rem;color:#ea580c;margin-left:0.4rem;">${c.poin || 0} poin</span>`;
    return `
      <div onclick="selectManualDebtMember(${JSON.stringify({id:c.id,nama:c.nama,telepon:c.telepon||'',domisili:c.domisili||'',poin:c.poin||0}).replace(/"/g,'&quot;')})"
        style="padding:0.65rem 1rem; cursor:pointer; border-bottom:1px solid var(--border-color); display:flex; align-items:center; gap:0.75rem;"
        onmouseover="this.style.background='rgba(234,88,12,0.06)'" onmouseout="this.style.background=''"
      >
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#ea580c,#c2410c);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;flex-shrink:0;">
          ${c.nama.charAt(0).toUpperCase()}
        </div>
        <div>
          <div style="font-size:0.88rem;font-weight:700;color:var(--text-main);">${c.nama}${poin}</div>
          <div style="font-size:0.75rem;color:#64748b;">${c.telepon || 'No HP tidak ada'}${c.domisili ? ' · ' + c.domisili : ''}</div>
        </div>
      </div>
    `;
  }).join('');
  dropdown.style.display = 'block';

  // Tutup dropdown jika klik di luar
  setTimeout(() => {
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target.id !== 'manual-debt-nama') {
        dropdown.style.display = 'none';
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }, 100);
}

// Saat user memilih member dari dropdown
function selectManualDebtMember(custData, closeDropdown = true) {
  // custData bisa berupa object atau string JSON (dari onclick inline HTML)
  let c = custData;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch(e) { return; }
  }

  document.getElementById('manual-debt-nama').value    = c.nama;
  document.getElementById('manual-debt-telepon').value = c.telepon || '';
  document.getElementById('manual-debt-member-id').value = c.id;

  const dropdown = document.getElementById('manual-debt-dropdown');
  if (dropdown && closeDropdown) dropdown.style.display = 'none';

  const memberInfo = document.getElementById('manual-debt-member-info');
  if (memberInfo) {
    memberInfo.style.display = 'block';
    document.getElementById('manual-debt-info-nama').textContent = c.nama;
    document.getElementById('manual-debt-info-telp').textContent = c.telepon ? ('HP: ' + c.telepon) : '';
    document.getElementById('manual-debt-info-domisili').textContent = c.domisili ? ('Domisili: ' + c.domisili) : '';
    const poinEl = document.getElementById('manual-debt-info-poin');
    if (poinEl) poinEl.textContent = loyaltySettings.rewardMode === 'voucher' ? '' : (c.poin || 0) + ' poin';
  }

  const notFound = document.getElementById('manual-debt-notfound-warn');
  if (notFound) notFound.style.display = 'none';

  const clearBtn = document.getElementById('manual-debt-clear-btn');
  if (clearBtn) clearBtn.style.display = 'block';

  // Fokus ke field berikutnya
  setTimeout(() => document.getElementById('manual-debt-jumlah')?.focus(), 100);
}

// Hapus pilihan member
function clearManualDebtMember() {
  document.getElementById('manual-debt-nama').value = '';
  document.getElementById('manual-debt-telepon').value = '';
  document.getElementById('manual-debt-member-id').value = '';
  const memberInfo = document.getElementById('manual-debt-member-info');
  if (memberInfo) memberInfo.style.display = 'none';
  const notFound = document.getElementById('manual-debt-notfound-warn');
  if (notFound) notFound.style.display = 'none';
  const clearBtn = document.getElementById('manual-debt-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
  const dropdown = document.getElementById('manual-debt-dropdown');
  if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  document.getElementById('manual-debt-nama')?.focus();
}

function closeManualDebtModal() {
  const m = document.getElementById('manual-debt-modal');
  if (m) m.style.display = 'none';
}

function submitManualDebt(event) {
  if (event && event.preventDefault) event.preventDefault();

  const editId     = document.getElementById('manual-debt-edit-id').value.trim();
  const memberId   = document.getElementById('manual-debt-member-id').value.trim();
  const nama       = document.getElementById('manual-debt-nama').value.trim();
  const telepon    = document.getElementById('manual-debt-telepon').value.trim();
  const jumlahStr  = (document.getElementById('manual-debt-jumlah').value || '0').replace(/\./g, '');
  const keterangan = document.getElementById('manual-debt-keterangan').value.trim();
  const tanggal    = document.getElementById('manual-debt-tanggal').value || getLocalISODate(new Date()).slice(0, 10);
  const jatuhTempo = document.getElementById('manual-debt-jatuh-tempo').value || null;
  const dpStr      = (document.getElementById('manual-debt-dp').value || '0').replace(/\./g, '');

  const jumlah = parseFloat(jumlahStr) || 0;
  const dp     = parseFloat(dpStr)     || 0;

  if (!nama) {
    alert('Nama pelanggan wajib diisi! Ketik nama lalu pilih dari daftar member.');
    document.getElementById('manual-debt-nama')?.focus();
    return;
  }

  // Validasi wajib pilih dari member terdaftar
  if (!memberId) {
    // Cek apakah nama yang diketik cocok dengan member yang ada
    const matchedCust = customers.find(c => c.nama.toLowerCase() === nama.toLowerCase());
    if (matchedCust) {
      // Auto-select jika nama cocok persis
      selectManualDebtMember(matchedCust, true);
      document.getElementById('manual-debt-member-id').value = matchedCust.id;
    } else {
      const notFound = document.getElementById('manual-debt-notfound-warn');
      if (notFound) notFound.style.display = 'block';
      const namaInput = document.getElementById('manual-debt-nama');
      if (namaInput) {
        namaInput.style.borderColor = '#dc2626';
        namaInput.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.15)';
        setTimeout(() => { namaInput.style.borderColor = ''; namaInput.style.boxShadow = ''; }, 3000);
      }
      alert('Pelanggan "' + nama + '" belum terdaftar sebagai member!\nSilakan tambah member baru terlebih dahulu atau pilih nama dari daftar yang muncul.');
      document.getElementById('manual-debt-nama')?.focus();
      return;
    }
  }

  if (jumlah <= 0){ alert('Jumlah hutang harus lebih dari Rp 0!'); return; }
  if (!keterangan){ alert('Keterangan / jenis hutang wajib diisi!'); return; }

  const sisaPiutang = Math.max(0, jumlah - dp);
  const now = new Date(tanggal + 'T' + new Date().toTimeString().slice(0, 8));

  if (editId) {
    const tx = transactions.find(t => t.id === editId);
    if (tx) {
      tx.nama_pelanggan    = nama;
      tx.telepon_pelanggan = telepon;
      tx.total             = jumlah;
      tx.bayar             = dp;
      tx.sisa_piutang      = sisaPiutang;
      tx.status_pembayaran = sisaPiutang > 0 ? 'Bon' : 'Lunas';
      tx.catatan_bon       = keterangan;
      tx.keterangan_manual = keterangan;
      tx.jatuh_tempo       = jatuhTempo;
      tx.is_manual_debt    = true;
      saveTransactionsLocally();
      syncSingleTransactionToCloud(tx);
      alert(`Hutang manual "${nama}" berhasil diperbarui!`);
    }
  } else {
    const fundSource = document.getElementById('manual-debt-fund-source')?.value || 'saldo_penjualan';
    const ymd = now.getFullYear().toString().slice(-2) +
                String(now.getMonth() + 1).padStart(2, '0') +
                String(now.getDate()).padStart(2, '0');
    const hms = String(now.getHours()).padStart(2, '0') +
                String(now.getMinutes()).padStart(2, '0') +
                String(now.getSeconds()).padStart(2, '0');
    const txId = `MANUAL-${ymd}-${hms}`;
    const tx = {
      id: txId,
      waktu: now.toISOString(),
      items: [],               // Kosong — tidak ada barang
      total: jumlah,
      bayar: dp,
      kembalian: 0,
      metode_pembayaran: 'Manual',
      kasir: activeCashier || 'Admin',
      status_pembayaran: sisaPiutang > 0 ? 'Bon' : 'Lunas',
      nama_pelanggan: nama,
      telepon_pelanggan: telepon,
      sisa_piutang: sisaPiutang,
      jatuh_tempo: jatuhTempo,
      catatan_bon: keterangan + (fundSource === 'dana_lain' ? ' [Keluar dari Dana Luar]' : ' [Memotong Saldo Kasir]'),
      keterangan_manual: keterangan,
      sumber_dana: fundSource,
      is_manual_debt: true,    // Flag: bukan transaksi jual beli
      riwayat_pelunasan: dp > 0 ? [{
        waktu: now.toISOString(),
        bayar: dp,
        metode: 'Tunai',
        kasir: activeCashier || 'Admin',
        catatan: 'DP / Uang Muka Awal'
      }] : []
    };

    transactions.unshift(tx);
    saveTransactionsLocally();
    syncSingleTransactionToCloud(tx);

    alert('Hutang manual berhasil dicatat!\n- Debitur: ' + nama + '\n- Jumlah: Rp ' + formatRupiah(jumlah) + '\n- Sisa: Rp ' + formatRupiah(sisaPiutang) + '\n- Keterangan: ' + keterangan);
  }

  closeManualDebtModal();
  renderCustomerDebtBook();
  updateAnalytics();
}

/**
 * Export seluruh data pelanggan ke format file Excel (.xlsx)
 */
function exportCustomersToExcel() {
  if (typeof XLSX === 'undefined') {
    alert('Library Excel belum siap. Silakan refresh halaman dan coba kembali.');
    return;
  }

  if (!Array.isArray(customers) || customers.length === 0) {
    alert('Belum ada data pelanggan untuk diexport.');
    return;
  }

  const exportRows = [
    ['DAFTAR DATA MEMBER & PELANGGAN - ' + ((receiptSettings && receiptSettings.name) || 'KASIR POS')],
    ['Waktu Export: ' + new Date().toLocaleString('id-ID')],
    ['No', 'ID Member', 'Nama Pelanggan', 'No Telepon', 'Domisili / Alamat', 'Total Poin', 'Jumlah Transaksi', 'Total Belanja (Rp)']
  ];

  customers.forEach((c, idx) => {
    exportRows.push([
      idx + 1,
      c.id || '-',
      c.nama || '-',
      c.telepon || '-',
      c.domisili || c.alamat || '-',
      Number(c.poin) || 0,
      Number(c.total_transaksi) || 0,
      Number(c.total_belanja) || 0
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(exportRows);
  ws['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 28 },
    { wch: 18 },
    { wch: 28 },
    { wch: 14 },
    { wch: 18 },
    { wch: 20 }
  ];
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data Pelanggan');

  const todayStr = getLocalISODate ? getLocalISODate(new Date()).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const fileName = `Data_Pelanggan_${todayStr}.xlsx`;
  XLSX.writeFile(wb, fileName);
}


// ═════════════════════════════════════════════════════════════════════════════
// 1. MODUL BIAYA OPERASIONAL & KAS KECIL (EXPENSES & PETTY CASH)
// ═════════════════════════════════════════════════════════════════════════════

function openExpenseModal(type = 'keluar', editId = null) {
  if (!canPerformAction('expenses')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk mengelola Biaya & Kas Kecil!");
    return;
  }

  const modal = document.getElementById('expense-modal');
  const header = document.getElementById('expense-modal-header');
  const title = document.getElementById('expense-modal-title');
  const submitBtn = document.getElementById('btn-submit-expense');
  const typeInput = document.getElementById('expense-type');
  const editIdInput = document.getElementById('expense-edit-id');
  const dateInput = document.getElementById('expense-date');
  const amountInput = document.getElementById('expense-amount');
  const catInput = document.getElementById('expense-category');
  const sourceInput = document.getElementById('expense-fund-source');
  const notesInput = document.getElementById('expense-notes');
  const photoInput = document.getElementById('expense-receipt-photo');

  if (!modal) return;

  editIdInput.value = editId || '';
  typeInput.value = type;

  const now = new Date();
  dateInput.value = now.toISOString().slice(0, 10);

  const categoriesMasuk = [
    { value: 'Kas Masuk Modal', label: 'Kas Masuk Modal Tunai' },
    { value: 'Dana Bantuan / Hibah', label: 'Dana Bantuan / Hibah / Subsidi' },
    { value: 'Pinjaman / Utang Masuk', label: 'Pinjaman / Modal Tambahan Masuk' },
    { value: 'Pendapatan Jasa / Komisi', label: 'Pendapatan Jasa / Komisi / Titipan' },
    { value: 'Pendapatan Lain-lain', label: 'Pemasukan Lain-lain' }
  ];

  const categoriesKeluar = [
    { value: 'Listrik & Air', label: 'Listrik & Air' },
    { value: 'Gaji / Upah', label: 'Gaji / Upah Karyawan' },
    { value: 'Perlengkapan Toko', label: 'Perlengkapan Toko (Plastik, Kertas, dll)' },
    { value: 'Konsumsi & Dapur', label: 'Konsumsi & Dapur Toko' },
    { value: 'Transport / Bensin', label: 'Transport / Bensin' },
    { value: 'Sewa Tempat', label: 'Sewa Tempat / Ruko' },
    { value: 'Lain-lain', label: 'Lain-lain' }
  ];

  const activeCategoryList = (type === 'masuk') ? categoriesMasuk : categoriesKeluar;
  catInput.innerHTML = activeCategoryList.map(c => `<option value="${c.value}">${c.label}</option>`).join('');

  const sourceLabelEl = document.getElementById('expense-fund-source-label');
  const sourceHelpEl = document.getElementById('expense-fund-source-help');

  if (type === 'masuk') {
    header.style.background = 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)';
    title.textContent = editId ? 'Edit Kas Masuk / Modal' : 'Catat Kas Masuk / Tambah Modal';
    submitBtn.style.background = '#16a34a';
    submitBtn.style.borderColor = '#16a34a';
    submitBtn.textContent = 'Simpan Kas Masuk';
    catInput.value = 'Kas Masuk Modal';

    if (sourceLabelEl) sourceLabelEl.textContent = 'Rekening Tujuan / Masuk Kas Ke*';
    if (sourceHelpEl) sourceHelpEl.textContent = 'Pilih apakah uang kas masuk disetor ke laci kasir (menambah saldo laci) atau rekening bank/dana lain.';

    sourceInput.innerHTML = `
      <option value="laci_kasir">Setor ke Laci Kasir (Menambah Saldo Fisik Laci / Modal Kerja)</option>
      <option value="transfer_bank">Masuk ke Rekening Bank / Non-Tunai</option>
      <option value="dana_luar">Kas Pribadi / Kas Cadangan Luar (Tidak Masuk Laci Kasir)</option>
    `;
  } else {
    header.style.background = 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
    title.textContent = editId ? 'Edit Biaya Pengeluaran' : 'Catat Pengeluaran Operasional';
    submitBtn.style.background = '#dc2626';
    submitBtn.style.borderColor = '#dc2626';
    submitBtn.textContent = 'Simpan Biaya';
    catInput.value = 'Listrik & Air';

    if (sourceLabelEl) sourceLabelEl.textContent = 'Sumber Dana / Rekening Asal*';
    if (sourceHelpEl) sourceHelpEl.textContent = 'Pilih apakah pengeluaran ini diambil dari laci kasir (memotong saldo kasir) atau dana lain.';

    sourceInput.innerHTML = `
      <option value="laci_kasir">Ambil dari Laci Kasir (Memotong Saldo Kasir Shift Ini)</option>
      <option value="transfer_bank">Transfer Bank / Non-Tunai</option>
      <option value="dana_luar">Dana Luar / Kas Pribadi Owner (Tidak Memotong Laci Kasir)</option>
    `;
  }

  if (editId) {
    const item = expenses.find(x => x.id === editId);
    if (item) {
      dateInput.value = item.tanggal ? item.tanggal.slice(0, 10) : dateInput.value;
      amountInput.value = formatRupiah(item.nominal || 0);
      // Jika kategori lama tidak ada di dropdown (custom), tambahkan agar tidak hilang
      if (!Array.from(catInput.options).some(o => o.value === item.kategori)) {
        const customOpt = document.createElement('option');
        customOpt.value = item.kategori;
        customOpt.textContent = item.kategori;
        catInput.appendChild(customOpt);
      }
      catInput.value = item.kategori || activeCategoryList[0].value;
      sourceInput.value = item.sumberDana || 'laci_kasir';
      notesInput.value = item.keterangan || '';
      photoInput.value = item.fotoNota || '';
    }
  } else {
    amountInput.value = '';
    notesInput.value = '';
    photoInput.value = '';
    sourceInput.value = 'laci_kasir';
  }

  modal.style.display = 'flex';
}

function closeExpenseModal() {
  const modal = document.getElementById('expense-modal');
  if (modal) modal.style.display = 'none';
}

function submitExpenseForm(event) {
  event.preventDefault();

  const editId = document.getElementById('expense-edit-id').value;
  const type = document.getElementById('expense-type').value;
  const dateVal = document.getElementById('expense-date').value;
  const amountStr = document.getElementById('expense-amount').value.replace(/\./g, '');
  const amount = parseFloat(amountStr) || 0;
  const category = document.getElementById('expense-category').value;
  const source = document.getElementById('expense-fund-source').value;
  const notes = document.getElementById('expense-notes').value.trim();
  const photo = document.getElementById('expense-receipt-photo').value.trim();

  if (amount <= 0) {
    alert("Nominal harus lebih dari Rp 0!");
    return;
  }
  if (!notes) {
    alert("Keterangan wajib diisi!");
    return;
  }

  const now = new Date();
  const fullDate = dateVal ? new Date(dateVal + 'T' + now.toTimeString().slice(0, 8)).toISOString() : now.toISOString();

  if (editId) {
    const idx = expenses.findIndex(x => x.id === editId);
    if (idx !== -1) {
      expenses[idx] = {
        ...expenses[idx],
        tipe: type,
        tanggal: fullDate,
        kategori: category,
        nominal: amount,
        sumberDana: source,
        keterangan: notes,
        fotoNota: photo,
        pencatat: activeCashier || 'Admin'
      };
      alert("Catatan kas berhasil diperbarui!");
    }
  } else {
    const ymd = now.getFullYear().toString().slice(-2) +
                String(now.getMonth() + 1).padStart(2, '0') +
                String(now.getDate()).padStart(2, '0');
    const hms = String(now.getHours()).padStart(2, '0') +
                String(now.getMinutes()).padStart(2, '0') +
                String(now.getSeconds()).padStart(2, '0');
    const newEntry = {
      id: `EXP-${ymd}-${hms}`,
      tipe: type,
      tanggal: fullDate,
      kategori: category,
      nominal: amount,
      sumberDana: source,
      keterangan: notes,
      fotoNota: photo,
      pencatat: activeCashier || 'Admin',
      id_shift: activeShift ? activeShift.id_shift : null
    };
    expenses.unshift(newEntry);
    alert(`✅ ${type === 'masuk' ? 'Kas Masuk' : 'Pengeluaran'} sebesar Rp ${formatRupiah(amount)} berhasil disimpan!`);
  }

  saveExpensesLocally();
  syncExpensesToCloud();
  closeExpenseModal();
  renderExpensesTable();
}

function deleteExpense(id) {
  if (!canPerformAction('expenses')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk mengelola Biaya & Kas Kecil!");
    return;
  }

  const item = expenses.find(x => x.id === id);
  if (!item) return;

  if (confirm(`Hapus catatan kas "${item.keterangan}" sebesar Rp ${formatRupiah(item.nominal)}?`)) {
    expenses = expenses.filter(x => x.id !== id);
    saveExpensesLocally();
    syncExpensesToCloud();
    renderExpensesTable();
  }
}

function saveExpensesLocally() {
  localStorage.setItem('kasir_expenses', JSON.stringify(expenses));
}

function syncExpensesToCloud() {
  if (firebaseDb) {
    firebaseDb.ref(getStorePath('expenses')).set(expenses).catch(err => {
      console.error("Gagal sinkron expenses ke cloud:", err);
    });
  }
}

function renderExpensesTable() {
  const tbody = document.getElementById('expenses-table-body');
  if (!tbody) return;

  const searchVal = (document.getElementById('expense-search')?.value || '').toLowerCase().trim();
  const typeFilter = document.getElementById('expense-filter-type')?.value || 'ALL';
  const catFilter = document.getElementById('expense-filter-category')?.value || 'ALL';
  const startFilter = document.getElementById('expense-filter-start')?.value || '';
  const endFilter = document.getElementById('expense-filter-end')?.value || '';

  let totalOutMonth = 0;
  let countOutMonth = 0;
  let totalInMonth = 0;
  let countInMonth = 0;
  let cashierOutMonth = 0;

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);

  expenses.forEach(e => {
    const isCurrentMonth = e.tanggal && e.tanggal.startsWith(currentMonthPrefix);
    if (isCurrentMonth) {
      if (e.tipe === 'masuk') {
        totalInMonth += (e.nominal || 0);
        countInMonth++;
      } else {
        totalOutMonth += (e.nominal || 0);
        countOutMonth++;
        if (e.sumberDana === 'laci_kasir') {
          cashierOutMonth += (e.nominal || 0);
        }
      }
    }
  });

  const elOut = document.getElementById('expense-summary-total-out');
  const elOutCount = document.getElementById('expense-summary-count-out');
  const elIn = document.getElementById('expense-summary-total-in');
  const elInCount = document.getElementById('expense-summary-count-in');
  const elCashier = document.getElementById('expense-summary-cashier-out');

  if (elOut) elOut.textContent = `Rp ${formatRupiah(totalOutMonth)}`;
  if (elOutCount) elOutCount.textContent = `${countOutMonth} Pengeluaran tercatat`;
  if (elIn) elIn.textContent = `Rp ${formatRupiah(totalInMonth)}`;
  if (elInCount) elInCount.textContent = `${countInMonth} Kas masuk tercatat`;
  if (elCashier) elCashier.textContent = `Rp ${formatRupiah(cashierOutMonth)}`;

  const filtered = expenses.filter(e => {
    if (typeFilter !== 'ALL' && e.tipe !== typeFilter) return false;
    if (catFilter !== 'ALL' && e.kategori !== catFilter) return false;
    if (startFilter && e.tanggal && e.tanggal.slice(0, 10) < startFilter) return false;
    if (endFilter && e.tanggal && e.tanggal.slice(0, 10) > endFilter) return false;

    if (searchVal) {
      const matchNotes = (e.keterangan || '').toLowerCase().includes(searchVal);
      const matchCat = (e.kategori || '').toLowerCase().includes(searchVal);
      const matchUser = (e.pencatat || '').toLowerCase().includes(searchVal);
      if (!matchNotes && !matchCat && !matchUser) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Belum ada catatan pengeluaran/kas masuk yang sesuai.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(e => {
    const isMasuk = e.tipe === 'masuk';
    const typeBadge = isMasuk
      ? `<span style="background:rgba(22,163,74,0.12); color:#16a34a; font-weight:700; padding:2px 8px; border-radius:6px; font-size:0.75rem;">+ Kas Masuk</span>`
      : `<span style="background:rgba(220,38,38,0.12); color:#dc2626; font-weight:700; padding:2px 8px; border-radius:6px; font-size:0.75rem;">- Pengeluaran</span>`;

    const sourceLabel = e.sumberDana === 'laci_kasir'
      ? '<span style="color:#ea580c; font-weight:600;">Laci Kasir</span>'
      : (e.sumberDana === 'dana_luar' ? '<span style="color:#0284c7; font-weight:600;">Dana Pribadi / Luar</span>' : '<span style="color:#7c3aed; font-weight:600;">Transfer Bank</span>');

    const photoBtn = e.fotoNota
      ? `<button type="button" class="btn btn-secondary btn-sm" onclick="openProductImageLightbox('${e.fotoNota}', 'Bukti Nota: ${e.keterangan}')" style="padding:2px 6px; font-size:0.75rem;">Lihat</button>`
      : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';

    return `
      <tr>
        <td style="font-size:0.82rem;">${e.tanggal ? new Date(e.tanggal).toLocaleString('id-ID') : '-'}</td>
        <td>${typeBadge}</td>
        <td><strong>${e.kategori || '-'}</strong></td>
        <td>${e.keterangan || '-'}</td>
        <td>${sourceLabel}</td>
        <td style="text-align:right; font-weight:800; color:${isMasuk ? '#16a34a' : '#dc2626'};">
          ${isMasuk ? '+' : '-'} Rp ${formatRupiah(e.nominal || 0)}
        </td>
        <td style="font-size:0.82rem;">${e.pencatat || 'Admin'}</td>
        <td style="text-align:center;">${photoBtn}</td>
        <td style="text-align:center;">
          <div style="display:flex; gap:0.3rem; justify-content:center;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openExpenseModal('${e.tipe}', '${e.id}')" style="padding:2px 6px; font-size:0.75rem;">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')" style="padding:2px 6px; font-size:0.75rem;">Hapus</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function exportExpensesToExcel() {
  if (typeof XLSX === 'undefined') {
    alert("Library Excel belum siap!");
    return;
  }
  if (expenses.length === 0) {
    alert("Belum ada data pengeluaran untuk diekspor!");
    return;
  }

  const rows = [
    ['BUKU KAS KECIL & BIAYA OPERASIONAL - ' + (receiptSettings.name || 'TOKO SAHIL')],
    ['Waktu Export: ' + new Date().toLocaleString('id-ID')],
    ['No', 'ID Transaksi', 'Tanggal', 'Jenis', 'Kategori', 'Keterangan', 'Sumber Dana', 'Nominal (Rp)', 'Pencatat']
  ];

  expenses.forEach((e, i) => {
    rows.push([
      i + 1,
      e.id,
      e.tanggal ? new Date(e.tanggal).toLocaleString('id-ID') : '',
      e.tipe === 'masuk' ? 'Kas Masuk' : 'Pengeluaran',
      e.kategori,
      e.keterangan,
      e.sumberDana,
      e.nominal,
      e.pencatat
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Kas Kecil');
  XLSX.writeFile(wb, `Laporan_Kas_Kecil_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ═════════════════════════════════════════════════════════════════════════════
// MODUL LAPORAN LABA / RUGI BERSIH RIIL (INCOME STATEMENT / P&L)
// ═════════════════════════════════════════════════════════════════════════════

let currentProfitLossData = null;

function calculateProfitLossData() {
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  const filteredTxs = (typeof getAnalyticsFilteredTxs === 'function') ? getAnalyticsFilteredTxs() : transactions;

  let periodText = 'Hari Ini';
  let datePrefix = '';
  if (filterType === 'hari') {
    const dateVal = document.getElementById('analytics-filter-date')?.value || getLocalISODate(new Date()).slice(0, 10);
    periodText = `Hari Ini (${dateVal})`;
    datePrefix = dateVal;
  } else if (filterType === 'bulan') {
    const monthVal = document.getElementById('analytics-filter-month')?.value || getLocalISODate(new Date()).slice(0, 7);
    periodText = `Bulan (${monthVal})`;
    datePrefix = monthVal;
  } else if (filterType === 'tahun') {
    const yearVal = document.getElementById('analytics-filter-year')?.value || String(new Date().getFullYear());
    periodText = `Tahun ${yearVal}`;
    datePrefix = yearVal;
  } else {
    periodText = 'Semua Waktu';
    datePrefix = '';
  }

  // 1. Hitung Omset Penjualan Bersih Kasir & HPP (Modal Barang Terjual)
  let totalOmset = 0;
  let totalHpp = 0;

  filteredTxs.forEach(tx => {
    totalOmset += (Number(tx.total) || 0);

    if (Array.isArray(tx.items)) {
      tx.items.forEach(item => {
        const buyPrice = Number(item.harga_beli) || 0;
        const qty = Number(item.qty) || 1;
        totalHpp += (buyPrice * qty);
      });
    }
  });

  const labaKotor = Math.max(0, totalOmset - totalHpp);

  // 2. Hitung Pengeluaran Kas Kecil & Kas Masuk pada periode ini
  let totalExpenses = 0;
  let totalCashIn = 0;
  const expenseCatMap = {};

  if (Array.isArray(expenses)) {
    expenses.forEach(e => {
      const eDate = e.tanggal ? parseTxDateStr(e.tanggal) : '';
      let match = false;
      if (!datePrefix) {
        match = true;
      } else {
        match = eDate.startsWith(datePrefix);
      }

      if (match) {
        const nominal = Number(e.nominal) || 0;
        if (e.tipe === 'masuk') {
          totalCashIn += nominal;
        } else {
          totalExpenses += nominal;
          const cat = e.kategori || 'Lain-lain';
          expenseCatMap[cat] = (expenseCatMap[cat] || 0) + nominal;
        }
      }
    });
  }

  // 3. Laba Bersih Riil = Laba Kotor - Beban Biaya Operasional
  const labaBersihRiil = labaKotor - totalExpenses;
  const marginPercent = totalOmset > 0 ? ((labaBersihRiil / totalOmset) * 100).toFixed(1) : 0;

  return {
    periodText,
    totalOmset,
    totalHpp,
    labaKotor,
    totalExpenses,
    totalCashIn,
    expenseCatMap,
    labaBersihRiil,
    marginPercent,
    txCount: filteredTxs.length
  };
}

function openProfitLossModal() {
  const modal = document.getElementById('profit-loss-modal');
  if (!modal) return;

  const data = calculateProfitLossData();
  currentProfitLossData = data;

  // Update Header Subtitle
  const subEl = document.getElementById('pl-period-subtitle');
  if (subEl) subEl.textContent = `Periode: ${data.periodText}`;

  // Update Banner Utama
  const netValEl = document.getElementById('pl-net-profit-val');
  const netBanner = document.getElementById('pl-net-banner');
  const marginEl = document.getElementById('pl-profit-margin-text');

  if (netValEl) {
    netValEl.textContent = `${data.labaBersihRiil < 0 ? '-' : ''}Rp ${formatRupiah(Math.abs(data.labaBersihRiil))}`;
    netValEl.style.color = data.labaBersihRiil >= 0 ? '#047857' : '#dc2626';
  }

  if (netBanner) {
    if (data.labaBersihRiil >= 0) {
      netBanner.style.background = 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)';
      netBanner.style.borderColor = '#a7f3d0';
    } else {
      netBanner.style.background = 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)';
      netBanner.style.borderColor = '#fecaca';
    }
  }

  if (marginEl) {
    marginEl.textContent = `Margin Keuntungan Bersih: ${data.marginPercent}% (dari ${data.txCount} transaksi)`;
    marginEl.style.color = data.labaBersihRiil >= 0 ? '#059669' : '#dc2626';
  }

  // Update Bagian 1: Pendapatan
  const totalSalesEl = document.getElementById('pl-total-sales');
  const salesGrossEl = document.getElementById('pl-sales-gross');
  const cashInEl = document.getElementById('pl-cash-in');

  if (totalSalesEl) totalSalesEl.textContent = `Rp ${formatRupiah(data.totalOmset)}`;
  if (salesGrossEl) salesGrossEl.textContent = `Rp ${formatRupiah(data.totalOmset)}`;
  if (cashInEl) cashInEl.textContent = `+ Rp ${formatRupiah(data.totalCashIn)}`;

  // Update Bagian 2: HPP
  const totalHppEl = document.getElementById('pl-total-hpp');
  const cogsValEl = document.getElementById('pl-cogs-val');
  const grossValEl = document.getElementById('pl-gross-profit-val');

  if (totalHppEl) totalHppEl.textContent = `- Rp ${formatRupiah(data.totalHpp)}`;
  if (cogsValEl) cogsValEl.textContent = `Rp ${formatRupiah(data.totalHpp)}`;
  if (grossValEl) grossValEl.textContent = `Rp ${formatRupiah(data.labaKotor)}`;

  // Update Bagian 3: Biaya Operasional
  const totalExpEl = document.getElementById('pl-total-expenses');
  const expBreakdownEl = document.getElementById('pl-expenses-breakdown');

  if (totalExpEl) totalExpEl.textContent = `- Rp ${formatRupiah(data.totalExpenses)}`;
  if (expBreakdownEl) {
    const cats = Object.keys(data.expenseCatMap);
    if (cats.length === 0) {
      expBreakdownEl.innerHTML = `<div style="color: var(--text-muted); font-style: italic;">Tidak ada catatan biaya operasional di periode ini.</div>`;
    } else {
      expBreakdownEl.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 0.35rem;">
          ${cats.map(c => `
            <div style="display: flex; justify-content: space-between; color: var(--text-muted);">
              <span>• Biaya ${c}:</span>
              <span style="font-weight: 600; color: #dc2626;">Rp ${formatRupiah(data.expenseCatMap[c])}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    try { lucide.createIcons(); } catch(e) {}
  }
}

function closeProfitLossModal() {
  const modal = document.getElementById('profit-loss-modal');
  if (modal) modal.style.display = 'none';
}

function printProfitLossStatement() {
  const d = currentProfitLossData || calculateProfitLossData();
  const storeName = (receiptSettings && receiptSettings.name) || 'KASIR POS';
  const storeAddress = (receiptSettings && receiptSettings.address) || '';
  const nowStr = new Date().toLocaleString('id-ID');

  let expRows = '';
  const cats = Object.keys(d.expenseCatMap);
  if (cats.length === 0) {
    expRows = `<tr><td colspan="2" style="padding: 4px 0; color: #666; font-style: italic;">(Nihil Biaya Operasional)</td></tr>`;
  } else {
    cats.forEach(c => {
      expRows += `
        <tr>
          <td style="padding: 3px 0;">• Biaya ${c}</td>
          <td style="padding: 3px 0; text-align: right; color: #b91c1c;">Rp ${formatRupiah(d.expenseCatMap[c])}</td>
        </tr>
      `;
    });
  }

  const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Laporan Laba Rugi - ${d.periodText}</title>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Courier New', Courier, monospace, sans-serif; max-width: 480px; margin: 0 auto; padding: 18px; color: #000; font-size: 12px; }
        .divider { border-top: 1px dashed #000; margin: 8px 0; }
        .double-divider { border-top: 2px dashed #000; margin: 8px 0; }
        .header { text-align: center; margin-bottom: 12px; }
        .header h2 { margin: 0 0 4px 0; font-size: 16px; }
        .flex { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
        table { width: 100%; border-collapse: collapse; margin-top: 4px; }
        .sec-title { font-weight: bold; background: #eee; padding: 4px 6px; margin-top: 8px; font-size: 11px; }
        .sign { display: flex; justify-content: space-between; text-align: center; margin-top: 35px; font-size: 11px; }
        @media print { body { padding: 5px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>${storeName}</h2>
        <div>${storeAddress}</div>
        <div class="double-divider"></div>
        <div style="font-weight: bold; font-size: 13px; margin: 4px 0;">LAPORAN LABA / RUGI BERSIH (P&amp;L)</div>
        <div style="font-size: 11px;">Periode: ${d.periodText}</div>
        <div style="font-size: 10px; color: #444;">Waktu Cetak: ${nowStr}</div>
      </div>

      <div class="sec-title">1. PENDAPATAN PENJUALAN</div>
      <div class="flex" style="padding-top: 4px;"><span>Total Omset Penjualan Bersih:</span><strong>Rp ${formatRupiah(d.totalOmset)}</strong></div>
      <div class="flex"><span>Kas Masuk / Modal:</span><span>+ Rp ${formatRupiah(d.totalCashIn)}</span></div>

      <div class="sec-title">2. BEBAN POKOK PENJUALAN (HPP)</div>
      <div class="flex" style="padding-top: 4px;"><span>Modal Kulak Barang Terjual:</span><span>- Rp ${formatRupiah(d.totalHpp)}</span></div>
      <div class="divider"></div>
      <div class="flex" style="font-weight: bold;"><span>= LABA KOTOR PENJUALAN:</span><span>Rp ${formatRupiah(d.labaKotor)}</span></div>

      <div class="sec-title">3. BIAYA OPERASIONAL TOKO</div>
      <table>
        ${expRows}
        <tr style="font-weight: bold; border-top: 1px dotted #000;">
          <td style="padding-top: 4px;">Total Biaya Operasional:</td>
          <td style="padding-top: 4px; text-align: right; color: #b91c1c;">- Rp ${formatRupiah(d.totalExpenses)}</td>
        </tr>
      </table>

      <div class="double-divider"></div>
      <div class="flex" style="font-size: 14px; font-weight: 900; margin: 6px 0;">
        <span>LABA BERSIH RIIL:</span>
        <span style="color: ${d.labaBersihRiil >= 0 ? '#059669' : '#dc2626'};">${d.labaBersihRiil < 0 ? '-' : ''}Rp ${formatRupiah(Math.abs(d.labaBersihRiil))}</span>
      </div>
      <div class="flex" style="font-size: 11px; font-style: italic;">
        <span>Persentase Margin Bersih:</span>
        <span>${d.marginPercent}%</span>
      </div>
      <div class="double-divider"></div>

      <div class="sign">
        <div>Dibuat Oleh Kasir:<br><br><br><br>( ${activeCashier || 'Admin'} )</div>
        <div>Mengetahui Pemilik/Owner:<br><br><br><br>( ................................ )</div>
      </div>
    </body>
    </html>
  `;

  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(printHtml);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => {
      printWin.print();
      printWin.close();
    }, 450);
  }
}

function shareProfitLossToWhatsApp() {
  const d = currentProfitLossData || calculateProfitLossData();
  const storeName = (receiptSettings && receiptSettings.name) || 'Toko Kami';

  let expText = '';
  const cats = Object.keys(d.expenseCatMap);
  if (cats.length > 0) {
    expText = '\n📋 *Rincian Beban Biaya:*\n' + cats.map(c => `• ${c}: Rp ${formatRupiah(d.expenseCatMap[c])}`).join('\n');
  }

  const msg = 
`📊 *LAPORAN LABA / RUGI BERSIH - ${storeName.toUpperCase()}*
📅 *Periode:* ${d.periodText}
--------------------------------------------
💰 *Total Omset Penjualan:* Rp ${formatRupiah(d.totalOmset)} (${d.txCount} Transaksi)
📦 *Modal Pokok HPP:* - Rp ${formatRupiah(d.totalHpp)}
--------------------------------------------
💵 *Laba Kotor:* Rp ${formatRupiah(d.labaKotor)}
🔻 *Total Biaya Operasional:* - Rp ${formatRupiah(d.totalExpenses)}
${expText}
============================================
🏆 *LABA BERSIH RIIL:* *${d.labaBersihRiil < 0 ? '-' : ''}Rp ${formatRupiah(Math.abs(d.labaBersihRiil))}*
📈 *Margin Keuntungan:* *${d.marginPercent}%*
============================================
_Laporan otomatis sistem POS ${storeName} pada ${new Date().toLocaleString('id-ID')}_`;

  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}


// ═════════════════════════════════════════════════════════════════════════════
// 2. SUBTAB SWITCHER PRODUK & INVENTARIS
// ═════════════════════════════════════════════════════════════════════════════

function switchProductSubTab(subtabId) {
  // Verifikasi izin akses sub-halaman jika login kasir aktif
  if (isStaffLoginEnabled && currentUserRole !== 'owner') {
    if (subtabId === 'opname' && !canPerformAction('opname')) {
      alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk membuka halaman Stock Opname.");
      return;
    }
    if (subtabId === 'expired' && !canPerformAction('expired')) {
      alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk membuka halaman Expired Tracker.");
      return;
    }
    if (subtabId === 'bundles' && !canPerformAction('bundles')) {
      alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk membuka halaman Paket Bundling.");
      return;
    }
  }

  currentProductSubTab = subtabId;
  const tabs = ['catalog', 'opname', 'expired', 'bundles'];

  tabs.forEach(t => {
    const pane = document.getElementById(`prod-subpane-${t}`);
    const btn = document.getElementById(`btn-prodtab-${t}`);
    if (pane) pane.style.display = (t === subtabId) ? 'block' : 'none';
    if (btn) {
      if (t === subtabId) {
        btn.classList.add('active');
        btn.classList.remove('btn-secondary');
        btn.style.background = '#ea580c';
        btn.style.color = '#fff';
      } else {
        btn.classList.remove('active');
        btn.classList.add('btn-secondary');
        btn.style.background = '';
        btn.style.color = '';
      }
    }
  });

  if (subtabId === 'catalog') {
    renderProductsTable();
  } else if (subtabId === 'opname') {
    populateOpnameDropdowns();
    renderStockOpnameTable();
    renderStockOpnameHistoryTable();
  } else if (subtabId === 'expired') {
    renderExpiredTrackerTable();
    updateExpiredBadgeCount();
  } else if (subtabId === 'bundles') {
    renderBundlesTable();
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// 3. MODUL STOCK OPNAME & AUDIT SELISIH FISIK
// ═════════════════════════════════════════════════════════════════════════════

let selectedOpnameProductIds = new Set();

function populateOpnameDropdowns() {
  const rackSelect = document.getElementById('opname-rack-filter');
  const catSelect = document.getElementById('opname-category-filter');

  if (rackSelect) {
    const racks = new Set();
    products.forEach(p => { if (p.rak) racks.add(p.rak); });
    rackSelect.innerHTML = '<option value="ALL">Semua Lokasi Rak</option>' +
      Array.from(racks).sort().map(r => `<option value="${r}">${r}</option>`).join('');
  }

  if (catSelect) {
    const cats = new Set();
    products.forEach(p => { if (p.kategori) cats.add(p.kategori); });
    catSelect.innerHTML = '<option value="ALL">Semua Kategori</option>' +
      Array.from(cats).sort().map(c => `<option value="${c}">${c}</option>`).join('');
  }
}

function renderStockOpnameTable() {
  const tbody = document.getElementById('stock-opname-tbody');
  if (!tbody) return;

  const searchVal = (document.getElementById('opname-search-input')?.value || '').toLowerCase().trim();
  const rackFilter = document.getElementById('opname-rack-filter')?.value || 'ALL';
  const catFilter = document.getElementById('opname-category-filter')?.value || 'ALL';
  const diffFilter = document.getElementById('opname-difference-filter')?.value || 'ALL';

  const filtered = products.filter(p => {
    if (rackFilter !== 'ALL' && p.rak !== rackFilter) return false;
    if (catFilter !== 'ALL' && p.kategori !== catFilter) return false;

    if (searchVal) {
      const matchName = (p.nama || '').toLowerCase().includes(searchVal);
      const matchId = (p.id || '').toLowerCase().includes(searchVal);
      const matchBarcode = (p.barcode || '').toLowerCase().includes(searchVal);
      if (!matchName && !matchId && !matchBarcode) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Tidak ada produk yang sesuai filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const isChecked = selectedOpnameProductIds.has(p.id);
    const barcodeStr = p.barcode || '-';

    return `
      <tr id="opname-row-${p.id}">
        <td style="text-align:center;">
          <input type="checkbox" class="opname-checkbox" data-id="${p.id}" ${isChecked ? 'checked' : ''} onchange="toggleOpnameSelectRow('${p.id}', this.checked)">
        </td>
        <td style="font-size:0.82rem; font-family:monospace;">
          <strong>${p.id}</strong><br><span style="color:var(--text-muted);">${barcodeStr}</span>
        </td>
        <td><strong>${p.nama}</strong></td>
        <td><span style="background:var(--bg-body); padding:2px 8px; border-radius:6px; font-size:0.78rem;">${p.rak || '-'}</span></td>
        <td style="text-align:center; font-weight:800; font-size:0.95rem;" id="opname-sys-${p.id}">${p.stok || 0}</td>
        <td style="text-align:center;">
          <input type="number" id="opname-phys-${p.id}" class="form-control" min="0" value="${p.stok || 0}" oninput="calcOpnameDiff('${p.id}')" style="width:100px; text-align:center; font-weight:800; padding:0.35rem; margin:auto; border-radius:6px;">
        </td>
        <td style="text-align:center; font-weight:800; font-size:0.95rem;" id="opname-diff-${p.id}">
          <span style="color:#64748b;">0 (Pas)</span>
        </td>
        <td>
          <select id="opname-reason-${p.id}" class="form-control" style="padding:0.35rem 0.5rem; font-size:0.82rem; border-radius:6px;">
            <option value="Sesuai / Tidak Ada Selisih">Sesuai / Tidak Ada Selisih</option>
            <option value="Hilang / Tercecer">Hilang / Tercecer</option>
            <option value="Rusak / Bocor / Cacat">Rusak / Bocor / Cacat</option>
            <option value="Salah Input Transaksi Sebelumnya">Salah Input Transaksi Sebelumnya</option>
            <option value="Bonus / Kelebihan Kirim dari Sales">Bonus / Kelebihan Kirim dari Sales</option>
            <option value="Lainnya">Lainnya</option>
          </select>
        </td>
        <td style="text-align:center;">
          <button type="button" class="btn btn-primary btn-sm" onclick="applySingleStockOpname('${p.id}')" style="padding:3px 8px; font-size:0.78rem; font-weight:700;">
            Koreksi
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function calcOpnameDiff(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;

  const sysVal = p.stok || 0;
  const physInput = document.getElementById(`opname-phys-${productId}`);
  const diffEl = document.getElementById(`opname-diff-${productId}`);
  const reasonSelect = document.getElementById(`opname-reason-${productId}`);
  const cb = document.querySelector(`.opname-checkbox[data-id="${productId}"]`);

  const physVal = parseInt(physInput.value);
  if (isNaN(physVal)) {
    diffEl.innerHTML = '<span style="color:#64748b;">-</span>';
    return;
  }

  const diff = physVal - sysVal;
  if (diff === 0) {
    diffEl.innerHTML = '<span style="color:#64748b;">0 (Pas)</span>';
  } else if (diff > 0) {
    diffEl.innerHTML = `<span style="color:#16a34a; font-weight:800;">+${diff} (Lebih)</span>`;
    if (reasonSelect && reasonSelect.value === 'Sesuai / Tidak Ada Selisih') {
      reasonSelect.value = 'Bonus / Kelebihan Kirim dari Sales';
    }
    if (cb && !cb.checked) {
      cb.checked = true;
      toggleOpnameSelectRow(productId, true);
    }
  } else {
    diffEl.innerHTML = `<span style="color:#dc2626; font-weight:800;">${diff} (Kurang)</span>`;
    if (reasonSelect && reasonSelect.value === 'Sesuai / Tidak Ada Selisih') {
      reasonSelect.value = 'Hilang / Tercecer';
    }
    if (cb && !cb.checked) {
      cb.checked = true;
      toggleOpnameSelectRow(productId, true);
    }
  }
}

function toggleOpnameSelectRow(productId, isChecked) {
  if (isChecked) {
    selectedOpnameProductIds.add(productId);
  } else {
    selectedOpnameProductIds.delete(productId);
  }
  const countEl = document.getElementById('opname-selected-count');
  if (countEl) countEl.textContent = selectedOpnameProductIds.size;
}

function toggleSelectAllOpname(masterCb) {
  const cbs = document.querySelectorAll('.opname-checkbox');
  cbs.forEach(cb => {
    cb.checked = masterCb.checked;
    const pid = cb.getAttribute('data-id');
    if (masterCb.checked) selectedOpnameProductIds.add(pid);
    else selectedOpnameProductIds.delete(pid);
  });
  const countEl = document.getElementById('opname-selected-count');
  if (countEl) countEl.textContent = selectedOpnameProductIds.size;
}

function applySingleStockOpname(productId) {
  if (!canPerformAction('opname')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk melakukan Stock Opname!");
    return;
  }

  const p = products.find(x => x.id === productId);
  if (!p) return;

  const physInput = document.getElementById(`opname-phys-${productId}`);
  const reasonSelect = document.getElementById(`opname-reason-${productId}`);
  const physVal = parseInt(physInput.value);

  if (isNaN(physVal) || physVal < 0) {
    alert("Masukkan hitungan fisik yang valid!");
    return;
  }

  const oldStock = p.stok || 0;
  const diff = physVal - oldStock;
  const reason = reasonSelect.value;

  if (diff === 0) {
    alert(`Stok fisik "${p.nama}" sama dengan stok sistem (${oldStock} pcs). Tidak ada perubahan.`);
    return;
  }

  if (confirm(`Konfirmasi penyesuaian stok "${p.nama}"?\n• Stok Lama: ${oldStock} pcs\n• Stok Fisik Baru: ${physVal} pcs\n• Selisih: ${diff > 0 ? '+' : ''}${diff}\n• Alasan: ${reason}`)) {
    p.stok = physVal;
    saveProductsLocally();
    if (firebaseDb) saveProductCloud(p);

    const logEntry = {
      id: `OPN-${Date.now()}`,
      waktu: new Date().toISOString(),
      productId: p.id,
      productName: p.nama,
      petugas: activeCashier || 'Admin',
      stokLama: oldStock,
      stokBaru: physVal,
      selisih: diff,
      alasan: reason
    };
    stockOpnames.unshift(logEntry);
    saveStockOpnamesLocally();
    syncStockOpnamesToCloud();

    alert(`✅ Stok "${p.nama}" berhasil diperbarui menjadi ${physVal} pcs!`);
    selectedOpnameProductIds.delete(productId);
    renderStockOpnameTable();
    renderStockOpnameHistoryTable();
  }
}

function applyBatchStockOpname() {
  if (!canPerformAction('opname')) {
    alert("⛔ Akses Ditolak: Anda tidak memiliki izin untuk melakukan Stock Opname!");
    return;
  }

  if (selectedOpnameProductIds.size === 0) {
    alert("Pilih minimal satu produk untuk menerapkan hasil opname!");
    return;
  }

  let countApplied = 0;
  selectedOpnameProductIds.forEach(pid => {
    const p = products.find(x => x.id === pid);
    const physInput = document.getElementById(`opname-phys-${pid}`);
    const reasonSelect = document.getElementById(`opname-reason-${pid}`);
    if (p && physInput) {
      const physVal = parseInt(physInput.value);
      if (!isNaN(physVal) && physVal >= 0) {
        const oldStock = p.stok || 0;
        const diff = physVal - oldStock;
        p.stok = physVal;
        if (firebaseDb) saveProductCloud(p);

        stockOpnames.unshift({
          id: `OPN-${Date.now()}-${Math.floor(Math.random()*1000)}`,
          waktu: new Date().toISOString(),
          productId: p.id,
          productName: p.nama,
          petugas: activeCashier || 'Admin',
          stokLama: oldStock,
          stokBaru: physVal,
          selisih: diff,
          alasan: reasonSelect ? reasonSelect.value : 'Penyesuaian Massal'
        });
        countApplied++;
      }
    }
  });

  saveProductsLocally();
  saveStockOpnamesLocally();
  syncStockOpnamesToCloud();

  alert(`✅ Berhasil menyesuaikan stok untuk ${countApplied} produk!`);
  selectedOpnameProductIds.clear();
  renderStockOpnameTable();
  renderStockOpnameHistoryTable();
}

function saveStockOpnamesLocally() {
  localStorage.setItem('kasir_stock_opnames', JSON.stringify(stockOpnames));
}

function syncStockOpnamesToCloud() {
  if (firebaseDb) {
    firebaseDb.ref(getStorePath('stockOpnames')).set(stockOpnames).catch(err => {
      console.error("Gagal sinkron opname ke cloud:", err);
    });
  }
}

function renderStockOpnameHistoryTable() {
  const tbody = document.getElementById('opname-history-tbody');
  if (!tbody) return;

  if (stockOpnames.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:1.2rem; color:var(--text-muted);">Belum ada riwayat stock opname.</td></tr>`;
    return;
  }

  tbody.innerHTML = stockOpnames.slice(0, 30).map(o => {
    const diffColor = o.selisih > 0 ? '#16a34a' : (o.selisih < 0 ? '#dc2626' : '#64748b');
    return `
      <tr>
        <td style="font-size:0.82rem;">${o.waktu ? new Date(o.waktu).toLocaleString('id-ID') : '-'}</td>
        <td><strong>${o.productName || o.productId}</strong></td>
        <td style="font-size:0.82rem;">${o.petugas || 'Admin'}</td>
        <td style="text-align:center;">${o.stokLama}</td>
        <td style="text-align:center; font-weight:800;">${o.stokBaru}</td>
        <td style="text-align:center; font-weight:800; color:${diffColor};">${o.selisih > 0 ? '+' : ''}${o.selisih}</td>
        <td style="font-size:0.82rem;">${o.alasan || '-'}</td>
      </tr>
    `;
  }).join('');
}

function exportOpnameHistoryToExcel() {
  if (typeof XLSX === 'undefined') {
    alert("Library Excel belum siap!");
    return;
  }
  if (stockOpnames.length === 0) {
    alert("Belum ada data audit opname untuk diekspor!");
    return;
  }

  const rows = [
    ['RIWAYAT AUDIT STOCK OPNAME - ' + (receiptSettings.name || 'TOKO SAHIL')],
    ['Waktu Export: ' + new Date().toLocaleString('id-ID')],
    ['No', 'Waktu', 'ID Produk', 'Nama Produk', 'Petugas Audit', 'Stok Sistem Lama', 'Stok Fisik Baru', 'Selisih', 'Alasan']
  ];

  stockOpnames.forEach((o, i) => {
    rows.push([
      i + 1,
      o.waktu ? new Date(o.waktu).toLocaleString('id-ID') : '',
      o.productId,
      o.productName,
      o.petugas,
      o.stokLama,
      o.stokBaru,
      o.selisih,
      o.alasan
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Riwayat Opname');
  XLSX.writeFile(wb, `Audit_Stock_Opname_${new Date().toISOString().slice(0, 10)}.xlsx`);
}


// ═════════════════════════════════════════════════════════════════════════════
// 4. MODUL EXPIRED TRACKER (MONITORING KADALUARSA)
// ═════════════════════════════════════════════════════════════════════════════

function getProductExpiryStatus(dateStr) {
  if (!dateStr) return { status: 'NONE', label: 'Tanpa Tgl', days: 9999, color: '#64748b' };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expDate = new Date(dateStr);
  expDate.setHours(0, 0, 0, 0);

  const diffTime = expDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { status: 'PASSED', label: `Expired (${Math.abs(diffDays)} hari lalu)`, days: diffDays, color: '#dc2626' };
  } else if (diffDays <= 14) {
    return { status: 'H14', label: `Kritis: Sisa ${diffDays} Hari`, days: diffDays, color: '#ea580c' };
  } else if (diffDays <= 30) {
    return { status: 'H30', label: `Waspada: Sisa ${diffDays} Hari`, days: diffDays, color: '#ca8a04' };
  } else {
    return { status: 'SAFE', label: `Aman (${diffDays} Hari lagi)`, days: diffDays, color: '#16a34a' };
  }
}

function updateExpiredBadgeCount() {
  let countCritical = 0;
  products.forEach(p => {
    if (p.tanggal_kadaluarsa) {
      const st = getProductExpiryStatus(p.tanggal_kadaluarsa);
      if (st.status === 'PASSED' || st.status === 'H14') countCritical++;
    }
  });

  const badge = document.getElementById('badge-expired-count');
  if (badge) {
    if (countCritical > 0) {
      badge.textContent = countCritical;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

function renderExpiredTrackerTable() {
  const tbody = document.getElementById('expired-tracker-tbody');
  if (!tbody) return;

  const searchVal = (document.getElementById('expired-search-input')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('expired-status-filter')?.value || 'PASSED';

  let countPassed = 0;
  let countH14 = 0;
  let countH30 = 0;

  products.forEach(p => {
    if (p.tanggal_kadaluarsa) {
      const info = getProductExpiryStatus(p.tanggal_kadaluarsa);
      if (info.status === 'PASSED') countPassed++;
      else if (info.status === 'H14') countH14++;
      else if (info.status === 'H30') countH30++;
    }
  });

  const elP = document.getElementById('expired-count-passed');
  const elH14 = document.getElementById('expired-count-h14');
  const elH30 = document.getElementById('expired-count-h30');
  if (elP) elP.textContent = `${countPassed} Produk`;
  if (elH14) elH14.textContent = `${countH14} Produk`;
  if (elH30) elH30.textContent = `${countH30} Produk`;

  const prodsWithExp = products.filter(p => !!p.tanggal_kadaluarsa);

  const filtered = prodsWithExp.filter(p => {
    const info = getProductExpiryStatus(p.tanggal_kadaluarsa);
    if (statusFilter !== 'ALL' && info.status !== statusFilter) return false;

    if (searchVal) {
      const matchName = (p.nama || '').toLowerCase().includes(searchVal);
      const matchBarcode = (p.barcode || '').toLowerCase().includes(searchVal);
      const matchRack = (p.rak || '').toLowerCase().includes(searchVal);
      if (!matchName && !matchBarcode && !matchRack) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const da = new Date(a.tanggal_kadaluarsa).getTime();
    const db = new Date(b.tanggal_kadaluarsa).getTime();
    return da - db;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Tidak ada produk kadaluarsa yang sesuai dengan filter ini.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const info = getProductExpiryStatus(p.tanggal_kadaluarsa);
    const badge = `<span style="background:rgba(0,0,0,0.06); color:${info.color}; font-weight:800; padding:3px 8px; border-radius:6px; font-size:0.8rem; border:1px solid ${info.color}40;">${info.label}</span>`;

    return `
      <tr>
        <td><strong>${p.nama}</strong><br><small style="color:var(--text-muted);">${p.id}</small></td>
        <td style="font-family:monospace; font-size:0.82rem;">${p.barcode || '-'}</td>
        <td><span style="background:var(--bg-body); padding:2px 8px; border-radius:6px; font-size:0.78rem;">${p.rak || '-'}</span></td>
        <td style="text-align:center; font-weight:800; font-size:0.95rem; color:${p.stok <= 2 ? '#dc2626' : 'var(--text-main)'};">${p.stok || 0} pcs</td>
        <td style="font-weight:700;">${p.tanggal_kadaluarsa}</td>
        <td>${badge}</td>
        <td style="text-align:center;">
          <div style="display:flex; gap:0.35rem; justify-content:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary btn-sm" onclick="directReturSalesFromExpired('${p.id}')" style="background:#dc2626; border-color:#dc2626; font-size:0.75rem; padding:3px 7px;">
              Retur Sales
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="directDiscountPromoFromExpired('${p.id}')" style="font-size:0.75rem; padding:3px 7px;">
              Beri Diskon
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function directReturSalesFromExpired(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;

  switchTab('kulak');
  switchSalesSubTab('returns');
  openAddSalesReturnModal();

  setTimeout(() => {
    // Cari apakah produk ini terdaftar pada salah satu sales
    const matchedSales = salesList.find(s => Array.isArray(s.productIds) && s.productIds.includes(p.id));
    const salesSelect = document.getElementById('return-sales-select');
    if (salesSelect && matchedSales) {
      salesSelect.value = matchedSales.id;
      onReturnSalesChanged();
    }

    const prodSelect = document.getElementById('return-product-select');
    if (prodSelect) {
      prodSelect.innerHTML = `<option value="${p.id}" selected>${p.nama} (Stok: ${p.stok})</option>`;
      prodSelect.value = p.id;
    }
    const reasonSelect = document.getElementById('return-reason');
    if (reasonSelect) reasonSelect.value = 'Kadaluarsa / Expired';
    const notesInput = document.getElementById('return-notes');
    if (notesInput) notesInput.value = `Barang mendekati/lewat expired tgl ${p.tanggal_kadaluarsa}`;
    const qtyInput = document.getElementById('return-qty');
    if (qtyInput) qtyInput.value = p.stok > 0 ? p.stok : 1;
    onReturnProductChanged();
    calculateReturnEstimatedValue();
  }, 250);
}

function directDiscountPromoFromExpired(productId) {
  const idx = products.findIndex(x => x.id === productId);
  if (idx !== -1) {
    switchProductSubTab('catalog');
    editProduct(idx);
    const promoPriceInput = document.getElementById('prod-promo-price');
    const promoQuotaInput = document.getElementById('prod-promo-quota');
    if (promoPriceInput && products[idx].harga_jual) {
      promoPriceInput.value = Math.floor(products[idx].harga_jual * 0.7); // Diskon 30% saran obral
      promoQuotaInput.value = products[idx].stok || 5;
    }
  }
}

function exportExpiredToExcel() {
  if (typeof XLSX === 'undefined') {
    alert("Library Excel belum siap!");
    return;
  }

  const prods = products.filter(p => !!p.tanggal_kadaluarsa);
  if (prods.length === 0) {
    alert("Belum ada produk dengan tanggal expired!");
    return;
  }

  const rows = [
    ['MONITORING PRODUK KADALUARSA (EXPIRED TRACKER) - ' + (receiptSettings.name || 'TOKO SAHIL')],
    ['Waktu Export: ' + new Date().toLocaleString('id-ID')],
    ['No', 'ID Produk', 'Nama Produk', 'Barcode', 'Lokasi Rak', 'Stok', 'Tanggal Expired', 'Status']
  ];

  prods.forEach((p, i) => {
    const st = getProductExpiryStatus(p.tanggal_kadaluarsa);
    rows.push([
      i + 1,
      p.id,
      p.nama,
      p.barcode || '',
      p.rak || '',
      p.stok,
      p.tanggal_kadaluarsa,
      st.label
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expired Tracker');
  XLSX.writeFile(wb, `Expired_Tracker_${new Date().toISOString().slice(0, 10)}.xlsx`);
}


// ═════════════════════════════════════════════════════════════════════════════
// 5. MODUL PAKET BUNDLING / PAKET HEMAT
// ═════════════════════════════════════════════════════════════════════════════

function openBundleModal(editId = null) {
  const modal = document.getElementById('bundle-modal');
  const title = document.getElementById('bundle-modal-title');
  const editIdInput = document.getElementById('bundle-edit-id');
  const nameInput = document.getElementById('bundle-name');
  const barcodeInput = document.getElementById('bundle-barcode');
  const priceInput = document.getElementById('bundle-price');
  const compContainer = document.getElementById('bundle-components-container');

  if (!modal) return;
  editIdInput.value = editId || '';
  compContainer.innerHTML = '';

  if (editId) {
    const b = bundles.find(x => x.id === editId);
    if (b) {
      title.textContent = `Edit Paket: ${b.nama}`;
      nameInput.value = b.nama;
      barcodeInput.value = b.barcode || '';
      priceInput.value = formatRupiah(b.harga || 0);

      if (Array.isArray(b.items) && b.items.length > 0) {
        b.items.forEach(it => addBundleComponentRow(it.productId, it.qty));
      } else {
        addBundleComponentRow();
        addBundleComponentRow();
      }
    }
  } else {
    title.textContent = "Buat Paket Bundling Hemat Baru";
    nameInput.value = '';
    barcodeInput.value = '';
    priceInput.value = '';
    addBundleComponentRow();
    addBundleComponentRow();
  }

  calculateBundleSavings();
  modal.style.display = 'flex';
  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeBundleModal() {
  const modal = document.getElementById('bundle-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function addBundleComponentRow(selectedProductId = '', qty = 1) {
  const container = document.getElementById('bundle-components-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'bundle-comp-row';
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '2fr 1fr auto';
  row.style.gap = '0.5rem';
  row.style.alignItems = 'center';

  let options = '<option value="">-- Pilih Produk Komponen --</option>';
  products.forEach(p => {
    const sel = (String(p.id) === String(selectedProductId)) ? 'selected' : '';
    options += `<option value="${p.id}" ${sel}>${p.nama} (Rp ${formatRupiah(p.harga_jual)})</option>`;
  });

  row.innerHTML = `
    <select class="form-control bundle-comp-select" onchange="calculateBundleSavings()" style="padding:0.45rem; font-size:0.85rem; border-radius:6px;">
      ${options}
    </select>
    <div style="display:flex; align-items:center; gap:0.3rem;">
      <input type="number" class="form-control bundle-comp-qty" min="1" value="${qty || 1}" oninput="calculateBundleSavings()" style="width:70px; padding:0.45rem; text-align:center; font-weight:700; border-radius:6px;">
      <span style="font-size:0.75rem; color:var(--text-muted);">Pcs</span>
    </div>
    <button type="button" onclick="this.closest('.bundle-comp-row').remove(); calculateBundleSavings();" style="background:#fee2e2; border:1px solid #fca5a5; color:#dc2626; border-radius:6px; width:28px; height:28px; cursor:pointer; font-weight:bold;">&times;</button>
  `;

  container.appendChild(row);
}

function calculateBundleSavings() {
  const rows = document.querySelectorAll('#bundle-components-container .bundle-comp-row');
  let totalNormal = 0;

  rows.forEach(r => {
    const sel = r.querySelector('.bundle-comp-select');
    const qtyInp = r.querySelector('.bundle-comp-qty');
    const pid = sel ? sel.value : '';
    const q = qtyInp ? (parseInt(qtyInp.value) || 1) : 1;

    if (pid) {
      const p = products.find(x => String(x.id) === String(pid));
      if (p) totalNormal += (Number(p.harga_jual) || 0) * q;
    }
  });

  const normalDisplay = document.getElementById('bundle-normal-price-display');
  if (normalDisplay) normalDisplay.textContent = `Rp ${formatRupiah(totalNormal)}`;

  const priceInput = document.getElementById('bundle-price');
  const bundlePrice = priceInput ? (parseFloat(priceInput.value.replace(/\./g, '')) || 0) : 0;
  const savingsAmountEl = document.getElementById('bundle-savings-amount');

  if (savingsAmountEl) {
    if (totalNormal > 0 && bundlePrice > 0 && bundlePrice < totalNormal) {
      const diff = totalNormal - bundlePrice;
      const pct = Math.round((diff / totalNormal) * 100);
      savingsAmountEl.textContent = `Rp ${formatRupiah(diff)} (${pct}%)`;
    } else {
      savingsAmountEl.textContent = 'Rp 0 (0%)';
    }
  }
}

function submitBundleForm(event) {
  event.preventDefault();

  const editId = document.getElementById('bundle-edit-id').value;
  const name = document.getElementById('bundle-name').value.trim();
  const barcode = document.getElementById('bundle-barcode').value.trim();
  const priceStr = document.getElementById('bundle-price').value.replace(/\./g, '');
  const price = parseFloat(priceStr) || 0;

  const rows = document.querySelectorAll('#bundle-components-container .bundle-comp-row');
  const itemsMap = new Map();
  let totalNormal = 0;

  rows.forEach(r => {
    const pid = r.querySelector('.bundle-comp-select')?.value;
    const q = parseInt(r.querySelector('.bundle-comp-qty')?.value) || 1;
    if (pid) {
      const p = products.find(x => String(x.id) === String(pid));
      if (p) {
        if (itemsMap.has(p.id)) {
          const existing = itemsMap.get(p.id);
          existing.qty += q;
        } else {
          itemsMap.set(p.id, {
            productId: p.id,
            productName: p.nama,
            qty: q,
            normalPrice: Number(p.harga_jual) || 0
          });
        }
        totalNormal += (Number(p.harga_jual) || 0) * q;
      }
    }
  });

  const items = Array.from(itemsMap.values());

  if (!name) { alert("Nama paket bundling wajib diisi!"); return; }
  if (items.length < 2) { alert("Paket bundling minimal harus memiliki 2 macam produk komponen!"); return; }
  if (price <= 0) { alert("Harga jual paket harus lebih dari Rp 0!"); return; }

  // Cek barcode unik jika barcode diisi
  if (barcode) {
    const duplicate = bundles.find(b => b.barcode && String(b.barcode).toLowerCase() === barcode.toLowerCase() && b.id !== editId);
    if (duplicate) {
      alert(`Barcode "${barcode}" sudah digunakan oleh paket "${duplicate.nama}"! Gunakan barcode lain.`);
      return;
    }
  }

  if (editId) {
    const idx = bundles.findIndex(x => x.id === editId);
    if (idx !== -1) {
      bundles[idx] = {
        ...bundles[idx],
        nama: name,
        barcode: barcode,
        harga: price,
        items: items,
        totalNormal: totalNormal
      };
      alert("Paket bundling berhasil diperbarui!");
    }
  } else {
    const newBundle = {
      id: `BDL-${Date.now()}`,
      nama: name,
      barcode: barcode,
      harga: price,
      items: items,
      totalNormal: totalNormal
    };
    bundles.unshift(newBundle);
    alert(`✅ Paket Bundling "${name}" berhasil dibuat!`);
  }

  saveBundlesLocally();
  syncBundlesToCloud();
  closeBundleModal();
  renderBundlesTable();
  if (typeof renderPosCatalogGrid === 'function') renderPosCatalogGrid();
}

function deleteBundle(bundleId) {
  const b = bundles.find(x => x.id === bundleId);
  if (!b) return;

  if (confirm(`Hapus paket bundling "${b.nama}"?`)) {
    bundles = bundles.filter(x => x.id !== bundleId);
    saveBundlesLocally();
    syncBundlesToCloud();
    renderBundlesTable();
  }
}

function saveBundlesLocally() {
  localStorage.setItem('kasir_bundles', JSON.stringify(bundles));
}

function syncBundlesToCloud() {
  if (firebaseDb) {
    firebaseDb.ref(getStorePath('bundles')).set(bundles).catch(err => {
      console.error("Gagal sinkron bundles ke cloud:", err);
    });
  }
}

function renderBundlesTable() {
  const tbody = document.getElementById('bundles-table-tbody');
  if (!tbody) return;

  if (bundles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:1.5rem; color:var(--text-muted);">Belum ada program paket bundling. Klik tombol di atas untuk membuat paket hemat baru.</td></tr>`;
    return;
  }

  tbody.innerHTML = bundles.map(b => {
    const compText = (b.items || []).map(it => `${it.productName} (${it.qty} pcs)`).join(', ');
    const diff = Math.max(0, (b.totalNormal || 0) - (b.harga || 0));

    // Cek ketersediaan stok komponen
    let maxAvailableSets = 9999;
    (b.items || []).forEach(it => {
      const p = products.find(x => x.id === it.productId);
      const stock = p ? (p.stok || 0) : 0;
      const sets = Math.floor(stock / (it.qty || 1));
      if (sets < maxAvailableSets) maxAvailableSets = sets;
    });

    const isAvailable = maxAvailableSets > 0;
    const statusBadge = isAvailable
      ? `<span style="background:rgba(22,163,74,0.12); color:#16a34a; font-weight:800; padding:2px 8px; border-radius:6px; font-size:0.75rem;">Siap: Bisa ${maxAvailableSets} Paket</span>`
      : `<span style="background:rgba(220,38,38,0.12); color:#dc2626; font-weight:800; padding:2px 8px; border-radius:6px; font-size:0.75rem;">Stok Komponen Habis</span>`;

    return `
      <tr>
        <td style="font-family:monospace; font-size:0.85rem;">${b.barcode || '-'}</td>
        <td><strong>${b.nama}</strong></td>
        <td style="font-size:0.85rem;">${compText}</td>
        <td style="text-align:right; text-decoration:line-through; color:var(--text-muted);">Rp ${formatRupiah(b.totalNormal || 0)}</td>
        <td style="text-align:right; font-weight:800; color:#ea580c; font-size:1.05rem;">Rp ${formatRupiah(b.harga || 0)}</td>
        <td style="text-align:right; color:#16a34a; font-weight:700;">Hemat Rp ${formatRupiah(diff)}</td>
        <td style="text-align:center;">${statusBadge}</td>
        <td style="text-align:center;">
          <div style="display:flex; gap:0.35rem; justify-content:center;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openBundleModal('${b.id}')" style="padding:2px 6px; font-size:0.75rem;">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" onclick="deleteBundle('${b.id}')" style="padding:2px 6px; font-size:0.75rem;">Hapus</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function addBundleToCart(bundle) {
  if (appConfig.strictShift && !activeShift) {
    alert("Wajib buka shift terlebih dahulu untuk melakukan transaksi!");
    return;
  }

  const cartId = `bundle_${bundle.id}`;
  const existing = cart.find(it => it.cartId === cartId);
  const targetQty = existing ? (existing.qty + 1) : 1;

  // Validasi stok semua komponen berdasarkan total paket yang akan ada di keranjang
  if (!appConfig.allowZeroStock && Array.isArray(bundle.items)) {
    for (const it of bundle.items) {
      const p = products.find(x => String(x.id) === String(it.productId));
      const required = (Number(it.qty) || 1) * targetQty;
      if (!p || p.stok < required) {
        alert(`Stok komponen "${it.productName}" tidak mencukupi untuk ${targetQty} paket! (Tersisa ${p ? p.stok : 0} pcs)`);
        focusSearchInput();
        return;
      }
    }
  }

  if (existing) {
    existing.qty = targetQty;
    existing.subtotal = existing.qty * existing.harga;
    existing.paidQty = existing.qty;
  } else {
    // Hitung total modal HPP dari semua komponen produk di dalam paket bundling
    let bundleBuyPrice = 0;
    if (Array.isArray(bundle.items)) {
      bundle.items.forEach(it => {
        const p = products.find(x => String(x.id) === String(it.productId));
        const compBuy = p ? (Number(p.harga_beli) || 0) : 0;
        bundleBuyPrice += compBuy * (Number(it.qty) || 1);
      });
    }

    cart.push({
      cartId: cartId,
      id: bundle.id,
      nama: `[PAKET] ${bundle.nama}`,
      harga: bundle.harga,
      harga_beli: bundleBuyPrice, // Simpan HPP riil komponen agar laba bersih akurat
      subtotal: bundle.harga,
      qty: 1,
      paidQty: 1,
      freeQty: 0,
      isBundle: true,
      bundleItems: bundle.items,
      totalNormal: bundle.totalNormal || 0,
      isBox: false
    });
  }

  playBeep();
  renderCart();
  focusSearchInput();
}

/* ==========================================================================
   DESKTOP ELECTRON NATIVE INTEGRATION & DUAL-MODE UPDATER
   ========================================================================== */
let currentHardwareId = 'LOCAL-BROWSER';

async function initDesktopIntegration() {
  if (typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.isDesktop) {
    try {
      // 1. Ambil Hardware ID
      currentHardwareId = await window.desktopAPI.getHardwareId();
      const hwElem = document.getElementById('display-hardware-id');
      if (hwElem) hwElem.textContent = currentHardwareId;
      console.log('💻 Mode Desktop Aktif. Hardware ID:', currentHardwareId);

      // 2. Load Local Database dari Electron File System (Jika ada data tersimpan)
      const localDiskData = await window.desktopAPI.readLocalDb();
      if (localDiskData && Object.keys(localDiskData).length > 0) {
        console.log('📂 Memuat database lokal dari disk Electron...');
        for (const key in localDiskData) {
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, typeof localDiskData[key] === 'string' ? localDiskData[key] : JSON.stringify(localDiskData[key]));
          }
        }
      }

      // 3. Pasang Auto-Save berkala ke File Disk Electron (Setiap 5 detik jika ada perubahan)
      setInterval(async () => {
        try {
          const snapshot = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('kasir_')) {
              snapshot[k] = localStorage.getItem(k);
            }
          }
          await window.desktopAPI.saveLocalDb(snapshot);
        } catch (e) {
          // ignore error background save
        }
      }, 5000);

    } catch (e) {
      console.warn('Gagal inisialisasi Desktop API:', e);
    }
  } else {
    const hwElem = document.getElementById('display-hardware-id');
    if (hwElem) hwElem.textContent = 'MODE WEB BROWSER';
    const badge = document.getElementById('desktop-mode-badge');
    if (badge) {
      badge.textContent = 'Web Browser (Non-Desktop)';
      badge.style.background = '#f1f5f9';
      badge.style.color = '#64748b';
    }
  }
}

function copyHardwareId() {
  if (!navigator.clipboard) {
    alert('Hardware ID: ' + currentHardwareId);
    return;
  }
  navigator.clipboard.writeText(currentHardwareId).then(() => {
    alert('Hardware ID berhasil disalin ke clipboard:\n' + currentHardwareId);
  }).catch(() => {
    alert('Hardware ID: ' + currentHardwareId);
  });
}

// 1. Jalur Pembaruan Offline (Pilih File .patch/.zip)
async function applyOfflinePatch() {
  if (!window.desktopAPI || !window.desktopAPI.selectUpdatePatch) {
    alert('Fitur pembaruan file patch hanya tersedia di aplikasi versi desktop (.exe)!');
    return;
  }

  const res = await window.desktopAPI.selectUpdatePatch();
  if (res.canceled) return;

  if (res.success) {
    alert(res.message);
    if (confirm('Restart aplikasi sekarang untuk menikmati fitur baru?')) {
      await window.desktopAPI.restartApp();
    }
  } else {
    alert('Gagal memasang pembaruan offline: ' + res.error);
  }
}

// 2. Jalur Pembaruan Online (Cek ke Remote GitHub / Hosting)
async function checkOnlineUpdate() {
  if (!window.desktopAPI) {
    alert('Pembaruan otomatis hanya didukung pada aplikasi desktop (.exe)!');
    return;
  }

  const btn = event?.currentTarget;
  if (btn) btn.disabled = true;

  try {
    // Cek versi release terbaru via API GitHub repo
    const res = await fetch('https://api.github.com/repos/mohteguhh/POS-Toko-Sahil/releases/latest');
    if (!res.ok) {
      throw new Error('Tidak dapat menghubungi server pembaruan (Kode: ' + res.status + ')');
    }
    const releaseData = await res.json();
    const latestVersion = releaseData.tag_name || '1.0.0';

    // Cari file asset berakhiran .patch atau .zip
    const patchAsset = releaseData.assets && releaseData.assets.find(a => a.name.endsWith('.patch') || a.name.endsWith('.zip'));

    if (!patchAsset) {
      alert(`Versi saat ini sudah yang paling baru (${latestVersion}). Tidak ada file patch pembaruan.`);
      return;
    }

    if (confirm(`Pembaruan versi ${latestVersion} tersedia!\nUnduh dan terapkan sekarang?`)) {
      const downloadRes = await fetch(patchAsset.browser_download_url);
      const arrayBuffer = await downloadRes.arrayBuffer();
      const applyRes = await window.desktopAPI.applyOnlineUpdate(arrayBuffer);
      if (applyRes.success) {
        alert(applyRes.message);
        await window.desktopAPI.restartApp();
      } else {
        alert('Gagal menerapkan update: ' + applyRes.error);
      }
    }
  } catch (err) {
    alert('Info Pembaruan: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Jalankan integrasi desktop saat dokumen selesai dimuat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDesktopIntegration);
} else {
  initDesktopIntegration();
}

