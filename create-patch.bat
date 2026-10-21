@echo off
title Generator Patch Pembaruan Offline - Kasir Toko Sahil
color 0A
cls
echo =========================================================
echo       GENERATOR FILE PATCH OFFLINE - TOKO SAHIL POS
echo =========================================================
echo.
echo Sedang mengemas file pembaruan terbaru...
echo.

node make-patch.js

if %ERRORLEVEL% EQU 0 (
    echo.
    echo =========================================================
    echo [SUKSES] File patch berhasil dibuat di folder ini!
    echo Berkas: patch_latest.zip
    echo =========================================================
) else (
    echo.
    echo =========================================================
    echo [GAGAL] Terjadi kesalahan saat membuat file patch.
    echo Pastikan Node.js terpasang dengan benar di komputer ini.
    echo =========================================================
)

echo.
echo Tekan tombol apa saja untuk keluar...
pause >nul
