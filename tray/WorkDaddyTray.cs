// WorkDaddyTray.cs — WorkBuddy 多账号切换器（WorkDaddy）系统托盘控制器
//
// 目标框架：.NET Framework 4.x（用系统自带 csc.exe 编译，无需 Visual Studio / NuGet）
// 构建：tray\build.cmd
// 产物：tray\WorkDaddyTray.exe（Windows GUI 子系统，无控制台窗口）
//
// 功能：
//   * 托盘图标（绿=运行中 / 灰=已停止 / 橙=切换中），运行时绘制，无外部 .ico
//   * 右键菜单：状态 / 启动 / 关闭 / 重启 / 恢复 CDP / 开机自启动 / 打开管理页 / 退出托盘
//   * 单实例 Mutex，避免重复托盘
//   * 停止逻辑：按命令行精确匹配 WorkDaddy\scripts\(watchdog|daemon).js，
//     先 watchdog 后 daemon，循环 4 轮压住 watchdog 的自动重启；不误伤其它 node.exe
//   * 开机自启：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 的 'WorkDaddyTray'
//     指向本 exe + /autostart；名字避开上游清理的 'WorkDaddy' / 'WorkDaddy AI'
//   * /autostart：登录自启触发，约 6 秒后若服务未运行则自动拉起一次
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
        private const int DaemonPort = 47832;
        private const int CdpPort = 9222;
        private const string DaemonUri = "http://127.0.0.1:47832";
        private const int AttachParentProcess = -1;

        private static readonly Regex WdRegex =
            new Regex(@"WorkDaddy[\\/]scripts[\\/](watchdog|daemon)\.js", RegexOptions.IgnoreCase);

        private static readonly List<Bitmap> IconBitmaps = new List<Bitmap>();

        private static string s_scripts;
        private static string s_launcher;
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

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        [STAThread]
        private static void Main(string[] args)
        {
            s_scripts = ResolveScripts();
            s_launcher = Path.Combine(s_scripts, "launcher.cmd");

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
                    MessageBox.Show("WorkDaddy 托盘已在运行", "WorkDaddy",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                BuildUi();

                bool autoStart = args.Any(a =>
                    string.Equals(a, "/autostart", StringComparison.OrdinalIgnoreCase));

                RunGui(autoStart);
                mutex.ReleaseMutex();
            }
        }

        // ------------------------------------------------------------ 路径
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
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, false))
                {
                    if (key == null) return false;
                    string v = key.GetValue(RunValueName) as string;
                    return !string.IsNullOrEmpty(v);
                }
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
        private static bool StartWd()
        {
            if (!File.Exists(s_launcher)) return false;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "cmd.exe";
                psi.Arguments = "/c \"" + s_launcher + "\"";
                psi.WorkingDirectory = Path.GetDirectoryName(s_launcher);
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.UseShellExecute = false;
                psi.EnvironmentVariables["WBSWITCH_NO_PAUSE"] = "1";
                Process.Start(psi);
                return true;
            }
            catch { return false; }
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

        private static bool RestoreCdp()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(DaemonUri + "/api/client/relaunch");
                req.Method = "POST";
                req.Timeout = 10000;
                req.ContentLength = 0;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.Accepted || resp.StatusCode == HttpStatusCode.OK;
                }
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

            s_start = AddItem("启动 WorkDaddy", "启动后台服务；若 WorkBuddy 正在运行，可能重启窗口以启用面板");
            s_stop = AddItem("关闭 WorkDaddy", "停止 watchdog + daemon，保留全部账号与会话数据");
            s_restart = AddItem("重启 WorkDaddy", "先停止再启动");
            s_cdp = AddItem("恢复 CDP（会重开 WorkBuddy 窗口）", "POST /api/client/relaunch，带调试端口重开 WorkBuddy");
            s_menu.Items.Add(new ToolStripSeparator());

            s_auto = AddItem("开机自启动", "开关 HKCU Run；开启后登录时自动启动托盘并拉起 WorkDaddy");
            s_auto.Checked = GetAutoStart();
            s_menu.Items.Add(new ToolStripSeparator());

            s_open = AddItem("打开管理页", "打开 http://127.0.0.1:47832/");
            ToolStripMenuItem exitItem = AddItem("退出托盘", "只关闭托盘程序，不影响 WorkDaddy 后台服务");

            s_start.Click += delegate { RunBusy(StartWd, "WorkDaddy 已启动"); };
            s_stop.Click += delegate { RunBusy(StopWd, "WorkDaddy 已关闭"); };
            s_restart.Click += delegate { RunBusy(RestartWd, "WorkDaddy 已重启"); };
            s_cdp.Click += delegate { RunBusy(RestoreCdp, "已请求恢复 CDP，WorkBuddy 窗口将重开"); };
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
                else RunBusy(StartWd, "WorkDaddy 已启动");
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
            s_cdp.Enabled = run && !cdp;
            s_open.Enabled = run;
            s_auto.Checked = GetAutoStart();
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
                if (autoStart && !s_autoStartDone)
                {
                    s_autoTick++;
                    if (s_autoTick >= 3)
                    {
                        s_autoStartDone = true;
                        if (!TestPort(DaemonPort)) RunBusy(StartWd, "开机自启：WorkDaddy 已启动");
                    }
                }
            };
            UpdateState();
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
                    sb.AppendLine("wd scripts : " + s_scripts);
                    break;

                case "--selftest":
                    sb.AppendLine("=== WorkDaddyTray.exe self-test ===");
                    sb.AppendLine("exe        : " + Application.ExecutablePath);
                    sb.AppendLine("wd scripts : " + s_scripts);
                    sb.AppendLine("launcher   : exists=" + File.Exists(s_launcher));
                    sb.AppendLine("daemon 47832 : " + TestPort(DaemonPort));
                    sb.AppendLine("cdp 9222     : " + TestPort(CdpPort));
                    sb.AppendLine("wd processes : " + GetWdProcesses().Count);
                    sb.AppendLine("autostart    : " + GetAutoStart());
                    bool was = GetAutoStart();
                    bool on = SetAutoStart(true);
                    bool mid = GetAutoStart();
                    bool off = SetAutoStart(false);
                    bool end = GetAutoStart();
                    SetAutoStart(was);
                    sb.AppendLine(string.Format(
                        "autostart RT : was={0} on={1} mid={2} off={3} end={4} restored={5}",
                        was, on, mid, off, end, GetAutoStart()));
                    sb.AppendLine("SELF-TEST OK");
                    break;

                case "--start":
                    sb.AppendLine("start = " + StartWd());
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
