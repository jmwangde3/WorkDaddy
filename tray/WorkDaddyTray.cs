// WorkDaddyTray.cs — WorkBuddy 多账号切换器（WorkDaddy）系统托盘控制器
//
// 目标框架：.NET Framework 4.x（用系统自带 csc.exe 编译，无需 Visual Studio / NuGet）
// 构建：tray\build.cmd
// 产物：tray\WorkDaddyTray.exe（Windows GUI 子系统，无控制台窗口）
//
// 功能：
//   * 托盘图标（绿=运行中 / 灰=已停止 / 橙=切换中），运行时绘制，无外部 .ico
//   * 右键菜单：状态 / 启动 / 关闭 / 重启 / 恢复 CDP / 开机自启动 / 打开管理页 / 退出托盘
//   * 单实例 Mutex：已在运行时再启动一次静默退出（不弹「已在运行」模态框）
//   * 桌面快捷方式 WorkDaddy.lnk 直接指向本 exe —— 托盘就是唯一入口；
//     安装器不再生成 launcher-hidden.vbs 那条 wscript 链
//   * 启动走 node watchdog.js（不经 cmd / launcher.cmd），不弹窗、不 pause、
//     不重启 WorkBuddy 窗口；CDP/面板注入交给「恢复 CDP」菜单项
//   * 停止逻辑：按命令行精确匹配 WorkDaddy\scripts\(watchdog|daemon).js，
//     先 watchdog 后 daemon，循环 4 轮压住 watchdog 的自动重启；不误伤其它 node.exe
//   * 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 的 'WorkDaddyTray'
//     指向本 exe + /autostart；名字避开上游清理的 'WorkDaddy' / 'WorkDaddy AI'
//   * /autostart：登录自启触发，约 6 秒后若服务未运行则自动拉起一次
//   * /start：桌面快捷方式用，语义同 /autostart（确保服务在跑），只是名字更贴切
//   * 命令行动作（结果同时写入 %TEMP%\WorkDaddyTray-cli.txt，便于自动化验证）：
//       --status / --selftest / --start / --stop / --restart / --autoon / --autooff
//
// 注意：C# 5 语法（Framework 4.0 自带编译器），不使用字符串插值 / ?. / out var。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace WorkDaddyTray
{
    internal struct WdProc
    {
        public int Pid;
        public int Role; // 0 = watchdog, 1 = daemon
    }

    internal static class Program
    {
        private const string MutexName = @"Local\WorkDaddyTraySingleton";
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "WorkDaddyTray";
        // 端口与 node 路径可在测试里覆盖：隔离目录里要验证「真实的启动链到底传了什么
        // 环境变量」，就不能让 47832 上已经在跑的真实服务把 StartWd 短路掉。
        // 生产路径不设这两个变量，行为与常量完全一致。
        private static int DaemonPort = 47832;
        private static int CdpPort = 9222;
        private static string DaemonUri = "http://127.0.0.1:47832";
        private const int AttachParentProcess = -1;

        // 四个客户端 profile 的白名单。这里必须是精确列表，不能用「形如 id」的正则：
        // 这个值会被写进子进程环境并决定 daemon 接管哪个客户端。
        private static readonly string[] ProfileIds =
        {
            "workbuddy-cn", "workbuddy-ai", "codebuddy-cn", "codebuddy-intl",
        };

        private static readonly Regex WdRegex =
            new Regex(@"WorkDaddy[\\/]scripts[\\/](watchdog|daemon)\.js", RegexOptions.IgnoreCase);

        private static readonly List<Bitmap> IconBitmaps = new List<Bitmap>();

        private static string s_scripts;
        private static string s_launcher;
        private static string s_watchdog;
        // 从托盘启动后台服务时显式传给 watchdog 的绑定。托盘由 explorer 拉起，
        // 环境里没有 WBSWITCH_*，靠继承会把 daemon 送进「默认 profile + 默认数据目录」。
        private static string s_profile = "workbuddy-cn";
        private static string s_dataDir = "";
        private static string s_bindingSource = "default";
        // 绑定不合法（显式环境变量非法 / 绑定文件损坏）时的原因。非空即拒绝启动服务：
        // 宁可不启动，也不能把 daemon 送进别的 profile 的数据目录。
        private static string s_bindingError = "";
        private static string s_installRoot = "";
        private static string s_startError = "";
        private static NotifyIcon s_notify;
        private static ContextMenuStrip s_menu;
        private static System.Windows.Forms.Timer s_timer;
        private static ApplicationContext s_context;
        private static Icon s_iconRun;
        private static Icon s_iconStop;
        private static Icon s_iconBusy;
        private static ToolStripMenuItem s_status;
        private static ToolStripMenuItem s_start;
        private static ToolStripMenuItem s_stop;
        private static ToolStripMenuItem s_restart;
        private static ToolStripMenuItem s_cdp;
        private static ToolStripMenuItem s_auto;
        private static ToolStripMenuItem s_open;
        private static volatile bool s_busy;
        private static int s_autoTick;
        private static bool s_autoStartDone;
        private static bool s_waitingCdp;
        private static int s_cdpWaitTicks;
        private static volatile bool s_cdpRequestFailed;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        [STAThread]
        private static void Main(string[] args)
        {
            ApplyTestHooks();
            s_scripts = ResolveScripts();
            s_launcher = Path.Combine(s_scripts, "launcher.cmd");
            s_watchdog = Path.Combine(s_scripts, "watchdog.js");
            ResolveLaunchBinding();

            if (args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal))
            {
                RunCli(args[0]);
                return;
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // 桌面快捷方式直接指向本 exe，托盘已在运行时再点一次是常态。
                    // 弹「已在运行」模态框会让用户以为启动失败，静默退出即可。
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                BuildUi();

                bool autoStart = args.Any(a =>
                    string.Equals(a, "/autostart", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "/start", StringComparison.OrdinalIgnoreCase));

                RunGui(autoStart);
                mutex.ReleaseMutex();
            }
        }

        // ------------------------------------------------------------ 路径
        // 只给自动化测试用的两个注入口：隔离目录里要跑真实的 StartWd，就不能让
        // 「本机真实服务已在 47832 上跑着」把启动短路掉，也不能依赖机器上的 node 布局。
        // 生产环境不设这两个变量，取值与常量一致。
        private static void ApplyTestHooks()
        {
            string portText = Environment.GetEnvironmentVariable("WORKDADDY_TRAY_PORT");
            int port;
            if (!string.IsNullOrEmpty(portText) && int.TryParse(portText, out port) && port > 0 && port < 65536)
            {
                DaemonPort = port;
                DaemonUri = "http://127.0.0.1:" + port;
            }
            string cdpText = Environment.GetEnvironmentVariable("WORKDADDY_TRAY_CDP_PORT");
            if (!string.IsNullOrEmpty(cdpText) && int.TryParse(cdpText, out port) && port > 0 && port < 65536)
            {
                CdpPort = port;
            }
        }

        private static string ResolveScripts()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string env = Environment.GetEnvironmentVariable("WORKDADDY_SCRIPTS");
            string[] candidates =
            {
                env,
                Path.Combine(local, @"Programs\WorkDaddy\scripts"),
                Path.Combine(local, @"Programs\WorkDaddy AI\scripts"),
                Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "scripts"))
            };
            foreach (string c in candidates)
            {
                if (string.IsNullOrEmpty(c)) continue;
                try
                {
                    if (File.Exists(Path.Combine(c, "daemon.js"))) return c;
                }
                catch { }
            }
            return Path.Combine(local, @"Programs\WorkDaddy\scripts");
        }

        // ------------------------------------------------------------ 绑定
        // 后台服务的 profile 与数据目录必须在启动时显式给出。托盘由 explorer 拉起，
        // 进程环境里没有 WBSWITCH_PROFILE / WBSWITCH_DATA_DIR；只靠继承的话 daemon
        // 会落到「默认 profile + 默认数据目录」，而 Windows 通用安装路径
        // （如 H:\Program Files\WorkBuddy）没有 CN/AI 路径强信号，CDP 归属判定
        // 在「无强信号 + 未显式绑定」处一律拒绝 —— 现象就是注入永久失败：
        // /api/inject 一直返回「CDP 未连接」，日志只剩「跳过同族页面清理」。
        //
        // 取值优先级：
        //   1. 显式环境变量（启动器 / 命令行）—— 设了就必须合法，非法直接拒绝启动；
        //   2. 本安装实例的 <AppDir>\install-binding.json；
        //   3. 旧版 %APPDATA%\WorkDaddy\install-state.json（兼容老安装）；
        //   4. 都没有才用默认 profile + 默认数据目录。
        //
        // 为什么不是直接读 install-state.json：它在 DataDir 里，而 DataDir 允许
        // 自定义（-DataDir E:\WorkDaddyData）。托盘按 %APPDATA% 固定路径读，就会
        // 读到另一个实例的记录、或者什么都读不到。绑定文件跟着程序走，才是
        // 「这一份安装」的身份。
        private static void ResolveLaunchBinding()
        {
            string envProfile = Environment.GetEnvironmentVariable("WBSWITCH_PROFILE");
            string envDataDir = Environment.GetEnvironmentVariable("WBSWITCH_DATA_DIR");

            try { s_installRoot = Path.GetFullPath(Path.Combine(s_scripts, "..")); }
            catch { s_installRoot = ""; }

            string bindProfile = "";
            string bindDataDir = "";
            string bindAppDir = "";
            string bindError = "";
            string bindFile = string.IsNullOrEmpty(s_installRoot)
                ? "" : Path.Combine(s_installRoot, "install-binding.json");
            if (!string.IsNullOrEmpty(bindFile) && File.Exists(bindFile))
            {
                bindError = ReadBindingFile(bindFile, out bindProfile, out bindDataDir, out bindAppDir);
            }

            string legacyProfile = "";
            string legacyDataDir = "";
            try
            {
                string stateFile = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "WorkDaddy", "install-state.json");
                if (File.Exists(stateFile))
                {
                    string text = File.ReadAllText(stateFile);
                    legacyProfile = JsonStringField(text, "clientProfile");
                    legacyDataDir = JsonStringField(text, "dataDir");
                }
            }
            catch { }

            // 1) 显式 profile。设了却非法 → 拒绝启动，不静默换一个 profile。
            if (!string.IsNullOrEmpty(envProfile))
            {
                if (!IsKnownProfile(envProfile))
                {
                    s_bindingError = "环境变量 WBSWITCH_PROFILE 非法：" + envProfile +
                        "（只接受 " + string.Join(" / ", ProfileIds) + "）";
                    s_bindingSource = "env(invalid)";
                    return;
                }
                s_profile = envProfile;
                s_bindingSource = "env";
            }
            else if (!string.IsNullOrEmpty(bindProfile))
            {
                s_profile = bindProfile;
                s_bindingSource = "install-binding.json";
            }
            else if (!string.IsNullOrEmpty(legacyProfile))
            {
                if (!IsKnownProfile(legacyProfile))
                {
                    s_bindingError = "安装记录里的 clientProfile 非法：" + legacyProfile;
                    s_bindingSource = "install-state.json(invalid)";
                    return;
                }
                s_profile = legacyProfile;
                s_bindingSource = "install-state.json";
            }

            // 绑定文件存在但内容不合法 → 同样拒绝。损坏的绑定不能被当成「没有绑定」。
            if (string.IsNullOrEmpty(envProfile) && !string.IsNullOrEmpty(bindError))
            {
                s_bindingError = "安装绑定文件不可用：" + bindError;
                s_bindingSource = "install-binding.json(invalid)";
                return;
            }

            // 2) 数据目录：显式环境变量 > 绑定文件 > 旧记录 > 默认。
            string dataDir = "";
            string dataSource = "";
            if (!string.IsNullOrEmpty(envDataDir))
            {
                dataDir = envDataDir;
                dataSource = "env";
            }
            else if (!string.IsNullOrEmpty(bindDataDir))
            {
                dataDir = bindDataDir;
                dataSource = "install-binding.json";
            }
            else if (!string.IsNullOrEmpty(legacyDataDir))
            {
                dataDir = legacyDataDir;
                dataSource = "install-state.json";
            }

            if (!string.IsNullOrEmpty(dataDir))
            {
                string normalized = NormalizeDataDir(dataDir);
                if (string.IsNullOrEmpty(normalized))
                {
                    s_bindingError = "数据目录不是完整的绝对路径：" + dataDir + "（来源：" + dataSource + "）";
                    s_bindingSource = dataSource + "(invalid)";
                    return;
                }
                s_dataDir = normalized;
            }

            // 绑定文件自称的 appDir 必须就是这一份安装：否则是别的实例的文件被搬过来了。
            if (!string.IsNullOrEmpty(bindAppDir) && !string.IsNullOrEmpty(s_installRoot) &&
                !string.Equals(Path.GetFullPath(bindAppDir).TrimEnd('\\'),
                               Path.GetFullPath(s_installRoot).TrimEnd('\\'),
                               StringComparison.OrdinalIgnoreCase))
            {
                s_bindingError = "安装绑定文件属于另一个安装：" + bindAppDir + "（当前 " + s_installRoot + "）";
                s_bindingSource = "install-binding.json(foreign)";
            }
        }

        private static bool IsKnownProfile(string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            foreach (string p in ProfileIds)
            {
                if (string.Equals(p, id, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        // Windows 完整绝对路径。Path.IsPathRooted 对盘符相对路径（C 冒号 + 相对段）
        // 和根相对路径都返回 true，但两者都相对当前目录/当前盘，不能当校验用。
        private static bool IsFullWindowsPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            if (Regex.IsMatch(value, @"^[A-Za-z]:(?![\\/])")) return false;
            if (Regex.IsMatch(value, @"^[\\/](?![\\/])")) return false;
            if (Regex.IsMatch(value, @"^\\\\[^\\/]+[\\/][^\\/]+")) return true;
            return Regex.IsMatch(value, @"^[A-Za-z]:[\\/]");
        }

        private static string NormalizeDataDir(string value)
        {
            if (!IsFullWindowsPath(value)) return "";
            try
            {
                string full = Path.GetFullPath(value).TrimEnd('\\');
                if (Regex.IsMatch(full, @"^[A-Za-z]:$")) return "";
                // 数据目录落在程序目录内时，更新会覆盖用户配置（安装器也拒这种组合）
                if (!string.IsNullOrEmpty(s_installRoot))
                {
                    string root = Path.GetFullPath(s_installRoot).TrimEnd('\\');
                    if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return "";
                    if (full.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) return "";
                }
                return full;
            }
            catch { return ""; }
        }

        // 读 install-binding.json。返回空串表示通过；否则是拒绝原因（人类可读）。
        private static string ReadBindingFile(string path, out string profile, out string dataDir, out string appDir)
        {
            profile = "";
            dataDir = "";
            appDir = "";
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception ex) { return "无法读取：" + ex.Message; }
            string schema = JsonScalarField(text, "schema");
            if (schema != "1") return "schema 不支持：" + (string.IsNullOrEmpty(schema) ? "(缺失)" : schema);
            profile = JsonStringField(text, "clientProfile");
            dataDir = JsonStringField(text, "dataDir");
            appDir = JsonStringField(text, "appDir");
            if (!IsKnownProfile(profile)) return "clientProfile 非法：" + (string.IsNullOrEmpty(profile) ? "(缺失)" : profile);
            if (!IsFullWindowsPath(dataDir)) return "dataDir 不是完整绝对路径：" + (string.IsNullOrEmpty(dataDir) ? "(缺失)" : dataDir);
            if (string.IsNullOrWhiteSpace(appDir)) return "appDir 缺失";
            return "";
        }

        // 数字字段（schema）不走字符串解析：JSON 里它是数字 1，不是字符串。
        private static string JsonScalarField(string json, string name)
        {
            Match m = Regex.Match(json ?? "",
                "\"" + Regex.Escape(name) + "\"\\s*:\\s*(-?[0-9]+)");
            return m.Success ? m.Groups[1].Value : "";
        }

        private static string JsonStringField(string json, string name)
        {
            Match m = Regex.Match(json ?? "",
                "\"" + Regex.Escape(name) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (!m.Success) return "";
            return m.Groups[1].Value.Replace("\\\\", "\\").Replace("\\/", "/");
        }

        // ------------------------------------------------------------ 状态
        private static bool TestPort(int port)
        {
            using (TcpClient client = new TcpClient())
            {
                try
                {
                    IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(250)) return false;
                    client.EndConnect(ar);
                    return true;
                }
                catch { return false; }
            }
        }

        private static List<WdProc> GetWdProcesses()
        {
            List<WdProc> list = new List<WdProc>();
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                using (ManagementObjectCollection rows = searcher.Get())
                {
                    foreach (ManagementObject mo in rows)
                    {
                        string cmd = mo["CommandLine"] as string;
                        if (cmd == null || !WdRegex.IsMatch(cmd)) continue;
                        int pid;
                        if (!int.TryParse(Convert.ToString(mo["ProcessId"]), out pid)) continue;
                        WdProc item = new WdProc();
                        item.Pid = pid;
                        item.Role = cmd.IndexOf("watchdog.js", StringComparison.OrdinalIgnoreCase) >= 0 ? 0 : 1;
                        list.Add(item);
                    }
                }
            }
            catch { }
            return list;
        }

        private static bool GetAutoStart()
        {
            return !string.IsNullOrEmpty(GetAutoStartRaw());
        }

        // 自启项的原文。--selftest 必须按原样还原它：用 bool 表示会退化成
        // 「用当前进程的路径重新打开自启」—— 跑一次仓库里的 exe 就把用户自启项
        // 从安装目录改到开发树，登录后托盘起不来且日志里看不出原因（真踩过）。
        private static string GetAutoStartRaw()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    if (key == null) return null;
                    return key.GetValue(RunValueName) as string;
                }
            }
            catch { return null; }
        }

        private static bool SetAutoStartRaw(string value)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true)
                    ?? Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (key == null) return false;
                    if (string.IsNullOrEmpty(value)) key.DeleteValue(RunValueName, false);
                    else key.SetValue(RunValueName, value, RegistryValueKind.String);
                }
                return true;
            }
            catch { return false; }
        }

        private static bool SetAutoStart(bool enabled)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true)
                    ?? Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (key == null) return false;
                    if (enabled)
                    {
                        string value = "\"" + Application.ExecutablePath + "\" /autostart";
                        key.SetValue(RunValueName, value, RegistryValueKind.String);
                    }
                    else
                    {
                        key.DeleteValue(RunValueName, false);
                    }
                }
                return GetAutoStart();
            }
            catch { return false; }
        }

        // ------------------------------------------------------------ 动作
        // 直接起 watchdog.js，绕过 cmd.exe /c launcher.cmd。
        // launcher.cmd 是「双击」入口：内部会 pause、会弹控制台、会走
        // win-launcher.js 的「重启 WorkBuddy 带 CDP」长流程。由无控制台的
        // winexe 托盘用 cmd /c 调它时，cmd 拿着无效 stdout 句柄空转
        // （实测 CPU 124s、无 node 子进程、launcher.log 零新增），还会弹出
        // 命令行窗口。这里只启动后台服务，CDP/面板注入交给「恢复 CDP」。
        private static string FindNode()
        {
            // 测试注入：指定运行时，避免依赖机器上 ~/.workbuddy 的 node 布局
            string forced = Environment.GetEnvironmentVariable("WORKDADDY_TRAY_NODE");
            if (!string.IsNullOrEmpty(forced) && File.Exists(forced)) return forced;
            string root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                @".workbuddy\binaries\node\versions");
            try
            {
                if (Directory.Exists(root))
                {
                    foreach (string dir in Directory.GetDirectories(root)
                        .OrderByDescending(x => x, StringComparer.Ordinal))
                    {
                        string exe = Path.Combine(dir, "node.exe");
                        if (File.Exists(exe)) return exe;
                    }
                }
            }
            catch { }
            string bundled = Path.Combine(s_scripts, "runtime", "node", "node.exe");
            if (File.Exists(bundled)) return bundled;
            return "node";
        }

        private static bool StartWd()
        {
            // 绑定不合法就不启动：把 daemon 送进别的 profile / 数据目录，
            // 比「点了没反应」严重得多，而且日志里看不出来。
            if (!string.IsNullOrEmpty(s_bindingError)) { s_startError = s_bindingError; return false; }
            if (!File.Exists(s_watchdog)) { s_startError = "watchdog 不存在: " + s_watchdog; return false; }
            if (TestPort(DaemonPort)) return true;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = FindNode();
                psi.Arguments = "\"" + s_watchdog + "\"";
                psi.WorkingDirectory = s_scripts;
                // UseShellExecute=true 让 shell 分配自己的句柄，不继承托盘 (winexe)
                // 的无效标准句柄；Hidden 隐藏 node 的控制台窗口。
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                // 绑定通过本进程环境块传给子进程，不能用 psi.EnvironmentVariables：
                // 它在 .NET Framework 里是大小写不敏感的 StringDictionary，环境里同时
                // 存在 HTTPS_PROXY 与 https_proxy 时一访问就抛 ArgumentException
                // （实测「start = False」，用户看到的就是点了启动没反应）。
                string prevProfile = Environment.GetEnvironmentVariable("WBSWITCH_PROFILE");
                string prevDataDir = Environment.GetEnvironmentVariable("WBSWITCH_DATA_DIR");
                try
                {
                    // 两个变量都显式设：s_dataDir 为空时 SetEnvironmentVariable(name, "")
                    // 会把它从环境块里删掉 —— 这正好挡住「继承了一个非法值」的情况，
                    // 子进程拿不到任何残留的 WBSWITCH_DATA_DIR。
                    Environment.SetEnvironmentVariable("WBSWITCH_PROFILE", s_profile);
                    Environment.SetEnvironmentVariable("WBSWITCH_DATA_DIR",
                        string.IsNullOrEmpty(s_dataDir) ? "" : s_dataDir);
                    Process.Start(psi);
                }
                finally
                {
                    Environment.SetEnvironmentVariable("WBSWITCH_PROFILE", prevProfile);
                    Environment.SetEnvironmentVariable("WBSWITCH_DATA_DIR", prevDataDir);
                }
                return true;
            }
            catch (Exception ex) { s_startError = ex.GetType().Name + ": " + ex.Message; return false; }
        }

        private static bool StopWd()
        {
            for (int round = 0; round < 4; round++)
            {
                List<WdProc> procs = GetWdProcesses();
                if (procs.Count == 0) return true;
                foreach (WdProc p in procs.OrderBy(x => x.Role))
                {
                    try
                    {
                        using (Process proc = Process.GetProcessById(p.Pid))
                        {
                            proc.Kill();
                        }
                    }
                    catch { }
                }
                Thread.Sleep(400);
            }
            return GetWdProcesses().Count == 0;
        }

        private static bool RestartWd()
        {
            StopWd();
            Thread.Sleep(900);
            return StartWd();
        }

        // daemon 的 /api/client/relaunch 要「逐个结束 WorkBuddy 进程 → 带
        // --remote-debugging-port 重启 → CDP 连接 → 注入面板」之后才返回 202，
        // 实测 19:31:21 → 19:32:22 约 60 秒。旧版同步等待且 Timeout=10s，
        // 请求其实已被 daemon 接收并成功完成，托盘却因超时报「操作失败」。
        // 这里只确认「请求已发出」，真实结果交给 2s 定时轮询的 CDP 端口检测，
        // 既不冻结 UI 也不误报。
        private static bool RestoreCdp()
        {
            if (!TestPort(DaemonPort)) return false;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(DaemonUri + "/api/client/relaunch");
                req.Method = "POST";
                req.ContentLength = 0;
                req.Timeout = 90000;
                s_cdpRequestFailed = false;
                req.BeginGetResponse(delegate(IAsyncResult ar)
                {
                    try
                    {
                        using (HttpWebResponse resp = (HttpWebResponse)req.EndGetResponse(ar))
                        {
                            if ((int)resp.StatusCode >= 400) s_cdpRequestFailed = true;
                        }
                    }
                    catch { s_cdpRequestFailed = true; }
                }, null);
                return true;
            }
            catch { return false; }
        }

        // ------------------------------------------------------------ 图标
        private static Icon NewDotIcon(Color fill)
        {
            Bitmap bmp = new Bitmap(16, 16);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush brush = new SolidBrush(fill)) g.FillEllipse(brush, 1, 1, 14, 14);
                using (Pen pen = new Pen(Color.FromArgb(110, 0, 0, 0), 1)) g.DrawEllipse(pen, 1, 1, 14, 14);
            }
            IconBitmaps.Add(bmp); // 保活：Icon.FromHandle 依赖该 bitmap 的 HICON
            return Icon.FromHandle(bmp.GetHicon());
        }

        // ------------------------------------------------------------ UI
        private static ToolStripMenuItem AddItem(string text, string tip)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            if (!string.IsNullOrEmpty(tip)) item.ToolTipText = tip;
            s_menu.Items.Add(item);
            return item;
        }

        private static void BuildUi()
        {
            s_iconRun = NewDotIcon(Color.FromArgb(30, 190, 90));
            s_iconStop = NewDotIcon(Color.FromArgb(150, 155, 162));
            s_iconBusy = NewDotIcon(Color.FromArgb(240, 160, 40));

            s_menu = new ContextMenuStrip();
            s_menu.ShowCheckMargin = true;
            s_menu.ShowItemToolTips = true;

            s_status = AddItem("状态: 检测中…", null);
            s_status.Enabled = false;
            s_menu.Items.Add(new ToolStripSeparator());

            s_start = AddItem("启动 WorkDaddy", "只启动后台服务，不弹窗、不重启 WorkBuddy 窗口；面板注入请用『恢复 CDP』");
            s_stop = AddItem("关闭 WorkDaddy", "停止 watchdog + daemon，保留全部账号与会话数据");
            s_restart = AddItem("重启 WorkDaddy", "先停止再启动");
            s_cdp = AddItem("恢复 CDP（会重开 WorkBuddy 窗口）", "POST /api/client/relaunch，带调试端口重开 WorkBuddy");
            s_menu.Items.Add(new ToolStripSeparator());

            s_auto = AddItem("开机自启动", "开关 HKCU Run；开启后登录时自动启动托盘并拉起 WorkDaddy");
            s_auto.Checked = GetAutoStart();
            s_menu.Items.Add(new ToolStripSeparator());

            s_open = AddItem("打开管理页", "打开 http://127.0.0.1:47832/");
            ToolStripMenuItem exitItem = AddItem("退出托盘", "只关闭托盘程序，不影响 WorkDaddy 后台服务");

            s_start.Click += delegate { RunBusy(StartWd, StartOkText()); };
            s_stop.Click += delegate { RunBusy(StopWd, "WorkDaddy 已关闭"); };
            s_restart.Click += delegate { RunBusy(RestartWd, "WorkDaddy 已重启"); };
            s_cdp.Click += delegate
            {
                s_waitingCdp = true;
                s_cdpWaitTicks = 0;
                RunBusy(delegate
                {
                    bool ok = RestoreCdp();
                    if (!ok) s_waitingCdp = false;
                    return ok;
                }, "已请求恢复 CDP；WorkBuddy 将重开，约 1 分钟，完成后会再提示");
            };
            s_open.Click += delegate { OpenPage(); };
            s_auto.Click += delegate
            {
                bool target = !GetAutoStart();
                bool actual = SetAutoStart(target);
                s_auto.Checked = actual;
                ShowBalloon("开机自启动已" + (actual ? "开启" : "关闭"), ToolTipIcon.Info);
            };
            exitItem.Click += delegate
            {
                s_timer.Stop();
                s_notify.Visible = false;
                s_context.ExitThread();
            };

            s_notify = new NotifyIcon();
            s_notify.Icon = s_iconStop;
            s_notify.Text = "WorkDaddy: 检测中…";
            s_notify.ContextMenuStrip = s_menu;
            s_notify.Visible = true;
            s_notify.DoubleClick += delegate
            {
                if (TestPort(DaemonPort)) OpenPage();
                else RunBusy(StartWd, StartOkText());
            };
            s_notify.BalloonTipClicked += delegate { OpenPage(); };
        }

        private static void OpenPage()
        {
            try { Process.Start(DaemonUri + "/"); } catch { }
        }

        private static void ShowBalloon(string text, ToolTipIcon icon)
        {
            try
            {
                s_notify.BalloonTipTitle = "WorkDaddy";
                s_notify.BalloonTipText = text;
                s_notify.BalloonTipIcon = icon;
                s_notify.ShowBalloonTip(2600);
            }
            catch { }
        }

        private static void UpdateState()
        {
            if (s_busy) return;
            bool run = TestPort(DaemonPort);
            bool cdp = TestPort(CdpPort);
            string state = run ? "运行中" : "已停止";
            string cdpState = cdp ? "CDP 已连接" : "CDP 断开";
            s_notify.Icon = run ? s_iconRun : s_iconStop;
            s_notify.Text = string.Format("WorkDaddy: {0} / {1}", state, cdpState);
            s_status.Text = string.Format("WorkDaddy {0} · {1}", state, cdpState);
            s_start.Enabled = !run;
            s_stop.Enabled = run;
            s_restart.Enabled = run;
            s_cdp.Enabled = run && !cdp && !s_waitingCdp;
            s_open.Enabled = run;
            s_auto.Checked = GetAutoStart();
        }

        private static string StartOkText()
        {
            return TestPort(CdpPort)
                ? "WorkDaddy 已启动，面板已注入"
                : "WorkDaddy 服务已启动；面板未注入，点『恢复 CDP』";
        }

        private static void RunBusy(Func<bool> work, string okText)
        {
            s_busy = true;
            s_notify.Icon = s_iconBusy;
            bool ok;
            string err = "";
            try { ok = work(); }
            catch (Exception ex) { ok = false; err = ex.Message; }
            finally { s_busy = false; }
            UpdateState();
            ShowBalloon(ok ? okText : ("操作失败: " + err), ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }

        private static void RunGui(bool autoStart)
        {
            s_context = new ApplicationContext();
            s_timer = new System.Windows.Forms.Timer();
            s_timer.Interval = 2000;
            s_timer.Tick += delegate
            {
                UpdateState();
                // 恢复 CDP 期间 daemon 要跑约 60 秒；轮询端口，真正恢复后再提示一次，
                // 避免「点了没反应 / 误报失败」。90 秒仍未恢复则给出超时提示。
                if (s_cdpRequestFailed)
                {
                    s_cdpRequestFailed = false;
                    s_waitingCdp = false;
                    s_cdpWaitTicks = 0;
                    ShowBalloon("恢复 CDP 请求失败，请打开管理页查看状态", ToolTipIcon.Warning);
                }
                if (s_waitingCdp)
                {
                    s_cdpWaitTicks++;
                    if (TestPort(CdpPort))
                    {
                        s_waitingCdp = false;
                        s_cdpWaitTicks = 0;
                        ShowBalloon("CDP 已恢复，面板已注入", ToolTipIcon.Info);
                    }
                    else if (s_cdpWaitTicks > 45)
                    {
                        s_waitingCdp = false;
                        s_cdpWaitTicks = 0;
                        ShowBalloon("恢复 CDP 超时，请打开管理页查看状态", ToolTipIcon.Warning);
                    }
                }
                if (autoStart && !s_autoStartDone)
                {
                    s_autoTick++;
                    if (s_autoTick >= 3)
                    {
                        s_autoStartDone = true;
                        if (!TestPort(DaemonPort)) RunBusy(StartWd, StartOkText());
                    }
                }
            };
            UpdateState();
            if (!string.IsNullOrEmpty(s_bindingError))
            {
                // 绑定坏了就别装没事：直接告诉用户为什么服务起不来
                ShowBalloon("绑定不可用：" + s_bindingError, ToolTipIcon.Error);
            }
            s_timer.Start();
            Application.Run(s_context);
            s_timer.Stop();
            s_notify.Visible = false;
            s_notify.Dispose();
            s_menu.Dispose();
        }

        // ------------------------------------------------------------ CLI
        private static void Emit(string text)
        {
            try { AttachConsole(AttachParentProcess); } catch { }
            try { Console.Write(text); } catch { }
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "WorkDaddyTray-cli.txt"),
                    text, new UTF8Encoding(false));
            }
            catch { }
            try { FreeConsole(); } catch { }
        }

        private static void RunCli(string action)
        {
            StringBuilder sb = new StringBuilder();
            switch (action.ToLowerInvariant())
            {
                case "--status":
                    sb.AppendLine("daemon     : " + (TestPort(DaemonPort) ? "running" : "stopped"));
                    sb.AppendLine("cdp        : " + (TestPort(CdpPort) ? "connected" : "disconnected"));
                    sb.AppendLine("processes  : " + GetWdProcesses().Count);
                    sb.AppendLine("autostart  : " + GetAutoStart());
                    sb.AppendLine("launch     : profile=" + s_profile + " dataDir=" +
                        (string.IsNullOrEmpty(s_dataDir) ? "(default)" : s_dataDir) + " source=" + s_bindingSource);
                    sb.AppendLine("installRoot: " + s_installRoot);
                    if (!string.IsNullOrEmpty(s_bindingError)) sb.AppendLine("bindingErr : " + s_bindingError);
                    sb.AppendLine("wd scripts : " + s_scripts);
                    break;

                case "--selftest":
                    sb.AppendLine("=== WorkDaddyTray.exe self-test ===");
                    sb.AppendLine("exe        : " + Application.ExecutablePath);
                    sb.AppendLine("wd scripts : " + s_scripts);
                    sb.AppendLine("launcher   : exists=" + File.Exists(s_launcher));
                    sb.AppendLine("watchdog   : exists=" + File.Exists(s_watchdog));
                    sb.AppendLine("daemon 47832 : " + TestPort(DaemonPort));
                    sb.AppendLine("cdp 9222     : " + TestPort(CdpPort));
                    sb.AppendLine("wd processes : " + GetWdProcesses().Count);
                    sb.AppendLine("autostart    : " + GetAutoStart());
                    string before = GetAutoStartRaw();
                    bool was = !string.IsNullOrEmpty(before);
                    bool on = SetAutoStart(true);
                    bool mid = GetAutoStart();
                    bool off = SetAutoStart(false);
                    bool end = GetAutoStart();
                    SetAutoStartRaw(before);
                    sb.AppendLine(string.Format(
                        "autostart RT : was={0} on={1} mid={2} off={3} end={4} restored={5}",
                        was, on, mid, off, end, GetAutoStart()));
                    // 逐字节还原才是真还原：was/restored 是布尔，路径被换成别的 exe
                    // 也照样 True，正是这个盲点把用户自启项改到了开发树。
                    sb.AppendLine("autostart exe: same=" +
                        (string.Equals(GetAutoStartRaw(), before, StringComparison.Ordinal) ? "True" : "False"));
                    sb.AppendLine("SELF-TEST OK");
                    break;

                case "--start":
                    sb.AppendLine("start = " + StartWd());
                    if (!string.IsNullOrEmpty(s_startError)) sb.AppendLine("startError : " + s_startError);
                    break;
                case "--stop":
                    sb.AppendLine("stop = " + StopWd());
                    break;
                case "--restart":
                    sb.AppendLine("restart = " + RestartWd());
                    break;
                case "--autoon":
                    sb.AppendLine("autostart = " + SetAutoStart(true));
                    break;
                case "--autooff":
                    sb.AppendLine("autostart = " + SetAutoStart(false));
                    break;
                default:
                    sb.AppendLine("unknown action: " + action);
                    sb.AppendLine("valid: --status --selftest --start --stop --restart --autoon --autooff");
                    break;
            }
            Emit(sb.ToString());
        }
    }
}
