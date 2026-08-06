# fix-bat.ps1
# 把启动网关.bat 转成 GBK 编码 + CRLF 行尾（bat 必需），并同步到测试目录
$gbk = [System.Text.Encoding]::GetEncoding(936)
$src = 'D:\预设\sillytavern-gateway\启动网关.bat'
$dst = 'D:\QQbot\sillytavern-gateway\启动网关.bat'

# 1. 开发目录：UTF-8(Write 输出) -> GBK + CRLF
$c = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
$c = $c -replace "`r`n", "`n"
$c = $c -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($src, $c, $gbk)
Write-Host "开发目录已转 GBK+CRLF: $src"

# 2. 复制到测试目录（字节级，保留编码/行尾）
Copy-Item -LiteralPath $src -Destination $dst -Force
Write-Host "已复制到测试目录: $dst"
