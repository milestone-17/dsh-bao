# Native Windows toast for dsh-bao notifications.
#
# Uses the WinRT ToastNotification API. Windows PowerShell 5.1 (powershell.exe)
# still ships the WinRT projections that PowerShell 7 (pwsh.exe) dropped, so
# this script must run under powershell.exe — delivery.js resolves it from
# SystemRoot for exactly that reason.
#
# Identity: the toast is raised under the AppUserModelId of the installed
# DeepSeek Harness application when that Start Menu identity exists; a machine
# without it falls back to the always-present Windows PowerShell identity.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$AppUserModelId = 'com.deepseek.dsh'
)

$ErrorActionPreference = 'Stop'

# Load the WinRT projections this script needs.
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

# XML-escape both text fields; a title with '<' or '&' must not break the toast payload.
function ConvertTo-XmlText([string]$Value) {
  if ($null -eq $Value) { return '' }
  return [System.Security.SecurityElement]::Escape($Value)
}

$titleXml = ConvertTo-XmlText $Title
$bodyXml = ConvertTo-XmlText $Body

# scenario="reminder" keeps the toast on screen instead of auto-dismissing.
$xmlText = '<toast activationType="foreground" scenario="reminder"><visual><binding template="ToastGeneric"><text>' + $titleXml + '</text><text>' + $bodyXml + '</text></binding></visual></toast>'

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)

try {
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppUserModelId)
  $notifier.Show($toast)
} catch {
  $fallback = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell'
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($fallback)
  $notifier.Show($toast)
}
