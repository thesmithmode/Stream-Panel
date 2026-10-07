// Minimal Windows launcher: starts bundled Node with the daemon entry.
// Compiled on windows-latest via: csc /nologo /optimize /out:StreamPanel.exe windows-launcher.cs
using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main()
    {
        try
        {
            var root = AppContext.BaseDirectory;
            var node = Path.Combine(root, "runtime", "node.exe");
            var entry = Path.Combine(root, "app", "dist", "apps", "daemon", "src", "index.js");
            if (!File.Exists(node))
            {
                Console.Error.WriteLine("Stream Panel: missing runtime\\node.exe");
                return 1;
            }
            if (!File.Exists(entry))
            {
                Console.Error.WriteLine("Stream Panel: missing app entry (dist/apps/daemon/src/index.js)");
                return 1;
            }
            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = Quote(entry),
                WorkingDirectory = Path.Combine(root, "app"),
                UseShellExecute = false,
            };
            using var process = Process.Start(psi);
            if (process is null)
            {
                Console.Error.WriteLine("Stream Panel: failed to start Node runtime");
                return 1;
            }
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                try { process.Kill(entireProcessTree: true); } catch { /* ignore */ }
            };
            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Stream Panel: " + ex.Message);
            return 1;
        }
    }

    private static string Quote(string path) =>
        path.Contains(' ') ? "\"" + path.Replace("\"", "\\\"") + "\"" : path;
}
