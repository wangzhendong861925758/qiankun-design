@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 乾坤设计 - 发布新版本

echo ============================================
echo   乾坤设计 - 发布新版本到 GitHub
echo ============================================
echo.

REM 读取本地保存的 Token
if not exist ".publish-token" (
  echo [错误] 找不到 .publish-token 文件！
  echo 请先在项目目录运行以下命令生成它：
  echo   powershell -Command "'^protocol=https^nhost=github.com^n' ^| git credential fill"
  echo 或者重新登录一次 GitHub（git push 会自动保存凭证）。
  pause
  exit /b 1
)

for /f "usebackq delims=" %%i in (".publish-token") do set GH_TOKEN=%%i

REM 国内镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_CACHE=%cd%\.electron-cache
set electron_config_cache=%cd%\.electron-cache

echo 当前版本号:
findstr /b "version" package.json
echo.
echo 提醒：发布新版本前，记得先改 package.json 里的 version（如 1.0.0 改 1.0.1），
echo       否则用户收不到更新提示！
echo.
set /p CONFIRM=确认发布？(y/n): 
if /i not "%CONFIRM%"=="y" exit /b 0

echo.
echo 正在打包并上传（安装包约120MB，上传需要几分钟）...
call npx electron-builder --win nsis --publish always
if errorlevel 1 (
  echo.
  echo 发布失败！请把上方错误信息发给开发者。
  pause
  exit /b 1
)

echo.
echo ============================================
echo   发布成功！
echo ============================================
echo 用户打开软件后会自动收到更新提示，
echo 点击「重启并安装」即可升级到最新版。
echo.
pause
