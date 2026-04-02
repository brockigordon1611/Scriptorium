$port = 3000
$file = "C:\Users\brock\Desktop\Scriptorium\index.html"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving on http://localhost:$port"
[Console]::Out.Flush()
while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ctx.Response.ContentType = "text/html; charset=utf-8"
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {}
        try { $ctx.Response.OutputStream.Close() } catch {}
    } catch {}
}
