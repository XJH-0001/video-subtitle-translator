/*
 * 视频实时字幕翻译 —— 本地服务启动器（Native Messaging Host）
 *
 * 浏览器扩展没法直接启动进程，这是 Chromium 的硬性限制。
 * 官方给的唯一通道就是 Native Messaging：扩展通过 chrome.runtime.sendNativeMessage
 * 调用一个「注册在注册表里的本地程序」，由它来把服务拉起来。
 *
 * 编译（install.ps1 会自动做）：
 *   csc.exe /nologo /target:exe /optimize+ /out:ServerLauncher.exe ServerLauncher.cs
 *
 * 这个程序做的事：
 *   1. 按 Native Messaging 协议读一条消息（4 字节小端长度 + UTF-8 JSON）
 *   2. 看 127.0.0.1:<port> 是否已经在监听
 *   3. 没在监听就最小化启动 server\app.py（窗口最小化，方便用户找到并关掉）
 *   4. 按同样协议回一条 JSON
 */

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class ServerLauncher
{
    private const int DefaultPort = 8765;
    // 刚启动过就别再启动一次（服务从起进程到监听端口要一两秒）
    private const int LaunchGuardSeconds = 45;

    private static int Main(string[] args)
    {
        string request = null;
        try { request = ReadMessage(); }
        catch { /* 读不到也无所谓，我们的动作不依赖请求内容 */ }

        int port = DefaultPort;
        Match m = Regex.Match(request ?? "", "\"port\"\\s*:\\s*(\\d+)");
        if (m.Success) int.TryParse(m.Groups[1].Value, out port);

        bool alreadyUp = IsListening(port);
        if (alreadyUp)
        {
            WriteMessage("{\"ok\":true,\"status\":\"already-running\",\"port\":" + port + "}");
            return 0;
        }

        string status = "starting";
        if (RecentlyLaunched())
        {
            status = "already-starting";
        }
        else
        {
            try
            {
                StartServer(port);
                MarkLaunched();
            }
            catch (Exception ex)
            {
                WriteMessage("{\"ok\":false,\"status\":\"failed\",\"error\":" + Quote(ex.Message) + "}");
                return 1;
            }
        }

        // 等端口起来（最多 15 秒）。扩展那边本身也会重试，这里只是让状态更准。
        bool up = false;
        for (int i = 0; i < 75; i++)
        {
            Thread.Sleep(200);
            if (IsListening(port)) { up = true; break; }
        }

        WriteMessage("{\"ok\":true,\"status\":\"" + (up ? "ready" : status) + "\",\"port\":" + port + "}");
        return 0;
    }

    // -----------------------------------------------------------------------
    // 启动服务
    // -----------------------------------------------------------------------
    private static void StartServer(int port)
    {
        string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string nativeDir = Path.GetDirectoryName(exePath);
        string root = Path.GetDirectoryName(nativeDir);          // exe 在 <root>\native\ 下
        string serverDir = Path.Combine(root, "server");
        string python = Path.Combine(serverDir, @".venv\Scripts\python.exe");

        if (!File.Exists(python))
            throw new FileNotFoundException("找不到 " + python + "，请先运行 scripts\\install.ps1 完成安装。");

        if (!File.Exists(Path.Combine(serverDir, "app.py")))
            throw new FileNotFoundException("找不到 " + Path.Combine(serverDir, "app.py"));

        var psi = new ProcessStartInfo(python, "app.py --port " + port + " --preload --log-level info");
        psi.WorkingDirectory = serverDir;
        // UseShellExecute=true 才能让子进程脱离本进程独立存活，
        // 窗口最小化是为了让用户能在任务栏找到它（而不是彻底看不见、不知道去哪关）
        psi.UseShellExecute = true;
        psi.WindowStyle = ProcessWindowStyle.Minimized;
        Process.Start(psi);
    }

    // -----------------------------------------------------------------------
    // 启动守卫：避免扩展连续调用时开出好几个服务
    // -----------------------------------------------------------------------
    private static string StampFile()
    {
        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VideoSubtitleTranslator");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "last-launch.txt");
    }

    private static bool RecentlyLaunched()
    {
        try
        {
            string f = StampFile();
            if (!File.Exists(f)) return false;
            return (DateTime.UtcNow - File.GetLastWriteTimeUtc(f)).TotalSeconds < LaunchGuardSeconds;
        }
        catch { return false; }
    }

    private static void MarkLaunched()
    {
        try { File.WriteAllText(StampFile(), DateTime.UtcNow.ToString("o")); }
        catch { }
    }

    // -----------------------------------------------------------------------
    // 端口探测
    // -----------------------------------------------------------------------
    private static bool IsListening(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(350)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    // -----------------------------------------------------------------------
    // Native Messaging 协议：4 字节小端长度 + UTF-8 负载
    // -----------------------------------------------------------------------
    private static string ReadMessage()
    {
        Stream stdin = Console.OpenStandardInput();
        byte[] lenBuf = new byte[4];
        if (ReadFully(stdin, lenBuf, 4) != 4) return null;
        int len = BitConverter.ToInt32(lenBuf, 0);
        if (len <= 0 || len > 1024 * 1024) return null;
        byte[] body = new byte[len];
        if (ReadFully(stdin, body, len) != len) return null;
        return Encoding.UTF8.GetString(body);
    }

    private static int ReadFully(Stream s, byte[] buf, int count)
    {
        int read = 0;
        while (read < count)
        {
            int n = s.Read(buf, read, count - read);
            if (n <= 0) break;
            read += n;
        }
        return read;
    }

    private static void WriteMessage(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        byte[] len = BitConverter.GetBytes(body.Length);
        Stream stdout = Console.OpenStandardOutput();
        stdout.Write(len, 0, 4);
        stdout.Write(body, 0, body.Length);
        stdout.Flush();
    }

    private static string Quote(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
