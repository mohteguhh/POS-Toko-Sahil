const crypto = require('crypto');
const readline = require('readline');

const MASTER_SALT = 'SAHIL_POS_SECURE_AUTH_2026_ANTI_PIRACY_KEY';

function generateActivationKey(hwid) {
  if (!hwid) return '';
  const cleanHwid = String(hwid).trim().toUpperCase();
  const hash = crypto.createHmac('sha256', MASTER_SALT).update(cleanHwid).digest('hex').toUpperCase();
  return `AKT-${hash.substring(0, 4)}-${hash.substring(4, 8)}-${hash.substring(8, 12)}`;
}

const args = process.argv.slice(2);
if (args.length > 0) {
  const hwid = args[0];
  const key = generateActivationKey(hwid);
  console.log('\n======================================================');
  console.log('🔑 GENERATOR KUNCI AKTIVASI KASIR POS SAHIL (DEVELOPER)');
  console.log('======================================================');
  console.log(`💻 Hardware ID Pembeli : ${hwid.toUpperCase()}`);
  console.log(`🔐 Kunci Aktivasi Resmi: ${key}`);
  console.log('======================================================');
  console.log('Kirimkan Kunci Aktivasi di atas kepada pembeli toko Anda.\n');
  process.exit(0);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\n======================================================');
console.log('🔑 GENERATOR KUNCI AKTIVASI KASIR POS SAHIL (DEVELOPER)');
console.log('======================================================');
rl.question('Masukkan Hardware ID dari komputer pembeli: ', (hwid) => {
  const key = generateActivationKey(hwid);
  console.log('\n------------------------------------------------------');
  console.log(`💻 Hardware ID Pembeli : ${hwid.toUpperCase().trim()}`);
  console.log(`🔐 Kunci Aktivasi Resmi: ${key}`);
  console.log('------------------------------------------------------');
  console.log('Kirimkan Kunci Aktivasi di atas kepada pembeli toko Anda.\n');
  rl.close();
});
