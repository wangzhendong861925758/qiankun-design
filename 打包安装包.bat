@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 乾坤设计 - 打包安装包

echo ============================================
echo   乾坤设计 - 打包 Windows 安装包
echo ============================================
echo.

REM 使用国内镜像，避免下载失败
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_CACHE=%cd%\.electron-cache
set electron_config_cache=%cd%\.electron-cache

echo [1/2] 正在打包（首次较慢，之后有缓存）...
call npx electron-builder --win nsis --publish never
if errorlevel 1 (
  echo.
  echo 打包失败！请把上方错误信息发给开发者。
  pause
  exit /b 1
)

echo.
echo [2/2] 打包完成！
echo.
echo 安装包位置:  dist\乾坤设计-Setup-x.x.x.exe
echo 免安装目录:  dist\win-unpacked\乾坤设计.exe
echo.
echo 提示: 发布新版本前，记得先在 package.json 中把 version 提高一位（如 1.0.0 改 1.0.1）
echo.
pause
