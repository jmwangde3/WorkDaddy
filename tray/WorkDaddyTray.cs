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
        // 每个 profile 有独立的 UI / CDP 端口（与 scripts/ui-port.js、daemon.js 的
        // PROFILE_CDP_PORT 同源）。写死 47832 / 9222 的话，另外三个 profile 的
        // 启动判断、状态、管理页、恢复 CDP 全会打到 CN 的端口上。
        private static int s_uiPort = 47832;
        private static int s_cdpPort = 9222;
        private static readonly List<int> s_uiPorts = new List<int>();
        private static readonly List<int> s_cdpPorts = new List<int>();
        // 测试注入（生产不设即为 0）：只影响端口候选，不改变 profile 选择逻辑。
        private static int s_testUiPort = 0;
        private static int s_testCdpPort = 0;
        private static int DaemonPort { get { return s_uiPort; } }
        private static int CdpPort { get { return s_cdpPort; } }
        private static string DaemonUri { get { return "http://127.0.0.1:" + s_uiPort; } }
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
            ResolvePorts();

            if (args.Length > 0 && args[0].StartsWith("--", StringComparison.Ordinal))
            {
                if (string.Equals(args[0], "--check-binding", StringComparison.OrdinalIgnoreCase))
                {
                    RunCheckBinding(args.Length > 1 ? args[1] : "");
                    return;
                }
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
        // 只给自动化测试用的注入口：隔离目录里要跑真实的 StartWd，就不能让
        // 「本机真实服务已经在某个候选端口上跑着」把启动短路掉，也不能依赖机器上
        // 的 node 布局。生产环境不设这些变量，端口完全由 profile 决定。
        private static void ApplyTestHooks()
        {
            string portText = Environment.GetEnvironmentVariable("WORKDADDY_TRAY_PORT");
            int port;
            if (!string.IsNullOrEmpty(portText) && int.TryParse(portText, out port) && port > 0 && port < 65536)
            {
                s_testUiPort = port;
            }
            string cdpText = Environment.GetEnvironmentVariable("WORKDADDY_TRAY_CDP_PORT");
            if (!string.IsNullOrEmpty(cdpText) && int.TryParse(cdpText, out port) && port > 0 && port < 65536)
            {
                s_testCdpPort = port;
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
            string envProfile = (Environment.GetEnvironmentVariable("WBSWITCH_PROFILE") ?? "").Trim();
            string envDataDir = (Environment.GetEnvironmentVariable("WBSWITCH_DATA_DIR") ?? "").Trim();
            bool hasEnvProfile = envProfile.Length > 0;
            bool hasEnvDataDir = envDataDir.Length > 0;

            try { s_installRoot = Path.GetFullPath(Path.Combine(s_scripts, "..")); }
            catch { s_installRoot = ""; }

            string bindProfile = "";
            string bindDataDir = "";
            string bindAppDir = "";
            string bindError = "";
            bool hasBinding = false;
            string bindFile = string.IsNullOrEmpty(s_installRoot)
                ? "" : Path.Combine(s_installRoot, "install-binding.json");
            if (!string.IsNullOrEmpty(bindFile) && File.Exists(bindFile))
            {
                hasBinding = true;
                bindError = ReadBindingFile(bindFile, out bindProfile, out bindDataDir, out bindAppDir);
                // 归属也要在「解析成功」之后再验：自称的 appDir 必须就是这一份安装。
                if (string.IsNullOrEmpty(bindError)) bindError = ValidateBindingOwnership(bindAppDir);
            }

            string legacyProfile = "";
            string legacyDataDir = "";
            // 旧版兼容只在「既没有绑定、也没有显式环境变量」时启用：把另一份安装的
            // install-state 混进显式绑定里，等于无条件跨实例拼配置。
            if (!hasBinding && !hasEnvProfile && !hasEnvDataDir)
            {
                ReadLegacyState(out legacyProfile, out legacyDataDir);
            }

            // 绑定存在但内容不合法 → fail-closed。坏掉的实例身份不能被环境变量「修好」。
            if (hasBinding && !string.IsNullOrEmpty(bindError))
            {
                s_bindingError = "安装绑定文件不可用：" + bindError;
                s_bindingSource = "install-binding.json(invalid)";
                return;
            }

            // 1) 显式 profile / 数据目录各自独立校验。
            if (hasEnvProfile && !IsKnownProfile(envProfile))
            {
                s_bindingError = "环境变量 WBSWITCH_PROFILE 非法：" + envProfile +
                    "（只接受 " + string.Join(" / ", ProfileIds) + "）";
                s_bindingSource = "env(invalid)";
                return;
            }
            string envDataDirFull = "";
            if (hasEnvDataDir)
            {
                envDataDirFull = NormalizeDataDir(envDataDir);
                if (string.IsNullOrEmpty(envDataDirFull))
                {
                    s_bindingError = "环境变量 WBSWITCH_DATA_DIR 不是完整可用的绝对路径：" + envDataDir;
                    s_bindingSource = "env(invalid)";
                    return;
                }
            }

            // 2) 禁止半覆盖：显式 profile 与绑定不同、却没有同时给数据目录，
            //    等于把「这个 profile」配到「那一份安装的数据目录」上。
            if (hasEnvProfile && hasBinding && !hasEnvDataDir &&
                !string.Equals(envProfile, bindProfile, StringComparison.Ordinal))
            {
                s_bindingError = "显式 profile（" + envProfile + "）与安装绑定（" + bindProfile +
                    "）冲突：要么去掉 WBSWITCH_PROFILE，要么同时指定 WBSWITCH_DATA_DIR 完整覆盖";
                s_bindingSource = "env(conflict)";
                return;
            }

            // 3) profile 取值：显式 > 本实例绑定 > 旧记录 > 默认。
            if (hasEnvProfile)
            {
                s_profile = envProfile;
                s_bindingSource = "env";
            }
            else if (hasBinding)
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

            // 4) 数据目录：显式 > 本实例绑定 > 旧记录（仅在没有显式值时才用）。
            string dataDir = "";
            string dataSource = "";
            if (hasEnvDataDir)
            {
                dataDir = envDataDirFull;
                dataSource = "env";
            }
            else if (hasBinding)
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
        }

        // 绑定自称的 appDir 必须就是这一份安装：否则是别的实例的文件被搬过来了。
        private static string ValidateBindingOwnership(string appDir)
        {
            if (string.IsNullOrEmpty(appDir)) return "appDir 缺失";
            if (!IsFullWindowsPath(appDir)) return "appDir 不是完整绝对路径：" + appDir;
            if (string.IsNullOrEmpty(s_installRoot)) return "无法确定当前安装目录";
            string want, got;
            try
            {
                want = Path.GetFullPath(s_installRoot).TrimEnd('\\');
                got = Path.GetFullPath(appDir).TrimEnd('\\');
            }
            catch (Exception ex) { return "appDir 无法规范化：" + ex.Message; }
            if (!string.Equals(want, got, StringComparison.OrdinalIgnoreCase))
            {
                return "属于另一个安装：" + got + "（当前 " + want + "）";
            }
            return "";
        }

        // 旧版安装记录（%APPDATA%\WorkDaddy\install-state.json）。
        // APPDATA 优先取环境变量：.NET 的 GetFolderPath 读的是 shell 文件夹注册表，
        // 测试把 APPDATA 指到临时目录时它不会跟着变，会读到真实用户数据。
        private static void ReadLegacyState(out string profile, out string dataDir)
        {
            profile = "";
            dataDir = "";
            try
            {
                string appData = Environment.GetEnvironmentVariable("APPDATA");
                if (string.IsNullOrEmpty(appData)) appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                if (string.IsNullOrEmpty(appData)) return;
                string stateFile = Path.Combine(appData, "WorkDaddy", "install-state.json");
                if (!File.Exists(stateFile)) return;
                object root = SimpleJson.Parse(File.ReadAllText(stateFile));
                Dictionary<string, object> o = root as Dictionary<string, object>;
                if (o == null) return;
                object v;
                if (o.TryGetValue("clientProfile", out v)) profile = Convert.ToString(v) ?? "";
                if (o.TryGetValue("dataDir", out v)) dataDir = Convert.ToString(v) ?? "";
            }
            catch { profile = ""; dataDir = ""; }
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

        // ------------------------------------------------------------ 端口
        // UI 端口候选顺序与 scripts/ui-port.js 的 profileUiPortCandidates 一致：
        // ui-port.json 里持久化的（且 profile 必须匹配）→ 默认 → +10000 两档。
        // CDP 候选与 win-launcher 的 PROFILE_CDP_PORTS 一致。
        private static void ResolvePorts()
        {
            int idx = 0;
            for (int i = 0; i < ProfileIds.Length; i++)
            {
                if (string.Equals(ProfileIds[i], s_profile, StringComparison.Ordinal)) { idx = i; break; }
            }
            int uiBase = 47832 + idx;
            int cdpBase = 9222 + idx;

            s_uiPorts.Clear();
            s_cdpPorts.Clear();

            if (s_testUiPort > 0)
            {
                AddPort(s_uiPorts, s_testUiPort);
            }
            else
            {
                int persisted = ReadPersistedUiPort(uiBase);
                if (persisted > 0) AddPort(s_uiPorts, persisted);
                // 与 ui-port.js 的 PROFILE_UI_PORTS 完全同序：默认、-30000、-20000、-10000
                AddPort(s_uiPorts, uiBase);
                AddPort(s_uiPorts, uiBase - 30000);
                AddPort(s_uiPorts, uiBase - 20000);
                AddPort(s_uiPorts, uiBase - 10000);
            }
            s_uiPort = s_uiPorts[0];

            if (s_testCdpPort > 0)
            {
                AddPort(s_cdpPorts, s_testCdpPort);
            }
            else
            {
                AddPort(s_cdpPorts, cdpBase);
                if (string.Equals(s_profile, "workbuddy-cn", StringComparison.Ordinal))
                {
                    for (int p = 9226; p <= 9232; p++) AddPort(s_cdpPorts, p);
                }
                else if (string.Equals(s_profile, "workbuddy-ai", StringComparison.Ordinal))
                {
                    for (int p = 9233; p <= 9239; p++) AddPort(s_cdpPorts, p);
                }
            }
            s_cdpPort = s_cdpPorts[0];
        }

        private static void AddPort(List<int> list, int port)
        {
            if (port >= 1024 && port <= 65535 && !list.Contains(port)) list.Add(port);
        }

        // ui-port.json 是 daemon 在备用端口上跑时写的。只接受「profile 相同且端口属于
        // 本 profile 的候选族」的记录 —— 读到别的 profile 的端口就等于打到别人的服务上。
        private static int ReadPersistedUiPort(int uiBase)
        {
            if (string.IsNullOrEmpty(s_dataDir)) return 0;
            try
            {
                string file = Path.Combine(s_dataDir, "ui-port.json");
                if (!File.Exists(file)) return 0;
                Dictionary<string, object> o = SimpleJson.ParseObject(File.ReadAllText(file));
                object pid;
                object pv;
                if (!o.TryGetValue("profileId", out pid) || !(pid is string)) return 0;
                if (!string.Equals((string)pid, s_profile, StringComparison.Ordinal)) return 0;
                if (!o.TryGetValue("port", out pv) || !(pv is double)) return 0;
                int port = (int)(double)pv;
                if (port != uiBase && port != uiBase - 30000 && port != uiBase - 20000 && port != uiBase - 10000) return 0;
                return port;
            }
            catch { return 0; }
        }

        private static string ReadApiToken()
        {
            if (string.IsNullOrEmpty(s_dataDir)) return "";
            try
            {
                string file = Path.Combine(s_dataDir, ".api-token");
                if (!File.Exists(file)) return "";
                return File.ReadAllText(file).Trim();
            }
            catch { return ""; }
        }

        private static Dictionary<string, object> ProbeDaemonStatus(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/status");
                req.Method = "GET";
                req.Timeout = 700;
                req.Proxy = null;
                string token = ReadApiToken();
                if (!string.IsNullOrEmpty(token)) req.Headers["x-workdaddy-token"] = token;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (Stream stream = resp.GetResponseStream())
                using (StreamReader sr = new StreamReader(stream, Encoding.UTF8))
                {
                    return SimpleJson.ParseObject(sr.ReadToEnd());
                }
            }
            catch { return null; }
        }

        // 端口开着不等于「我的 daemon 在跑」：必须 profile 相同（有权限时再比 dataDir）。
        // 只按端口判断会把兄弟 profile 的 daemon 当成自己已启动，之后所有请求都打错对象。
        private static bool StatusMatches(Dictionary<string, object> status)
        {
            if (status == null) return false;
            object ok;
            if (!status.TryGetValue("ok", out ok) || !(ok is bool) || !(bool)ok) return false;
            object prof;
            if (!status.TryGetValue("profile", out prof)) return false;
            Dictionary<string, object> p = prof as Dictionary<string, object>;
            object id;
            if (p == null || !p.TryGetValue("id", out id)) return false;
            if (!string.Equals(Convert.ToString(id), s_profile, StringComparison.Ordinal)) return false;
            object dd;
            if (status.TryGetValue("dataDir", out dd) && !string.IsNullOrEmpty(s_dataDir))
            {
                string got = Convert.ToString(dd) ?? "";
                if (got.Length > 0)
                {
                    try
                    {
                        if (!string.Equals(Path.GetFullPath(got).TrimEnd('\\'),
                                           Path.GetFullPath(s_dataDir).TrimEnd('\\'),
                                           StringComparison.OrdinalIgnoreCase)) return false;
                    }
                    catch { return false; }
                }
            }
            return true;
        }

        private static int FindDaemonPort()
        {
            foreach (int port in s_uiPorts)
            {
                if (!TestPort(port)) continue;
                if (!StatusMatches(ProbeDaemonStatus(port))) continue;
                if (s_uiPort != port) s_uiPort = port;
                return port;
            }
            return 0;
        }

        private static bool DaemonRunning()
        {
            return FindDaemonPort() > 0;
        }

        private static bool CdpConnected()
        {
            foreach (int port in s_cdpPorts)
            {
                if (!TestPort(port)) continue;
                if (s_cdpPort != port) s_cdpPort = port;
                return true;
            }
            return false;
        }

        // 读 install-binding.json：整份文档必须是合法 JSON（尾部垃圾、重复键、
        // 类型不对都算坏），字段再逐条校验。返回空串表示通过。
        private static string ReadBindingFile(string path, out string profile, out string dataDir, out string appDir)
        {
            profile = "";
            dataDir = "";
            appDir = "";
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception ex) { return "无法读取：" + ex.Message; }

            Dictionary<string, object> o;
            try { o = SimpleJson.ParseObject(text); }
            catch (Exception ex) { return "不是合法 JSON：" + ex.Message; }

            object schema;
            if (!o.TryGetValue("schema", out schema)) return "schema 缺失";
            if (!(schema is double) || (double)schema != 1.0)
                return "schema 必须严格等于 1（实际 " + SimpleJson.Describe(schema) + "）";

            object v;
            if (!o.TryGetValue("clientProfile", out v) || !(v is string)) return "clientProfile 缺失或不是字符串";
            profile = (string)v;
            if (!IsKnownProfile(profile)) return "clientProfile 非法：" + profile;

            if (!o.TryGetValue("dataDir", out v) || !(v is string)) return "dataDir 缺失或不是字符串";
            dataDir = (string)v;
            if (!IsFullWindowsPath(dataDir)) return "dataDir 不是完整绝对路径：" + dataDir;

            if (!o.TryGetValue("appDir", out v) || !(v is string)) return "appDir 缺失或不是字符串";
            appDir = (string)v;
            if (!IsFullWindowsPath(appDir)) return "appDir 不是完整绝对路径：" + appDir;
            return "";
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
            if (DaemonRunning()) return true;
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
            if (FindDaemonPort() <= 0) return false;
            try
            {
                HttpWebRequest req = (HttpWebRequest)HttpWebRequest.Create(DaemonUri + "/api/client/relaunch");
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
                if (DaemonRunning()) OpenPage();
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
            bool run = DaemonRunning();
            bool cdp = CdpConnected();
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
            return CdpConnected()
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
                    if (CdpConnected())
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
                        if (!DaemonRunning()) RunBusy(StartWd, StartOkText());
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

        // 只校验一份绑定文件：给测试和现场排查用，不启动任何服务。
        private static void RunCheckBinding(string path)
        {
            StringBuilder sb = new StringBuilder();
            if (string.IsNullOrEmpty(path))
            {
                sb.AppendLine("binding = error: 缺少文件路径");
            }
            else
            {
                string profile;
                string dataDir;
                string appDir;
                string err = ReadBindingFile(path, out profile, out dataDir, out appDir);
                if (string.IsNullOrEmpty(err)) err = ValidateBindingOwnership(appDir);
                if (string.IsNullOrEmpty(err))
                    sb.AppendLine("binding = ok: profile=" + profile + " dataDir=" + dataDir);
                else
                    sb.AppendLine("binding = error: " + err);
            }
            Emit(sb.ToString());
        }

        private static void RunCli(string action)
        {            StringBuilder sb = new StringBuilder();
            switch (action.ToLowerInvariant())
            {
                case "--status":
                    sb.AppendLine("daemon     : " + (DaemonRunning() ? "running" : "stopped"));
                    sb.AppendLine("cdp        : " + (CdpConnected() ? "connected" : "disconnected"));
                    sb.AppendLine("processes  : " + GetWdProcesses().Count);
                    sb.AppendLine("autostart  : " + GetAutoStart());
                    sb.AppendLine("launch     : profile=" + s_profile + " dataDir=" +
                        (string.IsNullOrEmpty(s_dataDir) ? "(default)" : s_dataDir) + " source=" + s_bindingSource);
                    sb.AppendLine("installRoot: " + s_installRoot);
                    sb.AppendLine("ports      : ui=" + s_uiPort + " cdp=" + s_cdpPort +
                        " uiCandidates=" + string.Join(",", s_uiPorts) +
                        " cdpCandidates=" + string.Join(",", s_cdpPorts));
                    if (!string.IsNullOrEmpty(s_bindingError)) sb.AppendLine("bindingErr : " + s_bindingError);
                    sb.AppendLine("wd scripts : " + s_scripts);
                    break;

                case "--ports":
                    // 只回答「这个 profile 会用哪些端口」，不做任何探测 —— 测试与环境
                    // 排查都用它，避免为了看端口去启动服务。
                    sb.AppendLine("profile    : " + s_profile);
                    sb.AppendLine("ui         : " + s_uiPort);
                    sb.AppendLine("uiCandidates: " + string.Join(",", s_uiPorts));
                    sb.AppendLine("cdp        : " + s_cdpPort);
                    sb.AppendLine("cdpCandidates: " + string.Join(",", s_cdpPorts));
                    sb.AppendLine("source     : " + s_bindingSource);
                    break;

                case "--selftest":
                    sb.AppendLine("=== WorkDaddyTray.exe self-test ===");
                    sb.AppendLine("exe        : " + Application.ExecutablePath);
                    sb.AppendLine("wd scripts : " + s_scripts);
                    sb.AppendLine("launcher   : exists=" + File.Exists(s_launcher));
                    sb.AppendLine("watchdog   : exists=" + File.Exists(s_watchdog));
                    sb.AppendLine("daemon " + DaemonPort + " : " + TestPort(DaemonPort));
                    sb.AppendLine("cdp " + CdpPort + "     : " + TestPort(CdpPort));
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
                    sb.AppendLine("valid: --status --ports --selftest --start --stop --restart --autoon --autooff --check-binding");
                    break;
            }
            Emit(sb.ToString());
        }
    }

    // 最小严格 JSON 解析器（.NET Framework 4.8 可编译，不引第三方库）。
    //
    // 为什么不用正则取字段：正则能「找到」一个看起来对的键值，却回答不了
    // 「整份文档是不是合法 JSON」—— 截断的、尾部带垃圾的、键重复的都能骗过去。
    // 重复键尤其危险：同一份文档里给 clientProfile 写两个值，正则取第一个、
    // 真解析器取最后一个，两边会得出不同结论。
    //
    // 解析结果：对象 → Dictionary<string,object>，数组 → List<object>，
    // 字符串 → string，数字 → double，true/false → bool，null → null。
    internal sealed class SimpleJson
    {
        // 双引号写成字符常量：字符字面量里的引号会被测试的字面量扫描器误当成
        // 字符串开头，进而报「EXE 缺源码字面量」的假失败（真踩过）。
        private const char Quote = (char)34;
        private readonly string _text;
        private int _pos;

        private SimpleJson(string text)
        {
            _text = text ?? "";
            _pos = 0;
        }

        public static object Parse(string text)
        {
            SimpleJson p = new SimpleJson(text);
            p.SkipWhitespace();
            object value = p.ParseValue(0);
            p.SkipWhitespace();
            if (p._pos != p._text.Length)
            {
                throw new FormatException("JSON 尾部有多余内容（第 " + p._pos + " 个字符）");
            }
            return value;
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            object value = Parse(text);
            Dictionary<string, object> o = value as Dictionary<string, object>;
            if (o == null) throw new FormatException("顶层必须是对象");
            return o;
        }

        public static string Describe(object value)
        {
            if (value == null) return "null";
            if (value is string) return "字符串";
            if (value is double) return Convert.ToString((double)value, System.Globalization.CultureInfo.InvariantCulture);
            if (value is bool) return ((bool)value) ? "true" : "false";
            if (value is Dictionary<string, object>) return "对象";
            if (value is List<object>) return "数组";
            return value.GetType().Name;
        }

        private void SkipWhitespace()
        {
            while (_pos < _text.Length)
            {
                char c = _text[_pos];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') { _pos++; continue; }
                break;
            }
        }

        private object ParseValue(int depth)
        {
            if (depth > 16) throw new FormatException("嵌套层级过深");
            if (_pos >= _text.Length) throw new FormatException("JSON 意外结束");
            char c = _text[_pos];
            if (c == '{') return ParseObjectBody(depth);
            if (c == '[') return ParseArrayBody(depth);
            if (c == '"') return ParseString();
            if (c == 't') { Expect("true"); return true; }
            if (c == 'f') { Expect("false"); return false; }
            if (c == 'n') { Expect("null"); return null; }
            if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
            throw new FormatException("非法字符（第 " + _pos + " 个字符）");
        }

        private Dictionary<string, object> ParseObjectBody(int depth)
        {
            Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
            _pos++;
            SkipWhitespace();
            if (_pos < _text.Length && _text[_pos] == '}')
            {
                _pos++;
                return map;
            }
            while (true)
            {
                SkipWhitespace();
                if (_pos >= _text.Length || _text[_pos] != Quote)
                {
                    throw new FormatException("对象的键必须是字符串（第 " + _pos + " 个字符）");
                }
                string key = ParseString();
                if (map.ContainsKey(key)) throw new FormatException("重复的键：" + key);
                SkipWhitespace();
                if (_pos >= _text.Length || _text[_pos] != ':') throw new FormatException("键后缺少冒号：" + key);
                _pos++;
                SkipWhitespace();
                map[key] = ParseValue(depth + 1);
                SkipWhitespace();
                if (_pos >= _text.Length) throw new FormatException("对象未闭合");
                char c = _text[_pos];
                if (c == ',') { _pos++; continue; }
                if (c == '}') { _pos++; return map; }
                throw new FormatException("对象里出现非法字符（第 " + _pos + " 个字符）");
            }
        }

        private List<object> ParseArrayBody(int depth)
        {
            List<object> list = new List<object>();
            _pos++;
            SkipWhitespace();
            if (_pos < _text.Length && _text[_pos] == ']')
            {
                _pos++;
                return list;
            }
            while (true)
            {
                SkipWhitespace();
                list.Add(ParseValue(depth + 1));
                SkipWhitespace();
                if (_pos >= _text.Length) throw new FormatException("数组未闭合");
                char c = _text[_pos];
                if (c == ',') { _pos++; continue; }
                if (c == ']') { _pos++; return list; }
                throw new FormatException("数组里出现非法字符（第 " + _pos + " 个字符）");
            }
        }

        private string ParseString()
        {
            _pos++;
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (_pos >= _text.Length) throw new FormatException("字符串未闭合");
                char c = _text[_pos++];
                if (c == Quote) return sb.ToString();
                if (c == '\\')
                {
                    if (_pos >= _text.Length) throw new FormatException("转义未完成");
                    char e = _text[_pos++];
                    switch (e)
                    {
                        case Quote: sb.Append(Quote); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (_pos + 4 > _text.Length) throw new FormatException("\\u 转义不完整");
                            int code;
                            if (!int.TryParse(_text.Substring(_pos, 4), System.Globalization.NumberStyles.HexNumber,
                                    System.Globalization.CultureInfo.InvariantCulture, out code))
                            {
                                throw new FormatException("\\u 转义非法");
                            }
                            sb.Append((char)code);
                            _pos += 4;
                            break;
                        default:
                            throw new FormatException("非法转义字符（第 " + _pos + " 个字符）");
                    }
                    continue;
                }
                if (c < 0x20) throw new FormatException("字符串里有未转义的控制字符");
                sb.Append(c);
            }
        }

        private double ParseNumber()
        {
            int start = _pos;
            if (_text[_pos] == '-') _pos++;
            while (_pos < _text.Length && char.IsDigit(_text[_pos])) _pos++;
            if (_pos < _text.Length && _text[_pos] == '.')
            {
                _pos++;
                while (_pos < _text.Length && char.IsDigit(_text[_pos])) _pos++;
            }
            if (_pos < _text.Length && (_text[_pos] == 'e' || _text[_pos] == 'E'))
            {
                _pos++;
                if (_pos < _text.Length && (_text[_pos] == '+' || _text[_pos] == '-')) _pos++;
                while (_pos < _text.Length && char.IsDigit(_text[_pos])) _pos++;
            }
            string raw = _text.Substring(start, _pos - start);
            double value;
            if (!double.TryParse(raw, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out value))
            {
                throw new FormatException("非法数字：" + raw);
            }
            return value;
        }

        private void Expect(string literal)
        {
            if (_pos + literal.Length > _text.Length ||
                string.CompareOrdinal(_text, _pos, literal, 0, literal.Length) != 0)
            {
                throw new FormatException("非法字面量（第 " + _pos + " 个字符）");
            }
            _pos += literal.Length;
        }
    }
}
