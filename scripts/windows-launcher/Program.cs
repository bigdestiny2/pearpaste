using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PearPasteLauncher;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var appDir = AppContext.BaseDirectory;
        var linkPath = Path.Combine(appDir, "pearpaste.link");
        var pearRuntimePath = FindPearRuntime();

        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            return SelfTest(linkPath, pearRuntimePath);
        }

        var link = ReadLink(linkPath);
        if (link is null)
        {
            ShowError("Missing or invalid pearpaste.link next to PearPaste.exe.");
            return 1;
        }

        if (pearRuntimePath is null)
        {
            ShowError(
                "Pear Runtime is not installed or has not been initialized." +
                Environment.NewLine + Environment.NewLine +
                "Install/update it with:" +
                Environment.NewLine +
                "npm i -g pear" +
                Environment.NewLine +
                "npx pear run pear://runtime");
            return 1;
        }

        try
        {
            var start = new ProcessStartInfo
            {
                FileName = pearRuntimePath,
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };
            start.ArgumentList.Add("run");
            start.ArgumentList.Add(link);
            start.ArgumentList.Add("--no-ask");
            start.ArgumentList.Add("--detached");

            foreach (var arg in args)
            {
                if (arg.Equals("--", StringComparison.Ordinal)) continue;
                start.ArgumentList.Add(arg);
            }

            using var child = Process.Start(start);
            if (child is null)
            {
                ShowError("PearPaste could not start the Pear runtime.");
                return 1;
            }

            if (child.WaitForExit(5000) && child.ExitCode != 0)
            {
                var output = (child.StandardError.ReadToEnd() + Environment.NewLine + child.StandardOutput.ReadToEnd()).Trim();
                var detail = string.IsNullOrWhiteSpace(output) ? string.Empty : $"{Environment.NewLine}{Environment.NewLine}{output}";
                ShowError($"Pear runtime exited with code {child.ExitCode}.{detail}");
                return child.ExitCode;
            }

            return 0;
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
            return 1;
        }
    }

    private static string? FindPearRuntime()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var pearRuntimePath = Path.Combine(appData, "pear", "current", "by-arch", "win32-x64", "bin", "pear-runtime.exe");
        return File.Exists(pearRuntimePath) ? pearRuntimePath : null;
    }

    private static int SelfTest(string linkPath, string? pearRuntimePath)
    {
        var link = ReadLink(linkPath);
        if (link is null) return 2;
        if (pearRuntimePath is null) return 3;
        if (!File.Exists(pearRuntimePath)) return 4;
        return 0;
    }

    private static string? ReadLink(string linkPath)
    {
        if (!File.Exists(linkPath)) return null;
        var link = File.ReadAllText(linkPath).Trim();
        return link.StartsWith("pear://", StringComparison.OrdinalIgnoreCase) ? link : null;
    }

    private static void ShowError(string message)
    {
        _ = MessageBoxW(IntPtr.Zero, message, "PearPaste", 0x00000010);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
}
