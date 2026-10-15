const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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

// 2. Folder Database Lokal & File Path
const userDataPath = app.getPath('userData');
const dbFilePath = path.join(userDataPath, 'kasir_local_database.json');
const updateMetaPath = path.join(userDataPath, 'app_version_info.json');

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
  mainWindow.loadFile('index.html');
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
    // Ekstrak patch ke direktori aplikasi
    zip.extractAllTo(__dirname, true);
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
    zip.extractAllTo(__dirname, true);
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
