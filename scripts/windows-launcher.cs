// GUI Windows launcher: starts bundled Node with the daemon entry (no console window).
// Daemon auto-opens the system browser to the one-time panel URL.
// Compile with .NET Framework csc on windows-latest:
//   csc /nologo /optimize /t:winexe /out:StreamPanel.exe windows-launcher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private static int Main()
    {
        try
        {
            string location = Assembly.GetExecutingAssembly().Location;
            string root = Path.GetDirectoryName(location);
            if (string.IsNullOrEmpty(root))
            {
                Fail("cannot resolve install directory");
                return 1;
            }

            string node = Path.Combine(root, "runtime", "node.exe");
            string entry = Path.Combine(
                root,
                "app",
                "dist",
                "apps",
                "daemon",
                "src",
                "index.js"
            );
            if (!File.Exists(node))
            {
                Fail("missing runtime\\node.exe");
                return 1;
            }
            if (!File.Exists(entry))
            {
                Fail("missing app entry (dist/apps/daemon/src/index.js)");
                return 1;
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = Quote(entry);
            psi.WorkingDirectory = Path.Combine(root, "app");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;

            Process process = Process.Start(psi);
            if (process == null)
            {
                Fail("failed to start Node runtime");
                return 1;
            }

            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception ex)
        {
            Fail(ex.Message);
            return 1;
        }
    }

    private static void Fail(string message)
    {
        try
        {
            MessageBoxW(IntPtr.Zero, "Stream Panel: " + message, "Stream Panel", 0x00000010);
        }
        catch
        {
            /* ignore */
        }
    }

    private static string Quote(string path)
    {
        if (path.IndexOf(' ') >= 0)
        {
            return "\"" + path.Replace("\"", "\\\"") + "\"";
        }
        return path;
    }
}
