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
  echo 请先在项目目录运行以下 PowerShell 命令重新生成：
  echo   "protocol=https`nhost=github.com`n" ^| git credential fill ^| Select-String '^password='
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
echo 提醒：发布新版本前，记得先改 package.json 里的 version（如 2.0.1 改 2.0.2），
echo       否则用户收不到更新提示！
echo.
set /p CONFIRM=确认发布？(y/n): 
if /i not "%CONFIRM%"=="y" exit /b 0

echo.
echo [1/2] 正在打包并上传（安装包约120MB，需要几分钟）...
call npx electron-builder --win nsis --publish always
if errorlevel 1 (
  echo.
  echo 打包/上传失败！请把上方错误信息发给开发者。
  pause
  exit /b 1
)

echo.
echo [2/2] 整理 Release（清理重复草稿并正式发布）...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$token = Get-Content '.publish-token' -Raw;" ^
  "$headers = @{ Authorization = ('token ' + $token); 'User-Agent' = 'qiankun-publish' };" ^
  "$api = 'https://api.github.com/repos/wangzhendong861925758/qiankun-design/releases';" ^
  "$rels = Invoke-RestMethod -Uri $api -Headers $headers;" ^
  "$drafts = @($rels ^| Where-Object { $_.draft });" ^
  "$byTag = $drafts ^| Group-Object tag_name;" ^
  "foreach ($g in $byTag) {" ^
  "  if ($g.Count -gt 1) {" ^
  "    $keep = $g.Group ^| Sort-Object { ($_.assets ^| Measure-Object).Count } -Descending ^| Select-Object -First 1;" ^
  "    foreach ($d in $g.Group) { if ($d.id -ne $keep.id) { Invoke-RestMethod -Method Delete -Uri ($api + '/' + $d.id) -Headers $headers ^| Out-Null; echo ('  已清理重复草稿: ' + $d.tag_name) } }" ^
  "  }" ^
  "}" ^
  "$rels = Invoke-RestMethod -Uri $api -Headers $headers;" ^
  "$drafts = @($rels ^| Where-Object { $_.draft });" ^
  "foreach ($d in $drafts) { $body = @{ draft = $false; prerelease = $false } ^| ConvertTo-Json; Invoke-RestMethod -Method Patch -Uri ($api + '/' + $d.id) -Headers $headers -Body $body -ContentType 'application/json' ^| Out-Null; echo ('  已正式发布: ' + $d.tag_name) };" ^
  "if ($drafts.Count -eq 0) { echo '  没有草稿需要处理（可能已发布）' }"

echo.
echo ============================================
echo   发布成功！
echo ============================================
echo 下载页: https://github.com/wangzhendong861925758/qiankun-design/releases
echo.
echo 已安装用户打开软件后会自动收到更新提示，
echo 点击「保存并重启安装」即可升级，数据不丢。
echo.
echo 注意：刚发布的前几分钟，更新检测可能因 GitHub CDN 缓存而暂时查不到，
echo       等几分钟再测即可。
echo.
pause
