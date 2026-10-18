const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

let mainWindow;

// 1. Dapatkan Hardware ID Unik Mesin (Motherboard / CPU / Network)
function getHardwareId() {
  try {
    const networkInterfaces = os.networkInterfaces();
    let mac = '';
    for (const key in networkInterfaces) {
      for (const net of networkInterfaces[key]) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          mac = net.mac;
          break;
        }
      }
      if (mac) break;
    }
    const rawId = `${os.hostname()}-${os.platform()}-${os.arch()}-${mac || 'NOMAC'}`;
    return crypto.createHash('sha256').update(rawId).digest('hex').substring(0, 16).toUpperCase();
  } catch (e) {
    return 'UNKNOWN-HWID-001';
  }
}

// Rahasia Master Salt (Hanya diketahui oleh Pemilik Aplikasi / Developer)
const MASTER_SALT = 'SAHIL_POS_SECURE_AUTH_2026_ANTI_PIRACY_KEY';

// Generator Activation Key Resmi berdasarkan Hardware ID
function generateActivationKey(hwid) {
  if (!hwid) return '';
  const cleanHwid = String(hwid).trim().toUpperCase();
  const hash = crypto.createHmac('sha256', MASTER_SALT).update(cleanHwid).digest('hex').toUpperCase();
  // Format cantik: AKT-XXXX-XXXX-XXXX
  return `AKT-${hash.substring(0, 4)}-${hash.substring(4, 8)}-${hash.substring(8, 12)}`;
}

// 2. Folder Database Lokal & Folder Patch Pembaruan di UserData (AppData)
const userDataPath = app.getPath('userData');
const dbFilePath = path.join(userDataPath, 'kasir_local_database.json');
const updatesDir = path.join(userDataPath, 'app_updates');
const activationFilePath = path.join(userDataPath, 'device_activation.json');

function checkDeviceActivation() {
  try {
    const hwid = getHardwareId();
    const validKey = generateActivationKey(hwid);
    
    if (fs.existsSync(activationFilePath)) {
      const data = JSON.parse(fs.readFileSync(activationFilePath, 'utf8'));
      if (data && data.activationKey && data.activationKey.trim().toUpperCase() === validKey) {
        return { isActivated: true, hwid: hwid };
      }
    }
    return { isActivated: false, hwid: hwid };
  } catch (e) {
    return { isActivated: false, hwid: getHardwareId() };
  }
}

function saveDeviceActivation(inputKey) {
  try {
    const hwid = getHardwareId();
    const validKey = generateActivationKey(hwid);
    const cleanKey = String(inputKey).trim().toUpperCase();

    if (cleanKey === validKey) {
      fs.writeFileSync(activationFilePath, JSON.stringify({
        hwid: hwid,
        activationKey: cleanKey,
        activatedAt: new Date().toISOString()
      }, null, 2), 'utf8');
      return { success: true, message: 'Aktivasi perangkat berhasil!' };
    } else {
      return { success: false, message: 'Kunci aktivasi salah atau tidak sesuai untuk perangkat ini!' };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Pastikan folder updates tersedia
if (!fs.existsSync(updatesDir)) {
  fs.mkdirSync(updatesDir, { recursive: true });
}

// Helper Baca & Simpan Database Lokal
function readLocalDb() {
  try {
    if (fs.existsSync(dbFilePath)) {
      return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Gagal membaca db lokal:', err);
  }
  return {};
}

function writeLocalDb(data) {
  try {
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('Gagal menulis db lokal:', err);
    return { success: false, error: err.message };
  }
}

// Fungsi untuk menentukan entry file index.html (Utamakan dari patch updates jika ada)
function getAppEntryPath() {
  const patchedIndexPath = path.join(updatesDir, 'index.html');
  if (fs.existsSync(patchedIndexPath)) {
    console.log('🚀 Memuat aplikasi dari folder patch update:', patchedIndexPath);
    return patchedIndexPath;
  }
  // Default bawaan installer .exe
  const defaultIndexPath = path.join(__dirname, 'index.html');
  console.log('🚀 Memuat aplikasi dari paket bawaan:', defaultIndexPath);
  return defaultIndexPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    title: "Aplikasi Kasir POS Sahil",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.maximize();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Gagal memuat halaman:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('Render process crash/gone:', details);
  });

  // Dukung cetak struk/laporan popup (window.open) dan link eksternal (WhatsApp, Browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Jika URL WhatsApp atau link web eksternal, buka di browser default pengguna
    if (url.startsWith('https://wa.me') || url.startsWith('https://api.whatsapp.com') || url.startsWith('http://') || url.startsWith('https://')) {
      if (!url.includes('localhost') && !url.includes('127.0.0.1')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }
    // Izinkan popup window untuk Cetak Nota, Cetak Laporan, Price Checker, dan ID Card
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      }
    };
  });

  const entryFile = getAppEntryPath();
  mainWindow.loadFile(entryFile);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC HANDLERS UNTUK KOMUNIKASI FRONTEND DENGAN SISTEM DESKTOP ---

// 1. Ambil Hardware ID
ipcMain.handle('get-hardware-id', () => {
  return getHardwareId();
});

// 2. Baca Database Lokal
ipcMain.handle('db-get-all', () => {
  return readLocalDb();
});

// 3. Simpan Database Lokal
ipcMain.handle('db-save-all', (event, data) => {
  return writeLocalDb(data);
});

// 4. Buka Dialog File Pembaruan Offline (.patch / .zip)
ipcMain.handle('select-update-patch', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih File Pembaruan Aplikasi (.patch / .zip)',
    filters: [
      { name: 'File Pembaruan Kasir', extensions: ['patch', 'zip'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const selectedPath = result.filePaths[0];
  try {
    const zip = new AdmZip(selectedPath);
    // Ekstrak patch ke folder app_updates di AppData yang bebas izin tulis
    zip.extractAllTo(updatesDir, true);
    return { success: true, message: 'Pembaruan offline berhasil dipasang! Silakan restart aplikasi.' };
  } catch (err) {
    return { success: false, error: 'Gagal mengekstrak file pembaruan: ' + err.message };
  }
});

// 5. Terapkan Pembaruan Online dari Buffer / File
ipcMain.handle('apply-online-update', async (event, arrayBuffer) => {
  try {
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    // Ekstrak patch ke folder app_updates di AppData yang bebas izin tulis
    zip.extractAllTo(updatesDir, true);
    return { success: true, message: 'Pembaruan online berhasil dipasang! Silakan restart aplikasi.' };
  } catch (err) {
    return { success: false, error: 'Gagal menerapkan pembaruan online: ' + err.message };
  }
});

// 6. Restart Aplikasi Kasir
ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

// 7. Pilih Folder Backup Database Native (Windows Explorer)
ipcMain.handle('select-backup-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih Folder untuk Menyimpan Cadangan Database Kasir',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const folderPath = result.filePaths[0];
  try {
    const metaPath = path.join(userDataPath, 'backup_folder_path.txt');
    fs.writeFileSync(metaPath, folderPath, 'utf8');
  } catch(e) {}
  return { success: true, folderPath: folderPath, folderName: path.basename(folderPath) };
});

// 8. Tulis File Backup Langsung ke Folder Fisik Komputer
ipcMain.handle('save-backup-file', async (event, fileName, content) => {
  try {
    let targetFolder = '';
    const metaPath = path.join(userDataPath, 'backup_folder_path.txt');
    if (fs.existsSync(metaPath)) {
      targetFolder = fs.readFileSync(metaPath, 'utf8').trim();
    }

    if (!targetFolder || !fs.existsSync(targetFolder)) {
      // Fallback ke folder 'backup database' di userData jika belum disetel
      targetFolder = path.join(userDataPath, 'backup database');
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
      }
    }

    const fullFilePath = path.join(targetFolder, fileName);
    fs.writeFileSync(fullFilePath, content, 'utf8');
    return { success: true, path: fullFilePath };
  } catch (err) {
    console.error('Gagal menulis file backup:', err);
    return { success: false, error: err.message };
  }
});

// 9. Cek Status Aktivasi Perangkat
ipcMain.handle('check-device-activation', () => {
  return checkDeviceActivation();
});

// 10. Verifikasi & Simpan Kunci Aktivasi Perangkat
ipcMain.handle('activate-device', (event, activationKey) => {
  return saveDeviceActivation(activationKey);
});


