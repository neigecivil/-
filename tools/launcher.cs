using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

/* 资源分享站助手的启动器。
   双击这个 exe，等于用 mshta 打开同目录的 资源分享站助手.hta。
   之所以要它：.hta 在资源管理器里图标空白、也不好在开始菜单里认，
   包一层 exe 之后可以带图标、能从开始菜单固定。 */
class Program
{
    [STAThread]
    static void Main()
    {
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        string hta = Path.Combine(dir, "资源分享站助手.hta");

        if (!File.Exists(hta))
        {
            MessageBox.Show(
                "没找到「资源分享站助手.hta」。\n请把它和这个 exe 放在同一个文件夹里。",
                "资源分享站助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("mshta.exe", "\"" + hta + "\"");
            psi.WorkingDirectory = dir;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show("打不开助手：" + ex.Message, "资源分享站助手",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}