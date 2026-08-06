# fix-bat-crlf.ps1
# 把启动网关.bat 的行尾统一转为 CRLF（bat 必需 CRLF，LF 会导致 cmd 解析崩溃闪退）
$enc = [System.Text.Encoding]::GetEncoding(936)
$paths = @(
    'D:\预设\sillytavern-gateway\启动网关.bat',
    'D:\QQbot\sillytavern-gateway\启动网关.bat'
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        $c = [System.IO.File]::ReadAllText($p, $enc)
        $c = $c -replace "`r`n", "`n"
        $c = $c -replace "`n", "`r`n"
        [System.IO.File]::WriteAllText($p, $c, $enc)
        Write-Host "已转 CRLF: $p"
    } else {
        Write-Warning "不存在: $p"
    }
}
