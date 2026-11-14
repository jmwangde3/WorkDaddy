; WorkDaddy Setup（Inno Setup 6）
;
; 定位：**引导器**，不自带第二套安装逻辑。
; 它只做三件事：把便携包解到临时目录 → 调 installer\install-workdaddy.ps1 装到本机 → 登记卸载入口。
; 复制文件、校验哈希、写安装记录、迁移旧补丁配置全部复用已经过测试的那条路径，
; 避免 Setup 与脚本两条安装逻辑各自漂移。
;
; 编译：
;   ISCC.exe /DAppVersion=1.3.0 /DRepoRoot=<仓库根> /DOutDir=<输出目录> installer\setup\workdaddy.iss
; installer\build-package.ps1 -Setup 会自动带上这三个参数。
;
; ⚠ 本文件尚未在真机编译验证：开发机没有 Inno Setup 6。首次真正发 Setup 前
;   必须在装有 ISCC 的机器上跑一遍，并实测安装/卸载/保留数据三条路径。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef RepoRoot
  #define RepoRoot "..\.."
#endif
#ifndef OutDir
  #define OutDir "..\..\release\dist"
#endif

#define AppName "WorkDaddy"
#define AppPublisher "WorkDaddy fork (personal build)"
#define PayloadName "WorkDaddy-" + AppVersion + "-portable-win-x64.zip"

[Setup]
AppId={{8D3F1C42-5B7A-4E19-9C2D-4B7A1E0F0001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\WorkDaddy
DisableDirPage=yes
DisableProgramGroupPage=yes
; 装到当前用户目录，不需要管理员
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=WorkDaddy-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 数据在 %APPDATA%\WorkDaddy，卸载默认保留
UninstallDisplayName={#AppName} {#AppVersion}

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Default.isl"

[Files]
; 单个自解压载荷：与 portable zip 完全一致，哈希已写进 SHA256SUMS.txt
Source: "{#OutDir}\{#PayloadName}"; DestDir: "{tmp}\workdaddy-setup"; DestName: "payload.zip"; Flags: deleteafterinstall
; 卸载器（连同它依赖的函数库）落在 {app}\_setup：便携载荷装完就删了，
; 卸载时必须有一份现成的脚本可用。这两个文件由 Inno 自己登记，卸载时自动清掉。
Source: "{#RepoRoot}\installer\uninstall-workdaddy.ps1"; DestDir: "{app}\_setup"; Flags: ignoreversion
Source: "{#RepoRoot}\installer\lib\common.ps1"; DestDir: "{app}\_setup\lib"; Flags: ignoreversion

[Run]
; Step 1：解包
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Expand-Archive -LiteralPath '{tmp}\workdaddy-setup\payload.zip' -DestinationPath '{tmp}\workdaddy-setup\payload' -Force"""; \
  StatusMsg: "正在解包..."; Flags: waituntilterminated runhidden
; Step 2：走测试过的安装器（快捷方式、数据初始化、安装记录都由它负责）
; -Json 写到数据目录：Inno 的 [Run] 不传递子进程退出码，安装失败在 Setup 层面
; 看不出来。这份报告是唯一的失败线索，verify-setup.ps1 会读它。
; 不用 {tmp}：那是 Inno 自己的临时子目录，Setup 退出时会被删掉。
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\workdaddy-setup\payload\installer\install-workdaddy.ps1"" -SourceDir ""{tmp}\workdaddy-setup\payload"" -AppDir ""{localappdata}\Programs\WorkDaddy"" -DataDir ""{userappdata}\WorkDaddy"" -Json ""{userappdata}\WorkDaddy\install-report.json"""; \
  StatusMsg: "正在安装 WorkDaddy..."; Flags: waituntilterminated

[UninstallRun]
; 卸载交给脚本：按安装记录逐条删，数据默认保留
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\_setup\uninstall-workdaddy.ps1"" -AppDir ""{localappdata}\Programs\WorkDaddy"" -DataDir ""{userappdata}\WorkDaddy"""; \
  Flags: waituntilterminated runhidden

[UninstallDelete]
; 只清 Setup 自己解出来的临时目录；程序文件由安装器按清单删
Type: filesandordirs; Name: "{tmp}\workdaddy-setup"
