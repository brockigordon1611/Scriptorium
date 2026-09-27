# Parse STEPBible TAHOT + TAGNT files into strongs_word_occurrences CSV
# Output: strongs_occurrences.csv  (book_num, chapter, verse, word_index, strongs_num, gloss)

$dir = "C:\Users\brock\Desktop\Scriptorium\stepbible"
$outPath = Join-Path $dir "strongs_occurrences.csv"

$bookMap = @{
  'Gen'=1;  'Exo'=2;  'Lev'=3;  'Num'=4;  'Deu'=5;
  'Jos'=6;  'Jdg'=7;  'Rut'=8;  '1Sa'=9;  '2Sa'=10;
  '1Ki'=11; '2Ki'=12; '1Ch'=13; '2Ch'=14; 'Ezr'=15;
  'Neh'=16; 'Est'=17; 'Job'=18; 'Psa'=19; 'Pro'=20;
  'Ecc'=21; 'Sng'=22; 'Isa'=23; 'Jer'=24; 'Lam'=25;
  'Ezk'=26; 'Dan'=27; 'Hos'=28; 'Joe'=29; 'Amo'=30;
  'Oba'=31; 'Jon'=32; 'Mic'=33; 'Nah'=34; 'Hab'=35;
  'Zep'=36; 'Hag'=37; 'Zec'=38; 'Mal'=39;
  'Mat'=40; 'Mrk'=41; 'Luk'=42; 'Jhn'=43; 'Act'=44;
  'Rom'=45; '1Co'=46; '2Co'=47; 'Gal'=48; 'Eph'=49;
  'Php'=50; 'Col'=51; '1Th'=52; '2Th'=53; '1Ti'=54;
  '2Ti'=55; 'Tit'=56; 'Phm'=57; 'Heb'=58; 'Jas'=59;
  '1Pe'=60; '2Pe'=61; '1Jn'=62; '2Jn'=63; '3Jn'=64;
  'Jud'=65; 'Rev'=66
}

function Normalize-Strong($raw) {
  # Strip curly braces, conjoin markers, backslash suffixes
  $raw = $raw -replace '[{}\\\[\]]', ''
  $raw = $raw -replace '^[«»]', ''
  $raw = $raw.Trim()
  if ($raw -match '^([HGAa])0*(\d+)[A-Za-z]*$') {
    $prefix = $Matches[1].ToUpper()
    if ($prefix -eq 'A') { $prefix = 'H' }  # Aramaic = Hebrew range
    $num = [int]$Matches[2]
    return "$prefix$num"
  }
  return $null
}

$writer = [System.IO.StreamWriter]::new($outPath, $false, [System.Text.Encoding]::UTF8)
$writer.WriteLine("book_num,chapter,verse,word_index,strongs_num,gloss")
$totalRows = 0

# ── TAHOT files (Hebrew OT) ──────────────────────────────────────────────────
$tahotFiles = @(
  "TAHOT_Gen-Deu.txt", "TAHOT_Jos-Est.txt",
  "TAHOT_Job-Sng.txt", "TAHOT_Isa-Mal.txt"
)

foreach ($fname in $tahotFiles) {
  $fpath = Join-Path $dir $fname
  Write-Host "Parsing $fname ..."
  $reader = [System.IO.StreamReader]::new($fpath, [System.Text.Encoding]::UTF8)
  $lineCount = 0

  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    $lineCount++

    # Individual word lines match: Book.ch.v#wordIndex=type  (no leading #)
    # e.g.  Gen.1.1#01=L   or   1Sa.1.1#03=Q
    $f0 = $line.IndexOf("`t")
    $ref = if ($f0 -ge 0) { $line.Substring(0, $f0) } else { $line }

    if ($ref -notmatch '^([A-Za-z1-9]{2,3})\.(\d+)\.(\d+)#(\d+)=') { continue }

    $bookAbbr = $Matches[1]
    $ch       = [int]$Matches[2]
    $v        = [int]$Matches[3]
    $wordIdx  = [int]$Matches[4]

    $bookNum  = $bookMap[$bookAbbr]
    if (-not $bookNum) { continue }

    $fields = $line -split "`t"
    if ($fields.Count -lt 5) { continue }

    $gloss     = $fields[3].Trim()   # translation
    $dStrongsF = $fields[4].Trim()   # dStrongs field  e.g. H9003/{H7225G}

    # Strip trailing \H9016 style punctuation markers
    $dStrongsF = $dStrongsF -replace '\\[HG]\d+[A-Za-z]*', ''

    # Split by / to get prefix / root / suffix components
    $components = $dStrongsF -split '/'

    # Split gloss by '/ ' to align with components
    $glossParts = $gloss -split '/\s*'

    for ($i = 0; $i -lt $components.Count; $i++) {
      $comp      = $components[$i].Trim()
      $compGloss = if ($i -lt $glossParts.Count) { $glossParts[$i].Trim() } else { $gloss }

      # Handle | separator (multiple Strong's on one component — rare in TAHOT)
      $parts = $comp -split '\|'
      foreach ($part in $parts) {
        $sNum = Normalize-Strong $part
        if (-not $sNum) { continue }
        # TAHOT = OT; emit only H-prefixed Strong's
        if ($sNum[0] -ne 'H') { continue }

        $g = $compGloss -replace '"', '""'
        $writer.WriteLine("$bookNum,$ch,$v,$wordIdx,$sNum,`"$g`"")
        $totalRows++
      }
    }
  }
  $reader.Close()
  Write-Host "  -> $lineCount lines processed"
}

# ── TAGNT files (Greek NT) ───────────────────────────────────────────────────
$tagntFiles = @("TAGNT_Mat-Jhn.txt", "TAGNT_Act-Rev.txt")

foreach ($fname in $tagntFiles) {
  $fpath = Join-Path $dir $fname
  Write-Host "Parsing $fname ..."
  $reader = [System.IO.StreamReader]::new($fpath, [System.Text.Encoding]::UTF8)
  $lineCount = 0

  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    $lineCount++

    $f0  = $line.IndexOf("`t")
    $ref = if ($f0 -ge 0) { $line.Substring(0, $f0) } else { $line }

    if ($ref -notmatch '^([A-Za-z1-9]{2,3})\.(\d+)\.(\d+)#(\d+)=(.+)$') { continue }

    $bookAbbr = $Matches[1]
    $ch       = [int]$Matches[2]
    $v        = [int]$Matches[3]
    $wordIdx  = [int]$Matches[4]
    $wordType = $Matches[5]

    # Only include words present in the KJV/TR text (type contains K or k)
    if ($wordType -inotmatch 'k') { continue }

    $bookNum = $bookMap[$bookAbbr]
    if (-not $bookNum) { continue }

    $fields = $line -split "`t"
    if ($fields.Count -lt 4) { continue }

    $gloss       = $fields[2].Trim()   # English translation
    $dStrongsF   = $fields[3].Trim()   # "G2424G=N-GSM-P" or "H1732|G1138«G1138=N-GSM-P"

    # Split by first = to isolate the Strong's part
    $eqIdx    = $dStrongsF.IndexOf('=')
    $strongPart = if ($eqIdx -ge 0) { $dStrongsF.Substring(0, $eqIdx) } else { $dStrongsF }

    # Handle | separator (Hebrew origin | Greek form)
    $parts = $strongPart -split '\|'
    foreach ($part in $parts) {
      $sNum = Normalize-Strong $part
      if (-not $sNum) { continue }
      # TAGNT = NT; emit only G-prefixed Strong's
      if ($sNum[0] -ne 'G') { continue }

      $g = $gloss -replace '"', '""'
      $writer.WriteLine("$bookNum,$ch,$v,$wordIdx,$sNum,`"$g`"")
      $totalRows++
    }
  }
  $reader.Close()
  Write-Host "  -> $lineCount lines processed"
}

$writer.Close()
Write-Host ""
Write-Host "Done! Total rows: $totalRows"
Write-Host "Output: $outPath"
