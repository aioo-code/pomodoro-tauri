param([Parameter(Mandatory)][string]$Png,[Parameter(Mandatory)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$bitmap=[Drawing.Bitmap]::new([IO.Path]::GetFullPath($Png))
try {
    $rectangle=[Drawing.Rectangle]::new(0,0,$bitmap.Width,$bitmap.Height)
    $data=$bitmap.LockBits($rectangle,[Drawing.Imaging.ImageLockMode]::ReadOnly,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $rgba=[byte[]]::new($bitmap.Width*$bitmap.Height*4)
        $row=[byte[]]::new($bitmap.Width*4)
        for($y=0;$y -lt $bitmap.Height;$y++) {
            [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($data.Scan0,$data.Stride*$y),$row,0,$row.Length)
            for($x=0;$x -lt $bitmap.Width;$x++) {
                $from=$x*4;$to=($y*$bitmap.Width+$x)*4
                $rgba[$to]=$row[$from+2];$rgba[$to+1]=$row[$from+1];$rgba[$to+2]=$row[$from];$rgba[$to+3]=$row[$from+3]
            }
        }
        [IO.File]::WriteAllBytes([IO.Path]::GetFullPath($Output),$rgba)
    } finally {$bitmap.UnlockBits($data)}
} finally {$bitmap.Dispose()}
