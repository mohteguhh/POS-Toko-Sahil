@echo off
setlocal EnableDelayedExpansion
title Auto Push to GitHub

echo ========================================================
echo         AUTO UPDATE DAN PUSH KE GITHUB
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/3] Menyiapkan file perubahan...
git status -s
echo.

git add -A

set COMMIT_MSG=Update %DATE% %TIME%

echo [2/3] Menyimpan snapshot perubahan (Commit)...
git commit -m "%COMMIT_MSG%"
echo.

echo [3/3] Mengupload ke GitHub (branch main)...
echo Mohon tunggu, proses transfer sedang berjalan...
echo.
git push origin main

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo  [BERHASIL] Seluruh file sukses diupload ke GitHub!
    echo ========================================================
) else (
    echo.
    echo ========================================================
    echo  [GAGAL] Terjadi kesalahan saat upload ke GitHub.
    echo  Pastikan koneksi internet aktif dan akun GitHub terhubung.
    echo ========================================================
)

echo.
echo ========================================================
echo Proses telah selesai.
echo Silakan tekan tombol sembarang untuk keluar...
echo ========================================================
pause >nul
