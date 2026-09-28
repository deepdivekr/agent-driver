/** Read-only local pixels -> text and exact-window DPI checks. No enumeration, input, network or files.
 * The owner supplies only a current CUA window PNG. OCR cannot mint action tokens. */
export const WINDOWS_VISUAL_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'} | Select-Object -First 1
function Wait-WinRT($operation,$resultType) {
  $task=$asTask.MakeGenericMethod($resultType).Invoke($null,@($operation))
  if(-not $task.Wait(8000)){throw 'OCR_TIMEOUT'}
  return $task.Result
}
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class VisualTiles {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
  [DllImport("shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor,out int scale);
  public static string CheckWindow(long window,int expectedPid) {
    uint pid; var hwnd=new IntPtr(window);
    if(GetWindowThreadProcessId(hwnd,out pid)==0 || pid!=expectedPid) return "WINDOW_CHANGED";
    int scale; int awareness=GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd));
    if(awareness<0 || GetScaleFactorForMonitor(MonitorFromWindow(hwnd,2),out scale)!=0) return "DPI_UNVERIFIED";
    // CUA 0.30.2 PrintWindow can put logical-size pixels into a physical-size
    // buffer for DPI-unaware apps. Refuse instead of inventing a scale transform.
    return awareness==0 && scale!=100 ? "DPI_UNVERIFIED" : "OK";
  }
  public static string[] Hash(Bitmap image) {
    var area=new Rectangle(0,0,image.Width,image.Height);
    var data=image.LockBits(area,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try {
      var stride=Math.Abs(data.Stride); var pixels=new byte[stride*image.Height];
      Marshal.Copy(data.Scan0,pixels,0,pixels.Length);
      var nx=(image.Width+127)/128; var ny=(image.Height+127)/128;
      var result=new string[nx*ny];
      using(var sha=SHA256.Create()) for(int ty=0;ty<ny;ty++) for(int tx=0;tx<nx;tx++) {
        int w=Math.Min(128,image.Width-tx*128),h=Math.Min(128,image.Height-ty*128);
        var part=new byte[w*h*4];
        for(int y=0;y<h;y++) Buffer.BlockCopy(pixels,(ty*128+y)*stride+tx*128*4,part,y*w*4,w*4);
        result[ty*nx+tx]=BitConverter.ToString(sha.ComputeHash(part)).Replace("-","").ToLowerInvariant();
      }
      return result;
    } finally { image.UnlockBits(data); }
  }
}
'@ -ReferencedAssemblies System.Drawing
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -eq $engine){throw 'OCR_LANGUAGE_UNAVAILABLE'}
function Read-Text($bitmap,$rect) {
  $crop=$null;$stream=$null;$memory=$null;$writer=$null;$software=$null
  try {
    $crop=$bitmap.Clone($rect,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $memory=New-Object System.IO.MemoryStream
    $crop.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
    $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer=New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($memory.ToArray())
    $null=Wait-WinRT ($writer.StoreAsync()) ([uint32])
    $null=$writer.DetachStream();$stream.Seek(0)
    $decoder=Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software=Wait-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result=Wait-WinRT ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $regions=@()
    foreach($line in $result.Lines) {
      if(-not $line.Text.Trim()){continue}
      $left=[double]::MaxValue;$top=[double]::MaxValue;$right=0;$bottom=0
      foreach($word in $line.Words){$b=$word.BoundingRect;$left=[Math]::Min($left,$b.X);$top=[Math]::Min($top,$b.Y);$right=[Math]::Max($right,$b.X+$b.Width);$bottom=[Math]::Max($bottom,$b.Y+$b.Height)}
      $regions+=@{text=$line.Text;bounds=@{x=[Math]::Floor($left)+$rect.X;y=[Math]::Floor($top)+$rect.Y;width=[Math]::Ceiling($right-$left);height=[Math]::Ceiling($bottom-$top)}}
    }
    return ,$regions
  } finally {if($software){$software.Dispose()};if($writer){$writer.Dispose()};if($stream){$stream.Dispose()};if($memory){$memory.Dispose()};if($crop){$crop.Dispose()}}
}
[Console]::WriteLine('{"ready":true}')
while($null -ne ($line=[Console]::ReadLine())) {
  $request=$null;$image=$null;$memory=$null
  try {
    if($line.Length -gt 12000000){throw 'INPUT_LIMIT'}
    $request=$line | ConvertFrom-Json
    $geometry=[VisualTiles]::CheckWindow([long]$request.window.window_id,[int]$request.window.pid)
    if($geometry -ne 'OK'){
      [Console]::WriteLine((@{id=$request.id;ok=$false;code=$geometry} | ConvertTo-Json -Compress));continue
    }
    $bytes=[Convert]::FromBase64String($request.png)
    $memory=New-Object System.IO.MemoryStream(,$bytes)
    $image=New-Object System.Drawing.Bitmap($memory)
    if($image.Width -ne $request.width -or $image.Height -ne $request.height -or $image.Width*$image.Height -gt 8000000){throw 'DIMENSIONS'}
    $tiles=[VisualTiles]::Hash($image)
    $rect=New-Object System.Drawing.Rectangle(0,0,$image.Width,$image.Height)
    $mode='full'
    if($request.previous -and $request.previous.tiles.Count -eq $tiles.Count) {
      $changed=@();for($i=0;$i -lt $tiles.Count;$i++){if($tiles[$i] -ne $request.previous.tiles[$i]){$changed+=,$i}}
      if($changed.Count -eq 0){$mode='unchanged'}
      else {
        $nx=[int][Math]::Ceiling($image.Width/128.0);$x1=$image.Width;$y1=$image.Height;$x2=0;$y2=0
        foreach($i in $changed){$x=($i%$nx)*128;$y=[Math]::Floor($i/$nx)*128;$x1=[Math]::Min($x1,$x);$y1=[Math]::Min($y1,$y);$x2=[Math]::Max($x2,$x+128);$y2=[Math]::Max($y2,$y+128)}
        $x1=[Math]::Max(0,$x1-32);$y1=[Math]::Max(0,$y1-32);$x2=[Math]::Min($image.Width,$x2+32);$y2=[Math]::Min($image.Height,$y2+32)
        # Do not cut an old text line in half when refreshing a changed tile.
        foreach($b in $request.previous.bounds){if($b.x -lt $x2 -and $b.x+$b.width -gt $x1 -and $b.y -lt $y2 -and $b.y+$b.height -gt $y1){$x1=[Math]::Max(0,[Math]::Min($x1,$b.x-16));$y1=[Math]::Max(0,[Math]::Min($y1,$b.y-16));$x2=[Math]::Min($image.Width,[Math]::Max($x2,$b.x+$b.width+16));$y2=[Math]::Min($image.Height,[Math]::Max($y2,$b.y+$b.height+16))}}
        if(($x2-$x1)*($y2-$y1) -lt $image.Width*$image.Height*0.65){$rect=New-Object System.Drawing.Rectangle([int]$x1,[int]$y1,[int]($x2-$x1),[int]($y2-$y1));$mode='region'}
      }
    }
    $regions=@();if($mode -ne 'unchanged'){$regions=Read-Text $image $rect}
    # Newly appearing text may extend beyond the changed crop: expand to full.
    if($mode -eq 'region'){
      foreach($region in $regions){$b=$region.bounds;if(($rect.X -gt 0 -and $b.x -le $rect.X+3) -or ($rect.Y -gt 0 -and $b.y -le $rect.Y+3) -or ($rect.Right -lt $image.Width -and $b.x+$b.width -ge $rect.Right-3) -or ($rect.Bottom -lt $image.Height -and $b.y+$b.height -ge $rect.Bottom-3)){$rect=New-Object System.Drawing.Rectangle(0,0,$image.Width,$image.Height);$mode='full';$regions=Read-Text $image $rect;break}}
    }
    $response=@{id=$request.id;ok=$true;mode=$mode;tiles=@($tiles);regions=@($regions);area=@{x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height}}
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    # Never leak exception bodies, image data or observed private text.
    [Console]::WriteLine((@{id=$request.id;ok=$false;code='OCR_UNAVAILABLE'} | ConvertTo-Json -Compress))
  } finally {if($image){$image.Dispose()};if($memory){$memory.Dispose()}}
}
`;
