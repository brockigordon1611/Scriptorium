# Batch-import strongs_occurrences.csv into Supabase via import_strongs_batch RPC
param([int]$BatchSize = 5000, [int]$StartBatch = 0)

$csvPath = "C:\Users\brock\Desktop\Scriptorium\stepbible\strongs_occurrences.csv"
$url     = "https://garuwsjczcptykehgjdx.supabase.co/rest/v1/rpc/import_strongs_batch"
$anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcnV3c2pjemNwdHlrZWhnamR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNzU3ODYsImV4cCI6MjA4ODY1MTc4Nn0.AL6IpnRaOAs8EQJSpnS0Ep4O9WD85RFU0xIm2ipXixE"

$headers = @{
  "apikey"        = $anonKey
  "Authorization" = "Bearer $anonKey"
  "Content-Type"  = "application/json"
}

function Escape-Json([string]$s) {
  $s.Replace('\','\\').Replace('"','\"').Replace("`n",'\n').Replace("`r",'\r').Replace("`t",'\t')
}

function Build-JsonBatch($chunk) {
  $sb = [System.Text.StringBuilder]::new()
  $sb.Append('{"rows":[') | Out-Null
  $first = $true
  foreach ($r in $chunk) {
    if (-not $first) { $sb.Append(',') | Out-Null }
    $first = $false
    $g = Escape-Json $r.g
    $s = Escape-Json $r.s
    $sb.Append("{`"b`":$($r.b),`"c`":$($r.c),`"v`":$($r.v),`"w`":$($r.w),`"s`":`"$s`",`"g`":`"$g`"}") | Out-Null
  }
  $sb.Append(']}') | Out-Null
  return $sb.ToString()
}

# Read all CSV rows
Write-Host "Reading CSV..."
$allRows = [System.Collections.Generic.List[object]]::new()
$reader  = [System.IO.StreamReader]::new($csvPath, [System.Text.Encoding]::UTF8)
$reader.ReadLine() | Out-Null  # skip header
while (-not $reader.EndOfStream) {
  $line = $reader.ReadLine()
  if (-not $line) { continue }
  # CSV fields: book_num,chapter,verse,word_index,strongs_num,"gloss"
  $f = $line -split ',', 6
  if ($f.Count -lt 5) { continue }
  $gloss = if ($f.Count -ge 6) { $f[5].Trim().Trim('"') } else { '' }
  $allRows.Add([pscustomobject]@{
    b=[int]$f[0]; c=[int]$f[1]; v=[int]$f[2]; w=[int]$f[3]
    s=$f[4]; g=$gloss
  })
}
$reader.Close()
$total  = $allRows.Count
$batches = [math]::Ceiling($total / $BatchSize)
Write-Host "Total rows: $total  |  Batches: $batches  (size $BatchSize)"

$inserted = 0
for ($i = $StartBatch; $i -lt $batches; $i++) {
  $start = $i * $BatchSize
  $end   = [math]::Min($start + $BatchSize, $total) - 1
  $chunk = $allRows[$start..$end]

  $body = Build-JsonBatch $chunk
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

  $attempt = 0; $ok = $false
  while (-not $ok -and $attempt -lt 3) {
    try {
      $resp = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $bodyBytes -ErrorAction Stop
      $cnt  = if ($resp -is [int]) { $resp } else { $chunk.Count }
      $inserted += $cnt
      $ok = $true
    } catch {
      $attempt++
      Write-Host "  Batch $($i+1) attempt $attempt failed: $($_.Exception.Message)"
      if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
    }
  }
  if (-not $ok) {
    Write-Host "BATCH $($i+1) FAILED. Re-run with: -StartBatch $i"
    exit 1
  }

  $pct = [math]::Round(($i+1)/$batches*100,1)
  Write-Host "[$pct%] Batch $($i+1)/$batches | rows $start-$end | total inserted: $inserted"
}

Write-Host ""
Write-Host "Done. Inserted: $inserted / $total"
