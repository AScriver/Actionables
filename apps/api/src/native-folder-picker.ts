import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pickerScript = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
try {
  $dialog.Description = "Select a local repository folder."
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;
const encodedPickerScript = Buffer.from(pickerScript, "utf16le").toString(
  "base64",
);

export type NativeFolderPicker = () => Promise<string | null>;

export const selectNativeFolder: NativeFolderPicker = async () => {
  const result = await execFileAsync(
    "pwsh",
    ["-NoProfile", "-Sta", "-EncodedCommand", encodedPickerScript],
    { encoding: "utf8", windowsHide: true },
  );
  return String(result.stdout).trim() || null;
};
