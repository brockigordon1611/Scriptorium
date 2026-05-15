$port      = 3000
$htmlFile  = "C:\Users\brock\Desktop\Scriptorium\index.html"
$audioRoot = "C:\Users\brock\Desktop\Scriptorium\Audio"
$listener  = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving on http://localhost:$port"
[Console]::Out.Flush()
while ($listener.IsListening) {
    try {
        $ctx  = $listener.GetContext()
        $req  = $ctx.Request
        $resp = $ctx.Response
        try {
            $rawUrl = $req.Url.AbsolutePath
            if ($rawUrl.StartsWith('/audio/')) {
                $relPath  = [Uri]::UnescapeDataString($rawUrl.Substring(7))
                $filePath = Join-Path $audioRoot $relPath
                if (-not (Test-Path $filePath -PathType Leaf)) {
                    $resp.StatusCode = 404
                    $resp.Close(); continue
                }
                $fileInfo   = [System.IO.FileInfo]$filePath
                $totalBytes = $fileInfo.Length
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $resp.ContentType = if ($ext -eq '.json') { 'application/json' } else { 'audio/mpeg' }
                $resp.Headers.Add('Access-Control-Allow-Origin', '*')
                if ($ext -eq '.mp3') {
                    $resp.Headers.Add('Accept-Ranges', 'bytes')
                    $rangeHeader = $req.Headers['Range']
                    if ($rangeHeader -and $rangeHeader -match 'bytes=(\d+)-(\d*)') {
                        $start  = [long]$Matches[1]
                        $end    = if ($Matches[2]) { [long]$Matches[2] } else { $totalBytes - 1 }
                        if ($end -ge $totalBytes) { $end = $totalBytes - 1 }
                        $length = $end - $start + 1
                        $resp.StatusCode = 206
                        $resp.Headers.Add('Content-Range', "bytes $start-$end/$totalBytes")
                        $resp.ContentLength64 = $length
                        $buf = New-Object byte[] $length
                        $fs  = [System.IO.File]::OpenRead($filePath)
                        $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
                        $fs.Read($buf, 0, $length) | Out-Null
                        $fs.Close()
                        $resp.OutputStream.Write($buf, 0, $length)
                    } else {
                        $resp.StatusCode = 200
                        $resp.ContentLength64 = $totalBytes
                        $fs = [System.IO.File]::OpenRead($filePath)
                        $fs.CopyTo($resp.OutputStream)
                        $fs.Close()
                    }
                } else {
                    $resp.StatusCode = 200
                    $bytes = [System.IO.File]::ReadAllBytes($filePath)
                    $resp.ContentLength64 = $bytes.Length
                    $resp.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($htmlFile)
                $resp.ContentType = 'text/html; charset=utf-8'
                $resp.ContentLength64 = $bytes.Length
                $resp.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch { $resp.StatusCode = 500 }
        try { $resp.OutputStream.Close() } catch {}
    } catch {}
}
