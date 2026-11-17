$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (Test-Path '.env') {
  $a = Read-Host '.env already exists. Replace it? (y/n)'
  if ($a -ne 'y') { Write-Host 'Nothing changed.'; exit 0 }
}
$sec = Read-Host 'Paste your Digikala Self Token (it will not be shown) and press Enter' -AsSecureString
$tok = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if ($tok.Length -lt 10) { Write-Host 'Token looks empty. Run this file again.'; exit 1 }
$chars = [char[]]'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$pg = -join (1..28 | ForEach-Object { $chars | Get-Random })
$lines = Get-Content '.env.example' -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^DIGIKALA_SELF_TOKEN=') { "DIGIKALA_SELF_TOKEN=$tok" }
  elseif ($_ -match '^POSTGRES_PASSWORD=') { "POSTGRES_PASSWORD=$pg" }
  else { $_ }
}
[IO.File]::WriteAllLines((Join-Path $root '.env'), $lines, (New-Object Text.UTF8Encoding $false))
Write-Host ''
Write-Host 'OK: .env was created. Never send this file to anyone.'
