import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Open the folder chooser on the machine running the daemon. */
export async function chooseFolder(): Promise<string | null> {
  let cmd: string;
  let args: string[];
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-STA', '-Command',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }'];
  } else if (process.platform === 'darwin') {
    cmd = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "Project folder")'];
  } else {
    cmd = 'zenity';
    args = ['--file-selection', '--directory', '--title=Project folder'];
  }
  try {
    const { stdout } = await run(cmd, args, { windowsHide: true });
    return stdout.replace(/\r?\n$/, '') || null;
  } catch (error: any) {
    if (process.platform === 'darwin' && error.code === 1 && /User canceled/.test(error.stderr ?? '')) return null;
    if (process.platform !== 'win32' && process.platform !== 'darwin' && error.code === 1) return null;
    throw error;
  }
}
