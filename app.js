/* ==========================================================================
   KASIRKILAT POS LOGIC - FULL FEATURES & BATCH OPTIMIZATIONS
   ========================================================================== */

// --- State Aplikasi ---
let products = [];
let shifts = [];
let activeShift = null; // null jika tidak ada shift aktif
let customers = [];
let loyaltySettings = JSON.parse(localStorage.getItem('kasir_loyalty_settings')) || {
  pointsPerRp: 50000,
  rpPerPoint: 100
};

// --- Helper Gambar Offline (Flicker-Free) ---
function handleImageError(img) {
  img.onerror = null; // Mencegah loop tak terbatas
  img.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="%23cbd5e1" stroke-width="2"><rect width="100" height="100" fill="%23f8fafc"/><circle cx="50" cy="45" r="15"/><path d="M20,80 C20,60 80,60 80,80"/></svg>';
}
let cart = JSON.parse(localStorage.getItem('kasir_active_cart')) || [];
let lastTransactionChange = null;
let heldCarts = JSON.parse(localStorage.getItem('kasir_held_carts')) || [];
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
let selectedReceiptButtonIndex = 0; // 0 = Cetak Nota, 1 = Tidak

// State Cetak Label Harga Massal (Terpilih)
let selectedProductIds = new Set();
let lastScannedProductId = null; // ID produk terakhir di-scan barcode

// State Kasir & Multi-user (Fitur Baru)
let cashiers = JSON.parse(localStorage.getItem('kasir_cashiers')) || ['Kasir Utama', 'Kasir Shift 2', 'Kasir Shift 3'];
let activeCashier = localStorage.getItem('kasir_active_cashier') || 'Kasir Utama';

// --- MANAJEMEN LOGIN KARYAWAN & HAK AKSES ROLE (OWNER VS KASIR) ---
let isStaffLoginEnabled = JSON.parse(localStorage.getItem('kasir_staff_login_enabled')) || false;
let ownerPin = localStorage.getItem('kasir_owner_pin') || '1234';
let currentUserRole = localStorage.getItem('kasir_current_user_role') || 'owner'; // 'owner' atau 'staff'

// Master data akun karyawan beserta PIN dan izin tab masing-masing
let staffAccounts = JSON.parse(localStorage.getItem('kasir_staff_accounts')) || [
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
      settings: false
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
      settings: false
    }
  }
];

// --- LOGIKA FIREBASE REALTIME DATABASE ---
// Konfigurasi Firebase (hardcoded sebagai fallback permanen)
const DEFAULT_FB_CONFIG = {
  apiKey: "AIzaSyD0X6NxN3wI9vm009mJrXwf94ZkSOQoFKU",
  authDomain: "db-toko-sahil.firebaseapp.com",
  projectId: "db-toko-sahil",
  storageBucket: "db-toko-sahil.firebasestorage.app",
  messagingSenderId: "1091161238327",
  appId: "1:1091161238327:web:91a19ba78332925719c8b2",
  databaseURL: "https://db-toko-sahil-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Pakai config dari localStorage jika ada, fallback ke hardcoded
let fbConfig = JSON.parse(localStorage.getItem('kasir_firebase_config')) || DEFAULT_FB_CONFIG;
// Pastikan databaseURL selalu ada
if (!fbConfig.databaseURL) {
  fbConfig.databaseURL = DEFAULT_FB_CONFIG.databaseURL;
}
// Simpan ke localStorage supaya form Settings ikut terisi
localStorage.setItem('kasir_firebase_config', JSON.stringify(fbConfig));

let firebaseDb = null;
let fbUnsubscribes = [];

// Database URL Realtime Database (hardcoded + override dari config)
const RTDB_URL = 'https://db-toko-sahil-default-rtdb.asia-southeast1.firebasedatabase.app';

let currentLicenseKey = localStorage.getItem('kasir_license_key') || 'TOKO-SAHIL-PRO';
let currentLicenseData = null;
const ADMIN_WA_NUMBER = '6289636492890'; // Nomor WA Admin untuk konfirmasi pembayaran Rp 50.000/bln

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
      // Lisensi telah kedaluwarsa: Matikan mode cloud dan alihkan ke offline
      console.warn('⛔ Masa langganan cloud telah habis.');
      if (fbUnsubscribes && fbUnsubscribes.length > 0) {
        fbUnsubscribes.forEach(unsub => unsub());
        fbUnsubscribes = [];
      }
      firebaseDb = null;
      appConfig.enableCloudSync = false;
      localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
      const chk = document.getElementById('chk-enable-cloud');
      if (chk) chk.checked = false;
      const panel = document.getElementById('firebase-settings-panel');
      if (panel) panel.style.display = 'none';

      updateSyncStatus('offline', 'Langganan Cloud Expired (Mode Offline Aktif)');
      openSubscriptionInvoiceModal();
      return false;
    }

    setupDatabaseListeners();
    updateSyncStatus('online', 'Database Terhubung');
    return true;
  } catch (err) {
    console.error('Error inisialisasi Firebase:', err);
    updateSyncStatus('offline', 'Firebase Error: ' + err.message);
    return false;
  }
}

// Pemeriksaan status lisensi ke Firebase Realtime Database
async function checkSubscriptionLicense() {
  if (!firebaseDb) return false;
  
  if (!currentLicenseKey || currentLicenseKey.trim() === '' || currentLicenseKey === 'DEFAULT') {
    updateSyncStatus('offline', 'Kode Lisensi Belum Diatur');
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
      updateSyncStatus('offline', 'Lisensi Tidak Terdaftar');
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
  if (!lic || !lic.expired_at) return;

  const expDate = new Date(lic.expired_at);
  const now = new Date();
  const diffDays = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  const options = { day: 'numeric', month: 'long', year: 'numeric' };
  const expStr = expDate.toLocaleDateString('id-ID', options);

  if (diffDays <= 0) {
    if (badge) {
      badge.textContent = 'Kedaluwarsa';
      badge.style.background = '#ef4444';
    }
    if (info) {
      info.innerHTML = `Masa aktif telah <b style="color: #ef4444;">HABIS</b> pada ${expStr}. Tagihan Rp 50.000 belum dibayar.`;
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
  currentLicenseKey = val;
  localStorage.setItem('kasir_license_key', currentLicenseKey);
  alert(`Kode lisensi "${val}" disimpan! Menguji status lisensi...`);
  if (firebaseDb) {
    checkSubscriptionLicense().then(isValid => {
      if (isValid) alert('✅ Lisensi Aktif! Sinkronisasi cloud berjalan lancar.');
      else openSubscriptionInvoiceModal();
    });
  }
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
  const text = `Halo Admin, saya ingin perpanjang langganan Cloud POS (Rp 50.000 / Bulan)%0A%0A• Nama Toko: ${encodeURIComponent(tokoName)}%0A• Kode Lisensi: ${encodeURIComponent(currentLicenseKey)}%0A%0AMohon nomor rekening / QRIS untuk pembayaran. Terima kasih.`;
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
    
    // Gabungkan transaksi cloud dengan transaksi lokal yang belum ada di cloud (jika ada)
    const txMap = new Map();
    cloudTxs.forEach(tx => {
      const id = tx.id || tx.id_transaksi;
      if (id) txMap.set(id, { ...tx, id });
    });
    
    // Periksa transactions lokal saat ini, masukkan yang belum ada di cloud
    transactions.forEach(localTx => {
      const id = localTx.id || localTx.id_transaksi;
      if (id && !txMap.has(id)) {
        txMap.set(id, localTx);
        // Upload langsung transaksi lokal yang belum ada di cloud ini ke RTDB toko
        firebaseDb.ref(getStorePath('transactions/' + id)).set(JSON.parse(JSON.stringify(localTx))).catch(() => {});
      }
    });

    const mergedTxs = Array.from(txMap.values());
    mergedTxs.sort((a, b) => parseTxDate(b.waktu).getTime() - parseTxDate(a.waktu).getTime());
    console.log(`🧾 RTDB transaksi aktif (${currentLicenseKey}): ${mergedTxs.length}`);
    transactions = mergedTxs;
    saveTransactionsLocally();
    if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
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

  console.log(`✅ Semua listener Realtime Database aktif untuk toko: ${currentLicenseKey}`);
}

// Alias untuk kompatibilitas panggilan lama
function setupFirestoreListeners() { setupDatabaseListeners(); }

function syncAllFromCloud() {
  if (!firebaseDb) {
    initFirebase().then(ok => {
      if (!ok) alert('Firebase belum terhubung. Silakan atur konfigurasi Firebase di Pengaturan.');
    });
    return;
  }
  updateSyncStatus('syncing', 'Menyinkronkan data...');
  setupFirestoreListeners();
}

// Alias untuk tombol Tarik Transaksi dari Cloud
function syncTransactionsFromCloud() {
  syncAllFromCloud();
}

// Reset filter pencarian tabel riwayat transaksi
function clearTransactionFilters() {
  const searchInput = document.getElementById('transaction-list-search');
  const startDate = document.getElementById('tx-filter-start-date');
  const endDate = document.getElementById('tx-filter-end-date');
  const statusSelect = document.getElementById('tx-filter-status');

  const todayStr = getLocalISODate(new Date()).slice(0, 10);
  if (searchInput) searchInput.value = '';
  if (startDate) startDate.value = todayStr;
  if (endDate) endDate.value = todayStr;
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

    // Update stok produk di RTDB toko secara bersamaan
    if (Array.isArray(cleanTx.items)) {
      const stockUpdates = {};
      cleanTx.items.forEach(item => {
        if (item.id) {
          const p = products.find(prod => prod.id === item.id);
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
  if (!firebaseDb) {
    alert('❌ Firebase belum terhubung. Silakan hubungkan Firebase di Pengaturan terlebih dahulu.');
    return;
  }

  if (!confirm('⚠️ APAKAH ANDA YAKIN?\n\nSemua riwayat transaksi di Realtime Database dan memori Lokal akan DIHAPUS BERSIH.\nLangkah ini tidak dapat dibatalkan!')) {
    return;
  }

  updateSyncStatus('syncing', 'Menghapus semua transaksi...');

  try {
    // RTDB: hapus seluruh node 'transactions' untuk toko ini
    await firebaseDb.ref(getStorePath('transactions')).remove();
    console.log('✅ Semua transaksi toko berhasil dihapus dari RTDB');

    transactions = [];
    localStorage.removeItem('kasir_transactions');

    if (typeof renderTransactionsTable === 'function') renderTransactionsTable();
    if (typeof initAnalyticsFilter === 'function') initAnalyticsFilter();
    if (typeof updateAnalytics === 'function') updateAnalytics();

    updateSyncStatus('online', 'Database Terhubung');
    alert('🗑️ Berhasil mengosongkan semua transaksi dari database dan lokal!');
  } catch (err) {
    console.error('❌ Gagal hapus transaksi:', err.message);
    updateSyncStatus('offline', 'Gagal Hapus: ' + err.message);
    alert('❌ Gagal menghapus transaksi:\n\n' + err.message);
  }
}

// Alias untuk tombol lama di index.html
function clearFirestoreTransactions() {
  return clearAllTransactions();
}


// Fungsi Backup & Restore Database Lokal (JSON)
function exportFullDatabaseJSON() {
  const backupData = {
    app: "KasirKilat POS",
    version: "3.2",
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
      appConfig: appConfig || {}
    }
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const dateStr = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Backup_Kasir_${(receiptSettings.name || 'Toko').replace(/[^a-zA-Z0-9]/g, '_')}_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert('✅ Cadangan Database berhasil didownload!\nSimpan file ini di tempat yang aman (Flashdisk / Harddisk).');
}

function importFullDatabaseJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup || !backup.data) {
        throw new Error("Format file cadangan tidak valid.");
      }

      const d = backup.data;
      const countProds = Array.isArray(d.products) ? d.products.length : 0;
      const countTxs = Array.isArray(d.transactions) ? d.transactions.length : 0;

      if (!confirm(`Apakah Anda yakin ingin memulihkan database dari file ini?\n\n- ${countProds} Produk\n- ${countTxs} Transaksi\n\n⚠️ Tindakan ini akan menggantikan data yang ada saat ini.`)) {
        event.target.value = '';
        return;
      }

      if (Array.isArray(d.products)) {
        products = d.products;
        saveProductsLocally();
      }
      if (Array.isArray(d.transactions)) {
        transactions = d.transactions;
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
        const syncCloud = confirm('Apakah Anda ingin langsung menyinkronkan data yang baru dipulihkan ke Cloud Realtime Database?');
        if (syncCloud) {
          const updates = {};
          products.forEach(p => updates[getStorePath('products/' + p.id)] = p);
          transactions.forEach(t => updates[getStorePath('transactions/' + t.id)] = t);
          await firebaseDb.ref('/').update(updates);
        }
      }

      alert('✅ Database berhasil dipulihkan!');
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
    
    // JIKA BERHASIL TERHUBUNG: Unggah otomatis transaksi & data offline ke Firebase!
    if (connected && firebaseDb) {
      try {
        const localTxs = JSON.parse(localStorage.getItem('kasir_transactions')) || transactions || [];
        if (localTxs.length > 0) {
          updateSyncStatus('syncing', `Mengunggah ${localTxs.length} transaksi offline ke Cloud...`);
          const updates = {};
          localTxs.forEach(tx => {
            if (tx && tx.id) {
              updates[getStorePath('transactions/' + tx.id)] = JSON.parse(JSON.stringify(tx));
            }
          });
          
          // Juga pastikan stok produk lokal ikut tersinkronkan
          products.forEach(p => {
            if (p && p.id) {
              updates[getStorePath('products/' + p.id)] = JSON.parse(JSON.stringify(p));
            }
          });

          // Juga pastikan data pelanggan lokal ikut tersinkronkan
          if (Array.isArray(customers) && customers.length > 0) {
            customers.forEach(c => {
              if (c) {
                const key = c.id || c.telepon || ('CUST-' + Date.now());
                updates[getStorePath('customers/' + key)] = JSON.parse(JSON.stringify(c));
              }
            });
          }

          await firebaseDb.ref('/').update(updates);
          console.log(`✅ ${localTxs.length} transaksi offline berhasil diunggah ke Firebase Realtime Database.`);
          updateSyncStatus('online', 'Database Terhubung');
          alert(`⚡ Mode Online Aktif!\n\nSebanyak ${localTxs.length} transaksi offline dan data produk Anda telah otomatis tersinkronisasi ke Firebase Cloud.`);
        }
      } catch (uploadErr) {
        console.error('Gagal upload otomatis transaksi offline:', uploadErr);
      }
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
let appConfig = JSON.parse(localStorage.getItem('kasir_app_config')) || {
  strictShift: false,
  allowZeroStock: true,
  customerMode: false,
  enablePromo: false,
  showDiscountPos: false,
  showPromoBanner: true,
  posGridMode: false,
  enableCloudSync: false
};
if (appConfig.enableCloudSync === undefined) appConfig.enableCloudSync = false;
if (appConfig.enablePromo === undefined) appConfig.enablePromo = false;
if (appConfig.showDiscountPos === undefined) appConfig.showDiscountPos = false;
if (appConfig.showPromoBanner === undefined) appConfig.showPromoBanner = true;
if (appConfig.posGridMode === undefined) appConfig.posGridMode = false;

// Pengaturan Nota / Struk Toko (Default)
let receiptSettings = JSON.parse(localStorage.getItem('kasir_receipt_settings')) || {
  logo: '',
  name: 'TOKO SAHIL',
  phone: '0896-3649-2890',
  address: 'Desa Sumurber Rt 21 Rw 07 Panceng Gresik',
  fontSizeHeader: 14,
  fontSizeItems: 12,
  fontSizeFooter: 12
};
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

let labelSettings = JSON.parse(localStorage.getItem('kasir_label_settings')) || {
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
};

let productLabelSettings = JSON.parse(localStorage.getItem('kasir_product_label_settings')) || {
  width: 50,
  height: 30,
  marginLeft: 0,
  chars: 25,
  showBarcode: true,
  showPrice: true,
  showStoreName: true
};


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
        if (navigator.onLine) {
          initAnalyticsFilter();
          updateAnalytics();
          updateSyncStatus('offline', 'Firebase belum dikonfigurasi');
        } else {
          updateSyncStatus('offline', 'Tidak ada koneksi internet');
          initAnalyticsFilter();
          updateAnalytics();
        }
      }
    });
  } else {
    // Mode Offline Murni (Database Lokal)
    updateSyncStatus('offline', 'Mode Offline (Database Lokal)');
    initAnalyticsFilter();
    updateAnalytics();
  }
  
  const startDateInput = document.getElementById('tx-filter-start-date');
  const endDateInput = document.getElementById('tx-filter-end-date');
  const todayDateStr = getLocalISODate(new Date()).slice(0, 10);
  if (startDateInput) startDateInput.value = todayDateStr;
  if (endDateInput) endDateInput.value = todayDateStr;
  
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
  });
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
    products = JSON.parse(cachedProducts);
  } else {
    products = [...defaultProducts];
    saveProductsLocally();
  }
  
  // Muat transaksi: jika mode offline lokal, muat dari localStorage.
  // Jika cloud aktif, transactions diisi oleh listener Realtime Database.
  if (!appConfig.enableCloudSync) {
    const cachedTransactions = localStorage.getItem('kasir_transactions');
    if (cachedTransactions) {
      try {
        transactions = JSON.parse(cachedTransactions);
      } catch (e) {
        transactions = [];
      }
    } else {
      transactions = [];
    }
  } else {
    transactions = [];
  }
  
  const cachedShifts = localStorage.getItem('kasir_shifts');
  if (cachedShifts) shifts = JSON.parse(cachedShifts);
  
  const cachedActiveShift = localStorage.getItem('kasir_active_shift');
  if (cachedActiveShift) activeShift = JSON.parse(cachedActiveShift);
  
  const cachedCustomers = localStorage.getItem('kasir_customers');
  if (cachedCustomers) customers = JSON.parse(cachedCustomers);
  
  updateCategoriesList();
  
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
}

// Batas maksimal transaksi yang disimpan di LocalStorage agar aplikasi tidak hang/freeze
const MAX_LOCAL_TRANSACTIONS = 300;

function saveTransactionsLocally() {
  if (transactions.length > MAX_LOCAL_TRANSACTIONS) {
    // Simpan hanya 300 transaksi terbaru di LocalStorage
    const recentTransactions = transactions.slice(-MAX_LOCAL_TRANSACTIONS);
    localStorage.setItem('kasir_transactions', JSON.stringify(recentTransactions));
  } else {
    localStorage.setItem('kasir_transactions', JSON.stringify(transactions));
  }
}

// Simpan data produk secara lokal
function saveProductsLocally() {
  localStorage.setItem('kasir_products', JSON.stringify(products));
}

// Simpan master daftar kategori khusus (yang dibuat manual pengguna)
let customCategories = JSON.parse(localStorage.getItem('kasir_custom_categories')) || ['Umum', 'Makanan', 'Minuman', 'Snack', 'Sembako'];

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
  alert(`✅ Kategori "${cleanCat}" berhasil ditambahkan!`);
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
  appConfig.strictShift = document.getElementById('chk-strict-shift').checked;
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
  
  localStorage.setItem('kasir_app_config', JSON.stringify(appConfig));
  
  const promoContainer = document.getElementById('promo-fields-container');
  if (promoContainer) {
    promoContainer.style.display = appConfig.enablePromo ? 'grid' : 'none';
  }
  
  const shiftWrapper = document.getElementById('buka-shift-wrapper');
  if (shiftWrapper) {
    shiftWrapper.style.display = appConfig.strictShift ? 'flex' : 'none';
  }
  
  calculateTotal(); // Update POS discount visibility
  checkPromoBanner(); // Update visibilitas banner carousel promo
  if (typeof applyPosGridConfig === 'function') applyPosGridConfig();
  
  alert('Pengaturan Sistem Aplikasi berhasil disimpan!');
}

function loadAppConfig() {
  document.getElementById('chk-strict-shift').checked = appConfig.strictShift;
  document.getElementById('chk-allow-zero-stock').checked = appConfig.allowZeroStock;
  document.getElementById('chk-customer-mode').checked = appConfig.customerMode;
  document.getElementById('chk-enable-promo').checked = appConfig.enablePromo;
  
  const chkDiscount = document.getElementById('chk-show-discount');
  if (chkDiscount) chkDiscount.checked = appConfig.showDiscountPos;

  const chkPromoBanner = document.getElementById('chk-show-promo-banner');
  if (chkPromoBanner) chkPromoBanner.checked = appConfig.showPromoBanner !== false;

  const chkGridMode = document.getElementById('chk-pos-grid-mode');
  if (chkGridMode) chkGridMode.checked = appConfig.posGridMode === true;
  if (typeof applyPosGridConfig === 'function') applyPosGridConfig();
  
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

  const chkCloud = document.getElementById('chk-enable-cloud');
  const panelCloud = document.getElementById('firebase-settings-panel');
  if (chkCloud) chkCloud.checked = appConfig.enableCloudSync === true;
  if (panelCloud) panelCloud.style.display = appConfig.enableCloudSync ? 'block' : 'none';

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
  document.getElementById('font-size-preview-val').textContent = `${val}px`;
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
  applyReceiptSettings();
  loadLabelSettings();
  loadProductLabelSettings();
  renderProductsTable();
  alert('Pengaturan Branding & Nota berhasil disimpan!');
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
    focusKulakSearch();
  } else if (tabName === 'transactions') {
    document.getElementById('transaction-list-search').value = '';
    renderTransactionsTable();
    closeEditTransactionModal();
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
    if (storeInfo) storeInfo.textContent = receiptSettings.name || 'KasirKilat POS';

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

function updateAnalytics() {
  const now = new Date();
  
  // Filter transaksi sesuai filter yang dipilih
  const todayTxs = getAnalyticsFilteredTxs();
  
  // Set label untuk Produk Terlaris
  const filterType = document.getElementById('analytics-filter-type')?.value || 'hari';
  const labelEl = document.getElementById('best-seller-period');
  if (labelEl) {
    if (filterType === 'hari') labelEl.textContent = '(Hari Ini)';
    else if (filterType === 'bulan') labelEl.textContent = '(Bulan Ini)';
    else if (filterType === 'tahun') labelEl.textContent = '(Tahun Ini)';
    else labelEl.textContent = '(Semua Waktu)';
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
      const buyPrice = item.harga_beli || 0;
      const sellPrice = item.harga || 0;
      txNetProfitBeforeDiscount += (sellPrice - buyPrice) * item.qty;
      txSubtotal += sellPrice * item.qty;
    });
    
    // Kurangi laba bersih dengan diskon transaksi
    const txDiscount = Math.max(0, txSubtotal - tx.total);
    const txNetProfit = txNetProfitBeforeDiscount - txDiscount;
    netProfit += txNetProfit;
    
    // Omset/revenue hanya dari transaksi tunai (non-cash tidak masuk laci)
    if (!isNonCash) {
      revenue += tx.total;
    }
    
    // Akumulasi metode pembayaran
    methodsBreakdown[metode] = (methodsBreakdown[metode] || 0) + tx.total;
  });
  
  // Hitung total piutang aktif secara kumulatif (semua transaksi belum lunas)
  let totalDebt = 0;
  transactions.forEach(tx => {
    totalDebt += (tx.sisa_piutang || 0);
  });
  
  // Total Penjualan = Omset (tunai) - Laba Bersih = HPP/Harga Pokok
  const totalPenjualan = revenue - netProfit;
  
  // Update Metrik Hari Ini di UI
  document.getElementById('stat-revenue').textContent = `Rp ${formatRupiah(revenue)}`;
  document.getElementById('stat-gross-profit').textContent = `Rp ${formatRupiah(totalPenjualan)}`;
  document.getElementById('stat-net-profit').textContent = `Rp ${formatRupiah(netProfit)}`;
  
  const statDebtEl = document.getElementById('stat-debt');
  if (statDebtEl) {
    statDebtEl.textContent = `Rp ${formatRupiah(totalDebt)}`;
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
  }
  
  // 1. Hitung Stok Menipis (0 s.d. 2 pcs)
  const stockAlerts = products.filter(p => p.stok <= 2);
  const stockListEl = document.getElementById('stock-alerts-list');
  const countBadgeEl = document.getElementById('stock-alert-count-badge');
  if (countBadgeEl) {
    countBadgeEl.textContent = `${stockAlerts.length} Item`;
  }
  
  stockListEl.innerHTML = '';
  
  if (stockAlerts.length === 0) {
    stockListEl.innerHTML = '<div class="widget-empty">Stok aman terkendali.</div>';
  } else {
    stockAlerts.forEach(p => {
      const isHabis = p.stok === 0;
      const itemEl = document.createElement('div');
      itemEl.className = 'widget-item stock-item';
      
      const iconOrImg = p.gambar 
        ? `<img src="${p.gambar}" alt="${p.nama}" class="stock-item-img" onerror="this.onerror=null; this.outerHTML='<div class=\\'widget-icon-box bg-white-border\\'><svg viewBox=\\'0 0 24 24\\' class=\\'w-4 h-4 text-muted\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><path d=\\'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\\'/><polyline points=\\'3.27 6.96 12 12.01 20.73 6.96\\'/><line x1=\\'12\\' y1=\\'22.08\\' x2=\\'12\\' y2=\\'12\\'/></svg></div>';">`
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
        ? `<img src="${p.gambar}" alt="${nama}" class="best-seller-img" onerror="this.outerHTML=\`<div class='best-seller-box-icon'><svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='2'><path d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/><polyline points='3.27 6.96 12 12.01 20.73 6.96'/><line x1='12' y1='22.08' x2='12' y2='12'/></svg></div>\`;">`
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
  
  lowStockProducts.sort((a, b) => a.stok - b.stok);
  
  const storeName = (receiptSettings && receiptSettings.name) ? receiptSettings.name : 'TOKO';
  const nowStr = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  
  let text = `*📋 DAFTAR BELANJA / KULAKAN*\n`;
  text += `*${storeName}* - ${nowStr}\n`;
  text += `------------------------------------\n\n`;
  
  lowStockProducts.forEach((p, index) => {
    const status = p.stok === 0 ? '🔴 HABIS' : `🟡 Sisa ${p.stok}`;
    text += `${index + 1}. *${p.nama}*\n`;
    text += `   • Status: ${status}\n`;
    if (p.harga_beli) text += `   • Modal: Rp ${formatRupiah(p.harga_beli)}\n`;
    if (p.barcode) text += `   • Barcode: ${p.barcode}\n`;
    text += `\n`;
  });
  
  text += `------------------------------------\n`;
  text += `Total: *${lowStockProducts.length} Item*\n`;
  
  const encodedText = encodeURIComponent(text);
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
  const dateStr = new Date().toISOString().split('T')[0];
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
  
  let exactMatch = null;
  let isBoxScan = false;
  
  products.forEach(p => {
    if (p.barcode && String(p.barcode).toLowerCase() === searchVal.toLowerCase()) {
      exactMatch = p;
      isBoxScan = false;
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
    const requiredPcs = isBoxScan ? (exactMatch.isi_box || 1) : 1;
    if (exactMatch.stok >= requiredPcs || appConfig.allowZeroStock) {
      if (isBoxScan) {
        addBoxToCart(exactMatch);
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
    card.className = `pos-grid-card ${isOutOfStock ? 'out-of-stock' : ''} ${inCartClass}`;
    card.onclick = () => {
      if (!isOutOfStock) {
        addToCart(p);
        playBeep();
      } else {
        alert(`Stok "${p.nama}" habis!`);
      }
    };

    card.innerHTML = `
      <div class="pos-grid-img-wrap">
        <img src="${imgUrl}" alt="${p.nama}" class="pos-grid-img" onerror="handleImageError(this)">
        ${cartBadgeHtml}
        <span class="pos-grid-stock-badge ${stockBadgeClass}">${stockText}</span>
      </div>
      <div class="pos-grid-body">
        <div class="pos-grid-name" title="${p.nama}">${p.nama}</div>
        <div class="pos-grid-footer">
          <span class="pos-grid-price">Rp ${formatRupiah(p.harga_jual)}</span>
          <button type="button" class="pos-grid-add-btn" title="Tambah ke keranjang" tabindex="-1">+</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
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
  
  let matched = products.filter(p => {
    return String(p.nama).toLowerCase().includes(searchVal) || 
           String(p.id).toLowerCase().includes(searchVal) ||
           (p.barcode && String(p.barcode).toLowerCase().includes(searchVal));
  });
  
  matched.sort((a, b) => {
    const aNameMatch = String(a.nama).toLowerCase().includes(searchVal);
    const bNameMatch = String(b.nama).toLowerCase().includes(searchVal);
    if (aNameMatch && !bNameMatch) return -1;
    if (!aNameMatch && bNameMatch) return 1;
    // Dalam grup yang sama, urutkan berdasarkan abjad
    return String(a.nama).toLowerCase().localeCompare(String(b.nama).toLowerCase(), 'id');
  });
  
  filteredProducts = matched.slice(0, 15);
  
  if (filteredProducts.length === 0) {
    dropdown.innerHTML = '<div style="padding: 0.75rem 1rem; color: var(--text-muted); font-size: 0.85rem;">Barang tidak ditemukan...</div>';
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
    div.className = `floating-item ${isSelected ? 'selected' : ''} ${isOutOfStock ? 'out-of-stock' : ''}`;
    div.onclick = () => {
      if (!isOutOfStock) {
        addToCart(p);
        document.getElementById('search-input').value = '';
        closeFloatingResults();
        focusSearchInput();
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
    
    div.innerHTML = `
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onerror="handleImageError(this)">
      <div class="floating-item-info">
        <span class="floating-item-name">${p.nama} (${p.id})</span>
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
    
    // 1. Cek exact match barcode eceran, barcode kotak, atau ID terlebih dahulu (untuk scanner)
    let exactMatch = null;
    let isBoxScan = false;
    
    products.forEach(p => {
      if (p.barcode && String(p.barcode).toLowerCase() === searchVal) {
        exactMatch = p;
        isBoxScan = false;
      } else if (p.has_unit_box && p.barcode_box && String(p.barcode_box).toLowerCase() === searchVal) {
        exactMatch = p;
        isBoxScan = true;
      } else if (String(p.id).toLowerCase() === searchVal && !exactMatch) {
        exactMatch = p;
        isBoxScan = false;
      }
    });
    
    if (exactMatch) {
      const requiredPcs = isBoxScan ? (exactMatch.isi_box || 1) : 1;
      if (exactMatch.stok >= requiredPcs || appConfig.allowZeroStock) {
        if (isBoxScan) {
          addBoxToCart(exactMatch);
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
  
  // 2. Harga Bertingkat Dus/Kotak — otomatis aktif jika isi_box & harga_box diisi
  //    (tidak perlu has_unit_box = true, cukup ada datanya)
  let boxUnitName = "Dus";
  let boxMinQty = 0;
  let boxPrice = 0;
  
  const isiBox = parseInt(localProd.isi_box) || 0;
  const hargaBox = parseFloat(localProd.harga_box) || 0;
  const grosirQty = parseInt(localProd.grosir_qty) || 0;
  const grosirHarga = parseFloat(localProd.grosir_harga) || 0;
  
  if (isiBox > 1 && hargaBox > 0) {
    // Prioritas: data kemasan dus/kotak
    boxUnitName = localProd.nama_box || "Dus";
    boxMinQty = isiBox;
    boxPrice = hargaBox;
  } else if (grosirQty > 1 && grosirHarga > 0) {
    // Fallback: data harga grosir
    boxUnitName = "Dus";
    boxMinQty = grosirQty;
    boxPrice = grosirHarga;
  }
  
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
    
    const pkgText = packages > 1 ? `${packages} ${boxUnitName}` : `1 ${boxUnitName}`;
    const remText = remaining > 0 ? ` + ${remaining} pcs eceran` : '';
    result.badges.push({
      type: 'grosir',
      text: `📦 Harga ${pkgText} (${packages * boxMinQty} pcs = Rp ${formatRupiah(boxTotal)})${remText}`
    });
    if (!result.promoInfo) {
      result.promoInfo = `${pkgText}${remText}`;
    }
  } else {
    // Belum mencapai 1 dus / grosir
    if (hasBoxTier && paidQty < boxMinQty) {
      const needMore = boxMinQty - paidQty;
      result.badges.push({
        type: 'info',
        text: `📦 1 ${boxUnitName} isi ${boxMinQty} = Rp ${formatRupiah(boxPrice)} (Kurang ${needMore} pcs lagi)`
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
  if (item.isBox) {
    item.subtotal = item.qty * item.harga;
    return;
  }
  const localProd = products.find(p => p.id === item.id);
  if (!localProd) return;
  const pricing = calculateCartItemPricing(localProd, item.qty);
  item.subtotal = pricing.subtotal;
  item.harga = item.qty > 0 ? (pricing.subtotal / item.qty) : localProd.harga_jual;
  item.baseHarga = localProd.harga_jual;
  item.freeQty = pricing.freeQty;
  item.paidQty = pricing.paidQty;
  item.grosirPackages = pricing.grosirPackages;
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

function addBoxToCart(product) {
  lastTransactionChange = null;
  if (appConfig.strictShift && !activeShift) {
    alert("Wajib buka shift terlebih dahulu untuk melakukan transaksi!");
    return;
  }
  
  const boxQtyRequired = product.isi_box || 12;
  const boxPrice = product.harga_box || 0;
  const boxUnitName = product.nama_box || 'Kotak';
  const cartId = product.id + '_box_' + boxUnitName;
  
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

function addBoxToCartByProductIndex(index) {
  const p = products[index];
  if (p) {
    addBoxToCart(p);
  }
}

function updateCartQty(cartId, delta) {
  const itemIndex = cart.findIndex(item => item.cartId === cartId);
  if (itemIndex === -1) return;
  const item = cart[itemIndex];
  
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
      ? `<img src="${imgUrl}" class="promo-banner-thumb" alt="${p.nama}" onerror="this.style.display='none'">`
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
    
    // Label dus/kotak jika harga bertingkat aktif
    let boxLabel = '';
    if (!item.isBox) {
      const localProd = products.find(p => p.id === item.id) || {};
      const isiBox = parseInt(localProd.isi_box) || 0;
      const hargaBox = parseFloat(localProd.harga_box) || 0;
      const grosirQty = parseInt(localProd.grosir_qty) || 0;
      const grosirHarga = parseFloat(localProd.grosir_harga) || 0;
      const boxMinQty = (isiBox > 1 && hargaBox > 0) ? isiBox : (grosirQty > 1 && grosirHarga > 0 ? grosirQty : 0);
      const unitName = (isiBox > 1 && hargaBox > 0) ? (localProd.nama_box || 'Dus') : 'Dus';
      
      if (boxMinQty > 0 && paidQty >= boxMinQty) {
        const packages = Math.floor(paidQty / boxMinQty);
        const remaining = paidQty % boxMinQty;
        const pkgText = packages > 1 ? `${packages} ${unitName}` : `1 ${unitName}`;
        const remText = remaining > 0 ? ` + ${remaining} pcs` : '';
        boxLabel = `<span class="qty-box-label">📦 ${pkgText}${remText}</span>`;
      }
    }
    
    const subLabel = freeLabel || boxLabel;
    const unitPrice = (item.qty > 1 && !item.isBox)
      ? Math.round(item.subtotal / Math.max(paidQty, 1))
      : item.subtotal;
    
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div class="cart-item-info">
        <div class="cart-item-name">${item.nama}</div>
        <div class="cart-item-price-row">
          <span class="cart-item-price">Rp ${formatRupiah(unitPrice)}</span>
          ${item.qty > 1 && !item.isBox ? `<span class="cart-item-unit-price">(Bayar ${paidQty} pcs = Rp ${formatRupiah(item.subtotal)})</span>` : ''}
        </div>
      </div>
      <div class="cart-item-controls">
        <button class="qty-btn" onclick="updateCartQty('${item.cartId}', -1)">-</button>
        <div class="qty-input-wrap">
          <input type="number" class="qty-input" value="${item.qty}" min="1" onchange="setCartQtyDirect('${item.cartId}', this.value)">
          ${subLabel}
        </div>
        <button class="qty-btn" onclick="updateCartQty('${item.cartId}', 1)">+</button>
        <button class="remove-item-btn" onclick="removeFromCart('${item.cartId}')" title="Hapus">
          <svg viewBox="0 0 24 24" class="icon-sm"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
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
          ? `<img src="${imgUrl}" class="cart-promo-thumb" alt="${item.nama}" onerror="this.style.display='none'">`
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
          const unitName = item.boxUnitName || localProd.nama_box || 'Dus';
          promoCardsHtml += `
            <div class="cart-promo-summary-card box">
              ${imgTag}
              <div class="cart-promo-content">
                <div class="cart-promo-title">📦 Harga ${item.grosirPackages} ${unitName} (${item.nama})</div>
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
    document.getElementById('customer-name-input').value = '';
    document.getElementById('customer-points-info').style.display = 'none';
    document.getElementById('redeem-points-input').value = '';
  } else {
    customerNameGroup.style.display = 'none';
  }
  
  const cashInput = document.getElementById('cash-received');
  cashInput.value = '';
  document.getElementById('cash-received-group').style.display = 'block';
  document.getElementById('quick-cash-grid-container').style.display = 'grid';
  document.getElementById('cash-received-label').textContent = "Uang Diterima dari Konsumen (Rp)*";
  
  calculateChange();
  
  document.getElementById('payment-modal').classList.add('active');
  setTimeout(() => {
    cashInput.focus();
  }, 100);
}

function onPaymentMethodChange(val) {
  const cashInput = document.getElementById('cash-received');
  const cashGroup = document.getElementById('cash-received-group');
  const quickCashGrid = document.getElementById('quick-cash-grid-container');
  const statusSelect = document.getElementById('payment-status-select');
  
  if (val !== 'Tunai') {
    // Non-tunai otomatis Lunas dan Uang Pas
    statusSelect.value = 'Lunas';
    onPaymentStatusChange('Lunas');
    statusSelect.disabled = true; // non-tunai tidak bisa Bon
    
    cashInput.value = formatRupiah(globalTotal);
    cashGroup.style.display = 'none';
    quickCashGrid.style.display = 'none';
  } else {
    statusSelect.disabled = false;
    cashInput.value = '';
    cashGroup.style.display = 'block';
    quickCashGrid.style.display = 'grid';
  }
  calculateChange();
}

function onPaymentStatusChange(val) {
  const cashInput = document.getElementById('cash-received');
  const cashLabel = document.getElementById('cash-received-label');
  const quickCashGrid = document.getElementById('quick-cash-grid-container');
  
  if (val === 'Bon') {
    cashLabel.textContent = "Uang Muka / DP dibayarkan (Rp)";
    cashInput.placeholder = "Bisa dikosongkan (Rp 0)...";
    cashInput.value = '';
    quickCashGrid.style.display = 'none'; // sembunyikan quick cash karena bayar bebas/DP
  } else {
    cashLabel.textContent = "Uang Diterima dari Konsumen (Rp)*";
    cashInput.placeholder = "Masukkan jumlah uang...";
    cashInput.value = '';
    quickCashGrid.style.display = 'grid';
  }
  calculateChange();
}

function closePaymentModal() {
  document.getElementById('payment-modal').classList.remove('active');
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
  // Hitung potongan poin
  const redeemInput = document.getElementById('redeem-points-input');
  let redeemPoints = parseInt(redeemInput ? redeemInput.value : 0) || 0;
  
  // Validasi max poin
  const selectedCustomerName = document.getElementById('customer-name-input').value.trim();
  const customer = customers.find(c => c.nama === selectedCustomerName);
  if (customer && redeemPoints > customer.poin) {
    redeemPoints = customer.poin;
    if (redeemInput) redeemInput.value = redeemPoints;
  }
  
  let pointDiscount = redeemPoints * loyaltySettings.rpPerPoint;
  
  // Jangan biarkan diskon poin melebihi total belanja
  if (pointDiscount > globalTotal) {
    pointDiscount = globalTotal;
    redeemPoints = Math.floor(globalTotal / loyaltySettings.rpPerPoint);
    if (redeemInput) redeemInput.value = redeemPoints;
  }
  
  if (document.getElementById('redeem-points-discount')) {
    document.getElementById('redeem-points-discount').textContent = `Rp ${formatRupiah(pointDiscount)}`;
  }
  
  const finalTotalToPay = globalTotal - pointDiscount;
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
  const btnSubmit = document.getElementById('btn-checkout-submit');
  if (btnSubmit) btnSubmit.disabled = true;

  try {
  const method = document.getElementById('payment-method-select').value;
  const status = document.getElementById('payment-status-select').value;
  const customerName = document.getElementById('customer-name-input').value.trim();
  
  if (status === 'Bon' && customerName === '') {
    alert("Untuk pembayaran Bon, Nama Pelanggan wajib diisi!");
    return;
  }
  
  // Ambil data pelanggan (jika ada)
  const customer = customers.find(c => c.nama === customerName);
  
  // Kalkulasi poin
  const redeemInput = document.getElementById('redeem-points-input');
  let redeemPoints = parseInt(redeemInput ? redeemInput.value : 0) || 0;
  if (customer && redeemPoints > customer.poin) redeemPoints = customer.poin;
  let pointDiscount = redeemPoints * loyaltySettings.rpPerPoint;
  if (pointDiscount > globalTotal) {
    pointDiscount = globalTotal;
    redeemPoints = Math.floor(globalTotal / loyaltySettings.rpPerPoint);
  }
  
  const finalTotalToPay = globalTotal - pointDiscount;
  
  const cashInput = document.getElementById('cash-received');
  const cashText = cashInput.value.replace(/\./g, ""); // Hapus titik ribuan
  const cash = parseFloat(cashText) || 0;
  
  if (status !== 'Bon' && cash < finalTotalToPay) {
    alert("Pembayaran kurang!");
    return;
  }
  
  const change = status === 'Bon' ? (cash >= finalTotalToPay ? cash - finalTotalToPay : 0) : cash - finalTotalToPay;
  const sisaPiutang = status === 'Bon' ? (cash < finalTotalToPay ? finalTotalToPay - cash : 0) : 0;
  
  const txId = 'TX-' + Date.now().toString() + Math.floor(100 + Math.random() * 900);
  const now = new Date();
  
  const transaction = {
    id: txId,
    waktu: now.toISOString(),
    items: [...cart],
    total: globalTotal,
    diskon_poin: pointDiscount, // Track diskon poin
    poin_ditukar: redeemPoints, // Track poin ditukar
    bayar: cash,
    kembalian: change,
    metode_pembayaran: method,
    kasir: activeCashier,
    status_pembayaran: sisaPiutang > 0 ? 'Bon' : 'Lunas',
    nama_pelanggan: customerName, // Selalu catat jika ada
    sisa_piutang: sisaPiutang,
    id_shift: activeShift ? activeShift.id_shift : null
  };
  
  // Update poin pelanggan
  if (customer) {
    customer.poin -= redeemPoints; // Kurangi poin
    // Tambah poin baru berdasarkan total bayar
    const earnedPoints = Math.floor(finalTotalToPay / loyaltySettings.pointsPerRp);
    customer.poin += earnedPoints;
    
    transaction.poin_didapat = earnedPoints; // Track poin didapat
    
    saveCustomersLocally();
    saveCustomerCloud(customer);
    renderCustomersTable(); // Refresh tabel pelanggan di background
  }
  
  // 1. Kurangi stok produk secara lokal
  cart.forEach(cartItem => {
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
  });
  saveProductsLocally();
  checkPromoBanner();
  
  // 2. Simpan transaksi ke riwayat lokal (unshift di awal agar ada di paling atas)
  transactions.unshift(transaction);
  saveTransactionsLocally();
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
      await firebaseDb.ref(getStorePath('transactions/' + cleanTx.id)).set(cleanTx);
      console.log('✅ Transaksi berhasil masuk RTDB:', cleanTx.id, cleanTx.waktu);
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
    const btnSubmitFinal = document.getElementById('btn-checkout-submit');
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
    const itemTotal = item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty);
    const unitPrice = item.qty > 0 ? Math.round(itemTotal / item.qty) : item.harga;
    subtotal += itemTotal;
    
    let itemName = item.nama;
    if (item.promoInfo) {
      itemName += ` [${item.promoInfo}]`;
    }
    const nameLines = wrapText(itemName, width);
    nameLines.forEach(line => {
      text += line + "\n";
    });
    const qtyPriceStr = `${item.qty}x @Rp ${formatRupiah(unitPrice)} =`;
    const totalItemStr = `Rp ${formatRupiah(itemTotal)}`;
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
  
  // CRM Poin
  if (tx.nama_pelanggan) {
    text += centerText("-".repeat(width), width) + "\n";
    text += formatLine("Pelanggan", tx.nama_pelanggan, width) + "\n";
    text += formatLine("Poin Didapat", "+" + (tx.poin_didapat || 0), width) + "\n";
    
    let customerPoinTotal = tx.poin_didapat || 0;
    if (typeof customers !== 'undefined') {
      const customer = customers.find(c => c.nama === tx.nama_pelanggan);
      if (customer) customerPoinTotal = customer.poin || 0;
    }
    text += formatLine("Total Poin", "" + customerPoinTotal, width) + "\n";
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
    const itemTotal = item.subtotal !== undefined ? item.subtotal : (item.harga * item.qty);
    const unitPrice = item.qty > 0 ? Math.round(itemTotal / item.qty) : item.harga;
    subtotal += itemTotal;
    const row = document.createElement('div');
    row.className = 'receipt-item-row';
    
    if (index < items.length - 1) {
      row.style.borderBottom = '1px dashed #ddd';
      row.style.paddingBottom = '0.4rem';
      row.style.marginBottom = '0.4rem';
    }
    
    row.innerHTML = `
      <div class="receipt-item-row-top" style="align-items: flex-start;">
        <span style="flex: 1; padding-right: 0.5rem;">${item.nama}${item.promoInfo ? ` <small style="color:#059669; font-weight:600;">[${item.promoInfo}]</small>` : ''}</span>
        <div style="text-align: right; display: flex; flex-direction: column;">
          <span>Rp ${formatRupiah(itemTotal)}</span>
          <span style="font-size: 0.9em; font-weight: 500; color: #444; margin-top: 2px;">${item.qty}x @Rp ${formatRupiah(unitPrice)}</span>
        </div>
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
  
  const crmInfo = document.getElementById('rec-crm-info');
  if (crmInfo) {
    if (tx.nama_pelanggan) {
      const customer = customers.find(c => c.nama === tx.nama_pelanggan);
      crmInfo.style.display = 'block';
      document.getElementById('rec-points-earned').textContent = tx.poin_didapat || 0;
      document.getElementById('rec-points-total').textContent = customer ? (customer.poin || 0) : (tx.poin_didapat || 0);
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
  const btnSkip = document.getElementById('btn-skip-receipt');
  if (!btnPrint || !btnSkip) return;
  
  if (selectedReceiptButtonIndex === 0) {
    // Highlight Cetak Nota (Primary)
    btnPrint.className = 'btn btn-primary';
    btnSkip.className = 'btn btn-secondary';
    btnPrint.focus({ preventScroll: true });
  } else {
    // Highlight Tidak (Primary)
    btnPrint.className = 'btn btn-secondary';
    btnSkip.className = 'btn btn-primary';
    btnSkip.focus({ preventScroll: true });
  }
}

function closeReceiptModal() {
  document.getElementById('receipt-modal').classList.remove('active');
  focusSearchInput();
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
    
    div.innerHTML = `
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onerror="handleImageError(this)">
      <div class="floating-item-info">
        <span class="floating-item-name">${p.nama} (${p.id})</span>
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
        newStock = p.stok + qtyVal;
        isStockChanged = true;
      } else if (mode === 'set' && qtyVal !== p.stok) {
        newStock = qtyVal;
        isStockChanged = true;
      }
    }
    
    const isPriceChanged = newBuy !== p.harga_beli || newSell !== p.harga_jual;
    
    if (isStockChanged || isPriceChanged) {
      p.stok = newStock;
      p.harga_beli = newBuy;
      p.harga_jual = newSell;
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
  
  if (searchVal !== '') {
    lastScannedProductId = null;
  }
  
  let targetProduct = (searchVal === '' && catFilterVal === 'All' && lastScannedProductId) ? products.find(p => p.id === lastScannedProductId) : null;
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

      // Filter search teks / barcode
      if (!searchVal) return true;
      return String(p.nama).toLowerCase().includes(searchVal) || 
             String(p.id).toLowerCase().includes(searchVal) ||
             (p.barcode && String(p.barcode).toLowerCase().includes(searchVal)) ||
             (p.kategori && String(p.kategori).toLowerCase().includes(searchVal));
    });
  }
  
  // Sort produk jika bukan hasil tunggal dari scan barcode
  const sortSelect = document.getElementById('product-list-sort');
  if (sortSelect && !targetProduct) {
    const sortValue = sortSelect.value;
    matched.sort((a, b) => {
      if (sortValue === 'name_asc') {
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
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;">Barang tidak ditemukan.</td></tr>`;
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
      barcodeDisplay += `<br><span style="font-size:0.75rem; color:var(--color-primary); font-weight:600;">📦 ${p.barcode_box} (${p.nama_box || 'Kotak'})</span>`;
    }
    
    let hargaJualDisplay = `Rp ${formatRupiah(p.harga_jual)}`;
    if ((parseInt(p.isi_box) || 0) > 1 && (parseFloat(p.harga_box) || 0) > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:var(--color-primary); font-weight:600; background:rgba(79,70,229,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-block; margin-top:0.2rem;">📦 1 ${p.nama_box || 'Kotak'} (${p.isi_box} pcs): Rp ${formatRupiah(p.harga_box)}</span>`;
    }
    if (p.grosir_qty > 0 && p.grosir_harga > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:#2563eb; font-weight:600; background:rgba(37,99,235,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-block; margin-top:0.2rem;">🏷️ Grosir: ${p.grosir_qty} pcs = Rp ${formatRupiah(p.grosir_harga)}</span>`;
    }
    if (p.promo_beli_x > 0 && p.promo_gratis_y > 0) {
      hargaJualDisplay += `<br><span style="font-size:0.75rem; color:#059669; font-weight:600; background:rgba(16,185,129,0.1); padding:0.1rem 0.35rem; border-radius:4px; display:inline-block; margin-top:0.2rem;">🎁 Beli ${p.promo_beli_x} Gratis ${p.promo_gratis_y}</span>`;
    }
    
    tr.innerHTML = `
      <td style="text-align: center; padding: 0.5rem;">
        <input type="checkbox" class="product-select-checkbox" data-id="${p.id}" onclick="toggleProductSelection('${p.id}', this)" ${selectedProductIds.has(p.id) ? 'checked' : ''} style="cursor: pointer; transform: scale(1.15);">
      </td>
      <td>
        <img src="${imgUrl}" alt="${p.nama}" class="prod-table-img" onerror="handleImageError(this)">
      </td>
      <td><strong>${p.id}</strong></td>
      <td>${p.nama}</td>
      <td><span class="cat-btn" style="cursor:default; margin:0;">${p.kategori || 'Umum'}</span></td>
      <td>Rp ${formatRupiah(p.harga_beli)}</td>
      <td>${hargaJualDisplay}</td>
      <td>${p.stok}</td>
      <td>${barcodeDisplay}</td>
      <td>${expBadge}</td>
      <td>
        <div style="display: flex; gap: 0.35rem;">
          <button class="action-icon-btn btn-edit" onclick="editProduct(${originalIndex})" title="Edit">
            <svg viewBox="0 0 24 24" class="icon-sm"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="action-icon-btn btn-edit" onclick="openPrintLabelModal('${p.id}')" title="Cetak Label Harga" style="color: var(--color-success); background-color: rgba(16,185,129,0.1);">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button class="action-icon-btn btn-delete" onclick="deleteProduct(${originalIndex})" title="Hapus">
            <svg viewBox="0 0 24 24" class="icon-sm"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  // Sinkronkan tombol cetak massal dan checkbox master berdasarkan item yang baru saja di-render
  updateBulkActionButtonState();
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
    background: ${active ? 'var(--primary-color, #4f46e5)' : 'var(--bg-card, #fff)'};
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
  const expiryInput = document.getElementById('prod-expiry').value;
  const imageInput = document.getElementById('prod-image').value.trim();
  const promoPriceInput = parseFloat(document.getElementById('prod-promo-price').value) || 0;
  const promoQuotaInput = parseInt(document.getElementById('prod-promo-quota').value) || 0;
  const grosirQtyInput = parseInt(document.getElementById('prod-grosir-qty') ? document.getElementById('prod-grosir-qty').value : 0) || 0;
  const grosirPriceInput = parseFloat(document.getElementById('prod-grosir-price') ? document.getElementById('prod-grosir-price').value : 0) || 0;
  const promoBuyXInput = parseInt(document.getElementById('prod-promo-buy-x') ? document.getElementById('prod-promo-buy-x').value : 0) || 0;
  const promoGetYInput = parseInt(document.getElementById('prod-promo-get-y') ? document.getElementById('prod-promo-get-y').value : 0) || 0;
  
  if (editIndex === -1) {
    const isDuplicate = products.some(p => p.id.toLowerCase() === idInput.toLowerCase());
    if (isDuplicate) {
      alert(`Gagal! ID Produk "${idInput}" sudah digunakan.`);
      return;
    }
  }
  
  let isPriceIncreased = false;
  let oldPrice = 0;
  if (editIndex > -1) {
    const oldProduct = products[editIndex];
    if (priceSellInput > oldProduct.harga_jual) {
      isPriceIncreased = true;
      oldPrice = oldProduct.harga_jual;
    }
  }
  
  const hasBoxSelect = document.getElementById('prod-has-box');
  const hasBox = hasBoxSelect ? (hasBoxSelect.value === 'yes') : false;
  const barcodeBox = document.getElementById('prod-barcode-box') ? document.getElementById('prod-barcode-box').value.trim() : '';
  const unitBoxName = document.getElementById('prod-unit-box-name') ? (document.getElementById('prod-unit-box-name').value.trim() || 'Kotak') : 'Kotak';
  const qtyBox = document.getElementById('prod-qty-box') ? (parseInt(document.getElementById('prod-qty-box').value) || 0) : 0;
  const priceBox = document.getElementById('prod-price-box') ? (parseFloat(document.getElementById('prod-price-box').value) || 0) : 0;

  const productData = {
    id: idInput,
    nama: nameInput,
    kategori: categoryInput,
    harga_beli: priceBuyInput,
    harga_jual: priceSellInput,
    stok: stockInput,
    barcode: barcodeInput,
    tanggal_kadaluarsa: expiryInput,
    gambar: imageInput,
    harga_diskon: promoPriceInput,
    kuota_diskon: promoQuotaInput,
    
    // Fitur Harga Khusus Grosir & Promo Beli X Gratis Y
    grosir_qty: grosirQtyInput,
    grosir_harga: grosirPriceInput,
    promo_beli_x: promoBuyXInput,
    promo_gratis_y: promoGetYInput,
    
    // Fitur Kemasan Multi-Unit
    has_unit_box: hasBox,
    barcode_box: barcodeBox,
    nama_box: unitBoxName,
    isi_box: qtyBox,
    harga_box: priceBox
  };
  
  if (editIndex > -1) {
    products[editIndex] = productData;
  } else {
    products.push(productData);
  }
  
  saveProductsLocally();
  updateCategoriesList();
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

function toggleBoxPackagingFields() {
  const select = document.getElementById('prod-has-box');
  const fields = document.getElementById('prod-box-fields');
  if (fields) {
    fields.style.display = select && select.value === 'yes' ? 'flex' : 'none';
  }
}

function openProductModal() {
  populateCategorySelect();
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
  
  const hasBox = !!p.has_unit_box;
  const selectHasBox = document.getElementById('prod-has-box');
  if (selectHasBox) {
    selectHasBox.value = hasBox ? 'yes' : 'no';
    document.getElementById('prod-barcode-box').value = p.barcode_box || '';
    document.getElementById('prod-unit-box-name').value = p.nama_box || 'Kotak';
    document.getElementById('prod-qty-box').value = p.isi_box || '';
    document.getElementById('prod-price-box').value = p.harga_box || '';
    toggleBoxPackagingFields();
  }
  
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
  
  const selectHasBox = document.getElementById('prod-has-box');
  if (selectHasBox) {
    selectHasBox.value = 'no';
    document.getElementById('prod-barcode-box').value = "";
    document.getElementById('prod-unit-box-name').value = "";
    document.getElementById('prod-qty-box').value = "";
    document.getElementById('prod-price-box').value = "";
    toggleBoxPackagingFields();
  }
  
  document.getElementById('form-title').textContent = "Tambah Produk Baru";
  document.getElementById('btn-save-product').textContent = "Simpan Produk";
}

function deleteProduct(index) {
  const p = products[index];
  if (!p) return;
  if (confirm(`Apakah Anda yakin ingin menghapus produk "${p.nama}"?`)) {
    selectedProductIds.delete(p.id);
    products.splice(index, 1);
    saveProductsLocally();
    updateCategoriesList();
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
  csvContent += "ID,Nama Produk,Kategori,Harga Beli,Harga Jual,Stok,Barcode,Gambar,Tanggal Kadaluarsa\n";
  
  products.forEach(p => {
    const row = [
      `"${p.id}"`,
      `"${p.nama}"`,
      `"${p.kategori || 'Umum'}"`,
      p.harga_beli || 0,
      p.harga_jual || 0,
      p.stok,
      `"${p.barcode || ''}"`,
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
        // Toleransi nama kolom Bahasa Indonesia & Inggris
        const rawName = row['Nama Produk'] || row['Nama'] || row['nama'] || row['Product Name'] || row['nama_produk'];
        if (!rawName) return; // Lewati baris tanpa nama

        let rawId = String(row['ID Produk'] || row['ID'] || row['id'] || row['Id'] || '').trim();
        const rawCat = String(row['Kategori'] || row['kategori'] || row['Category'] || 'Umum').trim() || 'Umum';
        const rawBuy = parseFloat(row['Harga Beli'] || row['harga_beli'] || row['Beli'] || row['Buy Price']) || 0;
        const rawSell = parseFloat(row['Harga Jual'] || row['harga_jual'] || row['Jual'] || row['Sell Price']) || 0;
        const rawStock = parseInt(row['Stok'] || row['stok'] || row['Stock'] || row['Jumlah']) || 0;
        const rawBarcode = String(row['Barcode'] || row['barcode'] || '').trim();
        const rawExpiry = String(row['Tanggal Kadaluarsa'] || row['tanggal_kadaluarsa'] || row['Kadaluarsa'] || row['Expiry'] || '').trim();
        const rawImage = String(row['Gambar'] || row['gambar'] || row['Image'] || row['Foto'] || row['image'] || '').trim();

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
          tanggal_kadaluarsa: rawExpiry,
          gambar: rawImage
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

        if (firebaseDb) {
          updatesCloud[getStorePath('products/' + rawId)] = prodData;
        }
      });

      // Simpan perubahan ke LocalStorage
      localStorage.setItem('kasir_custom_categories', JSON.stringify(customCategories));
      saveProductsLocally();
      updateCategoriesList();
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

// Perbarui badge tampilan kasir di Navbar & kontrol tombol Logout
function updateCashierAuthUI() {
  const roleBadge = document.getElementById('current-user-role-badge');
  const nameSpan = document.getElementById('current-user-name');
  const chkLogin = document.getElementById('chk-enable-staff-login');
  const ownerPinInput = document.getElementById('owner-pin-input');
  const logoutBtn = document.getElementById('btn-logout-staff');

  const authWrapper = document.getElementById('cashier-auth-wrapper');

  if (chkLogin) chkLogin.checked = !!isStaffLoginEnabled;
  if (ownerPinInput) ownerPinInput.value = ownerPin || '1234';

  if (!isStaffLoginEnabled) {
    // JIKA FITUR LOGIN DIMATIKAN:
    // Sembunyikan total tombol login & logout dari pojok kanan agar bersih dan tidak mengganggu
    if (authWrapper) {
      authWrapper.style.display = 'none';
    }
    if (logoutBtn) {
      logoutBtn.style.display = 'none';
    }
  } else {
    // JIKA FITUR LOGIN DIAKTIFKAN:
    // Tampilkan tombol status login kasir & tombol logout di pojok kanan
    if (authWrapper) {
      authWrapper.style.display = 'flex';
    }
    if (logoutBtn) {
      logoutBtn.style.display = 'inline-flex';
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

  modal.style.display = 'flex';
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
  const pinInput = document.getElementById('login-pin-input');
  if (pinInput) pinInput.value = '';
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

// Submit login kasir / owner
function submitCashierLogin() {
  const select = document.getElementById('login-cashier-select');
  const pinInput = document.getElementById('login-pin-input');
  const selectedAccount = select.value;
  const enteredPin = pinInput ? pinInput.value.trim() : '';

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
      alert(`✅ PIN Benar! Masuk sebagai Kasir "${staff.name}".`);
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

  localStorage.setItem('kasir_current_user_role', currentUserRole);
  localStorage.setItem('kasir_active_cashier', activeCashier);

  isLoginModalForced = false;
  const modal = document.getElementById('cashier-login-modal');
  if (modal) modal.style.display = 'none';
  updateCashierAuthUI();

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

// Tambah Akun Karyawan Baru
function addStaffAccount() {
  const nameInput = document.getElementById('new-cashier-name');
  const pinInput = document.getElementById('new-cashier-pin');
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();

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
    permissions: {
      pos: true,
      transactions: document.getElementById('perm-transactions').checked,
      products: document.getElementById('perm-products').checked,
      kulak: document.getElementById('perm-kulak').checked,
      customers: document.getElementById('perm-customers').checked,
      analytics: document.getElementById('perm-analytics').checked,
      settings: document.getElementById('perm-settings').checked
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
  renderCashierSettingsList();
  alert(`✅ Karyawan "${name}" berhasil ditambahkan dengan PIN: ${newStaff.pin}!`);
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
        <th>Nama</th>
        <th>PIN</th>
        <th>Hak Akses Menu</th>
        <th style="width: 130px; text-align: center;">Aksi</th>
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

    const permBadges = perms.map(p => `<span style="display:inline-block; background:rgba(59,130,246,0.1); color:var(--primary-color); padding:1px 6px; border-radius:4px; font-size:0.75rem; margin:1px;">${p}</span>`).join(' ');

    tr.innerHTML = `
      <td>
        <strong>${s.name}</strong>
        ${(currentUserRole === 'staff' && activeCashier === s.name) ? '<span style="color:#10b981; font-weight:700; margin-left:4px;">(Sedang Aktif)</span>' : ''}
      </td>
      <td>
        <span style="font-family: monospace; background: var(--bg-surface-elevated); padding: 2px 6px; border-radius: 4px;">••••</span>
      </td>
      <td>${permBadges || '<span style="color:red;">Hanya Kasir POS</span>'}</td>
      <td style="text-align: center;">
        <div style="display: flex; gap: 0.35rem; justify-content: center;">
          <button class="btn btn-secondary btn-sm" onclick="openEditStaffModal(${idx})" title="Edit Hak Akses & PIN" style="padding: 3px 8px; font-size: 0.78rem;">
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
  document.getElementById('edit-staff-modal-title').textContent = `Edit Hak Akses: ${staff.name}`;

  // Checklist
  document.getElementById('edit-perm-transactions').checked = !!staff.permissions.transactions;
  document.getElementById('edit-perm-products').checked = !!staff.permissions.products;
  document.getElementById('edit-perm-kulak').checked = !!staff.permissions.kulak;
  document.getElementById('edit-perm-customers').checked = !!staff.permissions.customers;
  document.getElementById('edit-perm-analytics').checked = !!staff.permissions.analytics;
  document.getElementById('edit-perm-settings').checked = !!staff.permissions.settings;

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

  if (!newName) {
    alert("Nama karyawan tidak boleh kosong!");
    return;
  }

  const staff = staffAccounts.find(s => s.name === origName);
  if (!staff) return;

  staff.name = newName;
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
    settings: document.getElementById('edit-perm-settings').checked
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
  alert(`✅ Data dan hak akses "${newName}" berhasil diperbarui!`);
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
        selectedReceiptButtonIndex = 0;
        updateReceiptButtonsHighlight();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        selectedReceiptButtonIndex = 1;
        updateReceiptButtonsHighlight();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedReceiptButtonIndex === 0) window.print();
        else closeReceiptModal();
        return;
      }
    } else if (isPaymentOpen) {
      if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setQuickCash('pass');
        return;
      }
      if (e.key === 'Enter') {
        const btnSubmit = document.getElementById('btn-submit-payment');
        if (btnSubmit && !btnSubmit.disabled) {
          e.preventDefault();
          processCheckout();
        }
        return;
      }
    }
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
  return new Intl.NumberFormat('id-ID').format(number);
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
  const todayStr = getLocalISODate(new Date()).slice(0, 10);
  
  if (startDateEl && !startDateEl.value) startDateEl.value = todayStr;
  if (endDateEl && !endDateEl.value) endDateEl.value = todayStr;
  
  const startDateVal = startDateEl ? startDateEl.value : todayStr;
  const endDateVal = endDateEl ? endDateEl.value : todayStr;
  
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
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Tidak ada transaksi ditemukan.</td></tr>`;
    return;
  }
  
  txsToRender.forEach(tx => {
    const tr = document.createElement('tr');
    
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
          <button class="action-icon-btn btn-edit" onclick="reprintReceipt('${tx.id}')" title="Cetak Uang / Reprint Nota" style="color: var(--color-primary); background-color: rgba(202,138,4,0.1);">
            <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
          </button>
          <button class="action-icon-btn btn-delete" onclick="deleteTransaction('${tx.id}')" title="Hapus Transaksi">
            <svg viewBox="0 0 24 24" class="icon-sm"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/></svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
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
    background: ${active ? 'var(--primary-color, #4f46e5)' : 'var(--bg-card, #fff)'};
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

    // Cek apakah filter tanggal mengarah ke hari selain hari ini
    const todayStr = new Date().toISOString().slice(0, 10);
    const isSearchingHistory = (startDate && startDate !== todayStr) || (endDate && endDate !== todayStr);

    // Filter lokal - data selalu up-to-date dari Realtime Database listener
    renderTransactionsTable();
  }, 600);
}

async function deleteTransaction(txId) {
  if (confirm(`Apakah Anda yakin ingin menghapus transaksi "${txId}"? Tindakan ini akan mengembalikan stok barang ke inventaris.`)) {
    const txIndex = transactions.findIndex(t => t.id === txId);
    if (txIndex === -1) {
      alert("Transaksi tidak ditemukan!");
      return;
    }
    
    const tx = transactions[txIndex];
    
    // Kembalikan stok untuk semua barang di transaksi ini
    if (Array.isArray(tx.items)) {
      tx.items.forEach(item => {
        const product = products.find(p => p.id === item.id);
        if (product) {
          product.stok += (item.isBox ? (item.qty * (item.isiBox || 1)) : (item.isGrosir ? (item.qty * (item.grosirQty || 1)) : item.qty));
          if (item.isPromo && !item.isBonus) {
            product.kuota_diskon = (parseInt(product.kuota_diskon) || 0) + item.qty;
          }
        }
      });
    }
    
    // Hapus transaksi dari cache lokal
    transactions.splice(txIndex, 1);
    
    // Simpan data
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
        // Hapus transaksi dari RTDB
        await firebaseDb.ref(getStorePath('transactions/' + txId)).remove();
        console.log('✅ Transaksi berhasil dihapus dari RTDB:', txId);

        // Update stok produk di RTDB
        if (Array.isArray(tx.items)) {
          const stockUpdates = {};
          tx.items.forEach(item => {
            const p = products.find(prod => prod.id === item.id);
            if (p) {
              stockUpdates[getStorePath('products/' + p.id + '/stok')] = p.stok;
              stockUpdates[getStorePath('products/' + p.id + '/kuota_diskon')] = p.kuota_diskon || 0;
            }
          });
          if (Object.keys(stockUpdates).length > 0) {
            await firebaseDb.ref('/').update(stockUpdates);
          }
        }
        updateSyncStatus('online', 'Database Terhubung');
      } catch (err) {
        console.error('❌ Gagal hapus transaksi dari RTDB:', err.message);
        updateSyncStatus('offline', 'Gagal hapus: ' + err.message);
      }
    }
    
    alert(`Transaksi ${txId} berhasil dihapus dan stok barang dikembalikan.`);
  }
}

function reprintReceipt(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) {
    alert("Transaksi tidak ditemukan!");
    return;
  }
  showReceipt(tx, tx.items || []);
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
  const methodSelect = document.getElementById('edit-tx-payment-method');
  if (methodSelect) methodSelect.value = metode;
  
  // Tampilkan/sembunyikan seksi cash berdasarkan metode
  const cashSection = document.getElementById('edit-tx-cash-section');
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  if (cashSection) cashSection.style.display = nonCashMethods.includes(metode) ? 'none' : 'block';
  
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
    div.className = `floating-item ${isSelected ? 'selected' : ''} ${isOutOfStock ? 'out-of-stock' : ''}`;
    div.onclick = () => {
      if (!isOutOfStock) {
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
      <img src="${imgUrl}" alt="${p.nama}" class="floating-item-img" onerror="handleImageError(this)">
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
      if (prod.stok > 0) {
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

function onEditTxPaymentMethodChange(value) {
  const nonCashMethods = ['QRIS', 'Transfer', 'Debit'];
  const cashSection = document.getElementById('edit-tx-cash-section');
  if (cashSection) cashSection.style.display = nonCashMethods.includes(value) ? 'none' : 'block';
  calculateChangeEditTx();
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
  document.getElementById('print-rep-store-name').textContent = receiptSettings.name;
  document.getElementById('print-rep-store-address').textContent = receiptSettings.address;
  
  const now = new Date();
  document.getElementById('print-rep-date').textContent = "Tanggal: " + now.toLocaleDateString('id-ID');
  document.getElementById('print-rep-timestamp').textContent = "Waktu Cetak: " + now.toLocaleString('id-ID');
  
  document.getElementById('print-rep-revenue').textContent = document.getElementById('stat-revenue').textContent;
  document.getElementById('print-rep-net-profit').textContent = document.getElementById('stat-net-profit').textContent;
  
  const printBestsellers = document.getElementById('print-rep-best-sellers');
  printBestsellers.innerHTML = '';
  const uiBestsellers = document.querySelectorAll('#best-sellers-body tr');
  uiBestsellers.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length >= 4) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="padding: 0.25rem 0; text-align: left;">${tds[1].textContent}</td>
        <td style="text-align: center;">${tds[2].textContent}</td>
        <td style="text-align: right;">${tds[3].textContent}</td>
      `;
      printBestsellers.appendChild(row);
    }
  });
  if (printBestsellers.innerHTML === '') {
    printBestsellers.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 0.5rem 0;">Belum ada penjualan.</td></tr>';
  }
  
  const printLowstocks = document.getElementById('print-rep-low-stocks');
  printLowstocks.innerHTML = '';
  const uiLowstocks = document.querySelectorAll('#stock-alerts-list li');
  uiLowstocks.forEach(li => {
    const nameEl = li.querySelector('.alert-item-name');
    const badgeEl = li.querySelector('.alert-item-badge');
    if (nameEl && badgeEl) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="padding: 0.25rem 0; text-align: left;">${nameEl.textContent}</td>
        <td style="text-align: right; font-weight: bold;">${badgeEl.textContent}</td>
      `;
      printLowstocks.appendChild(row);
    }
  });
  if (printLowstocks.innerHTML === '') {
    printLowstocks.innerHTML = '<tr><td colspan="2" style="text-align:center; padding: 0.5rem 0;">Stok aman terkendali.</td></tr>';
  }
  
  document.body.classList.add('printing-daily-report');
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

    return `
      <div class="label-item-print shelf-label" style="width: ${labelSettings.width}mm; height: ${labelSettings.height}mm;">
        <div class="label-store">${storeName}</div>
        <div class="label-name" style="${nameStyle}">${productName}</div>
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
  updateAnalytics();
  
  // Sinkronkan ke cloud
  syncSingleTransactionToCloud(tx);
}

// --- MODUL SHIFT KASIR ---

function updateShiftStatusUI() {
  const btnText = document.getElementById('shift-status-text');
  const btnStatus = document.getElementById('btn-shift-status');
  if (!btnText || !btnStatus) return;
  
  if (activeShift) {
    btnText.textContent = `Shift: Aktif (${activeShift.nama_kasir})`;
    btnStatus.style.borderColor = 'var(--primary-color)';
    btnStatus.style.color = 'var(--primary-color)';
    btnStatus.style.background = 'rgba(37, 99, 235, 0.08)';
    btnStatus.style.boxShadow = '0 0 10px rgba(37, 99, 235, 0.2)';
  } else {
    btnText.textContent = 'Buka Shift Kasir';
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
  
  if (!activeShift) {
    title.textContent = 'Buka Shift Kasir';
    let cashierOptions = cashiers.map(c => `<option value="${c}">${c}</option>`).join('');
    
    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.5rem; display: block;">Pilih Kasir</label>
          <select id="shift-kasir" class="form-control" style="width: 100%; padding: 0.75rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background: var(--bg-surface-elevated); font-size: 1rem;">${cashierOptions}</select>
        </div>
        <div class="form-group">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.5rem; display: block;">Jenis Shift</label>
          <select id="shift-jenis" class="form-control" style="width: 100%; padding: 0.75rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); background: var(--bg-surface-elevated); font-size: 1rem;">
            <option value="Shift 1 (07:00 - 15:00)">Shift 1 (07:00 - 15:00)</option>
            <option value="Shift 2 (15:00 - 21:00)">Shift 2 (15:00 - 21:00)</option>
            <option value="Shift Custom">Shift Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.5rem; display: block;">Modal Awal / Uang Laci (Rp)</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-weight: 600;">Rp</span>
            <input type="text" id="shift-modal-awal" class="form-control" placeholder="100.000" onkeyup="formatRupiahInput(this)" style="width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; border-radius: var(--border-radius-sm); border: 1px solid var(--border-color); font-size: 1.1rem; font-weight: 600;">
          </div>
        </div>
        <button class="btn btn-primary" style="width: 100%; padding: 0.85rem; font-size: 1.1rem; font-weight: 600; margin-top: 0.5rem; box-shadow: var(--shadow-md);" onclick="submitOpenShift()">🚀 Buka Shift Sekarang</button>
      </div>
    `;
  } else {
    title.textContent = 'Tutup Shift Kasir';
    
    // Hitung estimasi uang di laci
    const startTime = new Date(activeShift.waktu_buka).getTime();
    let totalUangMasuk = 0;
    
    transactions.forEach(tx => {
      const txTime = new Date(tx.waktu).getTime();
      // Hanya hitung transaksi tunai yang terjadi selama shift ini
      if (txTime >= startTime && tx.metode_pembayaran === 'Tunai') {
        const cashMasuk = tx.bayar - tx.kembalian;
        if (cashMasuk > 0) totalUangMasuk += cashMasuk;
      }
    });
    
    const estimasiLaci = activeShift.modal_awal + totalUangMasuk;
    
    body.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1.25rem;">
        <div style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(37, 99, 235, 0.05) 100%); padding: 1.5rem; border-radius: var(--border-radius-md); text-align: center; border: 1px solid rgba(59, 130, 246, 0.2);">
          <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Estimasi Uang Laci Seharusnya</p>
          <h3 style="color: var(--primary-color); font-size: 2rem; margin: 0; font-weight: 800; text-shadow: 0 2px 4px rgba(0,0,0,0.05);">Rp ${formatRupiah(estimasiLaci)}</h3>
          <div style="display: flex; justify-content: center; gap: 1rem; margin-top: 0.75rem; font-size: 0.8rem; color: var(--text-muted);">
            <span>Modal: <strong>Rp ${formatRupiah(activeShift.modal_awal)}</strong></span>
            <span>+</span>
            <span>Masuk: <strong>Rp ${formatRupiah(totalUangMasuk)}</strong></span>
          </div>
        </div>
        
        <div class="form-group">
          <label style="font-weight: 600; color: var(--text-main); margin-bottom: 0.5rem; display: block;">Hitungan Fisik Uang Laci (Rp)*</label>
          <div style="position: relative;">
            <span style="position: absolute; left: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-weight: 600;">Rp</span>
            <input type="text" id="shift-uang-fisik" class="form-control" placeholder="0" onkeyup="formatRupiahInput(this)" style="width: 100%; padding: 1rem 1rem 1rem 2.5rem; border-radius: var(--border-radius-md); border: 2px solid var(--border-color); font-size: 1.5rem; font-weight: 700; color: var(--text-main); background: var(--bg-card); transition: all 0.2s ease;">
          </div>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">Hitung seluruh uang tunai yang ada di laci saat ini.</p>
        </div>
        <button class="btn btn-primary" style="width: 100%; padding: 1rem; font-size: 1.1rem; font-weight: 700; border-radius: var(--border-radius-md); box-shadow: var(--shadow-md); background: linear-gradient(to right, var(--primary-color), var(--primary-hover)); margin-top: 0.5rem;" onclick="submitCloseShift(${totalUangMasuk}, ${estimasiLaci})">🔒 Akhiri Shift & Simpan Laporan</button>
      </div>
    `;
  }
  
  modal.classList.add('active');
}

function closeShiftModal() {
  document.getElementById('shift-modal').classList.remove('active');
}

function submitOpenShift() {
  const kasir = document.getElementById('shift-kasir').value;
  const jenis = document.getElementById('shift-jenis').value;
  const modalAwalInput = document.getElementById('shift-modal-awal').value.replace(/\./g, "");
  const modalAwal = parseFloat(modalAwalInput) || 0;
  
  activeShift = {
    id_shift: 'SH-' + Date.now().toString().slice(-8),
    nama_kasir: kasir,
    jenis_shift: jenis,
    waktu_buka: new Date().toISOString(),
    modal_awal: modalAwal,
    status: 'aktif'
  };
  
  localStorage.setItem('kasir_active_shift', JSON.stringify(activeShift));
  
  // Set active cashier in memory as well
  activeCashier = kasir;
  localStorage.setItem('kasir_active_cashier', activeCashier);
  
  updateShiftStatusUI();
  closeShiftModal();
  alert(`Shift ${jenis} berhasil dibuka oleh ${kasir}.`);
}

function submitCloseShift(totalUangMasuk, estimasiLaci) {
  const fisikInput = document.getElementById('shift-uang-fisik').value.replace(/\./g, "");
  if (!fisikInput) {
    alert("Harap masukkan hitungan fisik uang laci!");
    return;
  }
  
  const uangFisik = parseFloat(fisikInput) || 0;
  const selisih = uangFisik - estimasiLaci;
  
  const closedShift = {
    ...activeShift,
    waktu_tutup: new Date().toISOString(),
    total_uang_masuk: totalUangMasuk,
    uang_fisik: uangFisik,
    selisih: selisih,
    status: 'ditutup'
  };
  
  shifts.push(closedShift);
  localStorage.setItem('kasir_shifts', JSON.stringify(shifts));
  
  activeShift = null;
  localStorage.removeItem('kasir_active_shift');
  
  updateShiftStatusUI();
  closeShiftModal();
  
  let msg = `Shift berhasil ditutup.\nSelisih uang: Rp ${formatRupiah(selisih)}\n`;
  if (selisih < 0) msg += "(Minus / Uang Kurang)";
  else if (selisih > 0) msg += "(Lebih)";
  else msg += "(Uang Pas)";
  
  alert(msg);
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

function renderCustomersTable() {
  const tbody = document.getElementById('customer-table-body');
  if (!tbody) return;
  const search = document.getElementById('customer-search')?.value.toLowerCase() || '';
  
  tbody.innerHTML = '';
  
  const filtered = customers.filter(c => 
    String(c.nama).toLowerCase().includes(search) || 
    (c.telepon && String(c.telepon).toLowerCase().includes(search))
  );
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Tidak ada pelanggan.</td></tr>';
    return;
  }
  
  const customersToRender = search === '' ? filtered.slice(0, 50) : filtered.slice(0, 50);
  
  if (filtered.length > 50) {
    const infoTr = document.createElement('tr');
    infoTr.innerHTML = `<td colspan="4" style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem;">Ditemukan ${filtered.length} pelanggan. Menampilkan 50 teratas.</td>`;
    tbody.appendChild(infoTr);
  }
  
  customersToRender.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.nama}</strong></td>
      <td>${c.telepon || '-'}</td>
      <td><span style="background: var(--bg-body); padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600; color: var(--primary-color);">${c.poin || 0}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.5rem;" onclick="editCustomer('${c.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" style="padding: 0.25rem 0.5rem;" onclick="deleteCustomer('${c.id}')">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveCustomer(event) {
  event.preventDefault();
  
  const id = document.getElementById('edit-customer-id').value;
  const nama = document.getElementById('cust-name').value.trim();
  const telepon = document.getElementById('cust-phone').value.trim();
  const poin = parseInt(document.getElementById('cust-points').value) || 0;
  
  if (!nama) {
    alert("Nama pelanggan wajib diisi!");
    return;
  }
  
  if (id) {
    const index = customers.findIndex(c => c.id === id);
    if (index !== -1) {
      customers[index] = { ...customers[index], nama, telepon, poin };
    }
  } else {
    customers.push({
      id: 'CUST-' + Date.now(),
      nama,
      telepon,
      poin
    });
  }
  
  saveCustomersLocally();
  renderCustomersTable();
  
  // Sinkronkan ke Firebase jika terhubung
  const savedCustomer = id ? customers.find(c => c.id === id) : customers[customers.length - 1];
  if (savedCustomer) {
    saveCustomerCloud(savedCustomer);
  }
  
  resetCustomerForm();
}

function editCustomer(id) {
  const c = customers.find(x => x.id === id);
  if (!c) return;
  
  document.getElementById('edit-customer-id').value = c.id;
  document.getElementById('cust-name').value = c.nama;
  document.getElementById('cust-phone').value = c.telepon || '';
  document.getElementById('cust-points').value = c.poin || 0;
  
  document.getElementById('customer-form-title').textContent = 'Edit Pelanggan';
}

function deleteCustomer(id) {
  if (confirm("Hapus pelanggan ini?")) {
    customers = customers.filter(c => c.id !== id);
    saveCustomersLocally();
    renderCustomersTable();
    deleteCustomerCloud(id);
  }
}

function resetCustomerForm() {
  document.getElementById('customer-form').reset();
  document.getElementById('edit-customer-id').value = '';
  document.getElementById('customer-form-title').textContent = 'Tambah Pelanggan Baru';
}

function saveCustomersLocally() {
  localStorage.setItem('kasir_customers', JSON.stringify(customers));
}

function onCustomerSelectChange() {
  const name = document.getElementById('customer-name-input').value.trim();
  const customer = customers.find(c => c.nama === name);
  const infoDiv = document.getElementById('customer-points-info');
  
  if (customer) {
    infoDiv.style.display = 'block';
    document.getElementById('customer-points-balance').textContent = customer.poin || 0;
    document.getElementById('customer-points-rp').textContent = `Rp ${formatRupiah((customer.poin || 0) * loyaltySettings.rpPerPoint)}`;
  } else {
    infoDiv.style.display = 'none';
    document.getElementById('redeem-points-input').value = '';
  }
  calculateChange();
}

function saveLoyaltySettings() {
  const ptsPerRp = parseInt(document.getElementById('setting-points-per-rp').value) || 50000;
  const rpPerPt = parseInt(document.getElementById('setting-rp-per-point').value) || 1000;
  
  loyaltySettings = { pointsPerRp: ptsPerRp, rpPerPoint: rpPerPt };
  localStorage.setItem('kasir_loyalty_settings', JSON.stringify(loyaltySettings));
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
  
  const customerName = prompt('Masukkan nama pelanggan atau catatan untuk antrean ini (Opsional):', `Antrean ${heldCarts.length + 1}`);
  if (customerName === null) return; // Batal
  
  const heldItem = {
    id: 'HOLD-' + Date.now().toString().slice(-6),
    name: customerName || `Antrean ${heldCarts.length + 1}`,
    time: new Date().toISOString(),
    items: [...cart]
  };
  
  heldCarts.push(heldItem);
  saveHeldCarts();
  
  cart = [];
  renderCart();
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
            <button class="btn btn-danger btn-sm" onclick="deleteHeldCart(${index})" style="padding: 0.25rem 0.5rem;">
              <svg viewBox="0 0 24 24" class="icon-sm" style="margin:0"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
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
  setTimeout(() => {
    updateHeldCartsUI();
    loadWeeklyTrendInBackground();
  }, 1000);

  // Registrasi PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('KasirKilat PWA Service Worker terdaftar:', reg.scope);
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
