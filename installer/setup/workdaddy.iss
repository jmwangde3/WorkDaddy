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

; 没有 [Run] 段：解包与安装都在 [Code] 的 CurStepChanged(ssPostInstall) 里做。
; 理由见那里 —— [Run] 拿不到子进程退出码，装失败 Setup 照样报成功。

[UninstallRun]
; 卸载交给脚本：按安装记录逐条删，数据默认保留
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\_setup\uninstall-workdaddy.ps1"" -AppDir ""{localappdata}\Programs\WorkDaddy"" -DataDir ""{userappdata}\WorkDaddy"""; \
  Flags: waituntilterminated runhidden

[UninstallDelete]
; 只清 Setup 自己解出来的临时目录；程序文件由安装器按清单删
Type: filesandordirs; Name: "{tmp}\workdaddy-setup"

[Code]
// Step 1（解包）与 Step 2（安装）放在这里而不是 [Run]，只有一个原因：
// [Run] 无法把子进程的退出码带回来。以前安装脚本失败，Setup 仍然报「成功」，
// 用户看到的是一个装了一半、还提示装好了的程序；CI 那边也只能靠「装完有没有
// 安装记录」倒推。用 Exec 拿 ResultCode，失败就 RaiseException，让 Setup
// 自己以非零码退出 —— 这样「装失败」在系统层面就是一个可观测的事实。
//
// 顺序注意：CurStepChanged(ssPostInstall) 在 [Run] 之前执行，所以两步必须
// 都在这里，不能一步在 [Code] 一步在 [Run]。

procedure SetStatusText(const Text: String);
begin
  if Assigned(WizardForm) then
    if Assigned(WizardForm.StatusLabel) then
      WizardForm.StatusLabel.Caption := Text;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  SetupDir, PayloadDir, ZipPath, AppDir, DataDir, Args: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  SetupDir   := ExpandConstant('{tmp}\workdaddy-setup');
  ZipPath    := SetupDir + '\payload.zip';
  PayloadDir := SetupDir + '\payload';
  AppDir     := ExpandConstant('{localappdata}\Programs\WorkDaddy');
  DataDir    := ExpandConstant('{userappdata}\WorkDaddy');

  // ---- Step 1：解包 ----
  SetStatusText('正在解包...');
  Args := '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '''
        + ZipPath + ''' -DestinationPath ''' + PayloadDir + ''' -Force"';
  if not Exec('powershell.exe', Args, SetupDir, SW_HIDE, ewWaitUntilTerminated, Code) then
    RaiseException('无法启动解包步骤（powershell.exe 调用失败）');
  if Code <> 0 then
    RaiseException('解包失败：powershell 返回 ' + IntToStr(Code));

  // ---- Step 2：走测试过的安装器 ----
  // -Json / -Trace 都落在数据目录：Setup 退出时不会删它，失败后还能查。
  SetStatusText('正在安装 WorkDaddy...');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + PayloadDir + '\installer\install-workdaddy.ps1"'
        + ' -SourceDir "' + PayloadDir + '"'
        + ' -AppDir "' + AppDir + '"'
        + ' -DataDir "' + DataDir + '"'
        + ' -Json "' + DataDir + '\install-report.json"'
        + ' -Trace "' + DataDir + '\install-trace.log"';
  if not Exec('powershell.exe', Args, PayloadDir, SW_HIDE, ewWaitUntilTerminated, Code) then
    RaiseException('无法启动安装脚本（powershell.exe 调用失败）');
  if Code <> 0 then
    RaiseException('安装脚本返回 ' + IntToStr(Code)
      + '。详见 ' + DataDir + '\install-report.json 与 install-trace.log');
end;
