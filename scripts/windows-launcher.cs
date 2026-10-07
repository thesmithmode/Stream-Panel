// Minimal Windows launcher: starts bundled Node with the daemon entry.
// Must compile with .NET Framework csc (C# 5 / net40 APIs) on windows-latest:
//   csc /nologo /optimize /t:exe /out:StreamPanel.exe windows-launcher.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class Program
{
    private static int Main()
    {
        try
        {
            string location = Assembly.GetExecutingAssembly().Location;
            string root = Path.GetDirectoryName(location);
            if (string.IsNullOrEmpty(root))
            {
                Console.Error.WriteLine("Stream Panel: cannot resolve install directory");
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
                Console.Error.WriteLine("Stream Panel: missing runtime\\node.exe");
                return 1;
            }
            if (!File.Exists(entry))
            {
                Console.Error.WriteLine(
                    "Stream Panel: missing app entry (dist/apps/daemon/src/index.js)"
                );
                return 1;
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = Quote(entry);
            psi.WorkingDirectory = Path.Combine(root, "app");
            psi.UseShellExecute = false;

            Process process = Process.Start(psi);
            if (process == null)
            {
                Console.Error.WriteLine("Stream Panel: failed to start Node runtime");
                return 1;
            }

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                try
                {
                    process.Kill();
                }
                catch
                {
                    /* ignore */
                }
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

    private static string Quote(string path)
    {
        if (path.IndexOf(' ') >= 0)
        {
            return "\"" + path.Replace("\"", "\\\"") + "\"";
        }
        return path;
    }
}
