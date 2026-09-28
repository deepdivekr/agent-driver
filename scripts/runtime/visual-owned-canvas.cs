// Native controlled acceptance surface, NOT a product/application adapter.
// Deliberately draws text and buttons with no UIA child controls.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public sealed class OwnedCanvas : Form {
  bool details=false;
  readonly Font font=new Font("Segoe UI",22);
  readonly Rectangle button=new Rectangle(70,160,320,75);
  public OwnedCanvas() {
    Text="Agent Office visual acceptance"; ClientSize=new Size(820,560);
    BackColor=Color.White; FormBorderStyle=FormBorderStyle.FixedSingle;
    MaximizeBox=false; StartPosition=FormStartPosition.CenterScreen;
    DoubleBuffered=true;
    Shown+=(s,e)=>Console.WriteLine("{\"pid\":"+Process.GetCurrentProcess().Id+",\"window_id\":"+Handle.ToInt64()+"}");
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e); e.Graphics.DrawString(details?"Details ready":"Workspace ready",font,Brushes.Black,70,70);
    e.Graphics.FillRectangle(Brushes.LightGray,button);
    e.Graphics.DrawString(details?"Return to workspace":"Open details",font,Brushes.Black,85,180);
  }
  protected override void OnMouseDown(MouseEventArgs e) {
    base.OnMouseDown(e); Console.WriteLine("{\"event\":\"mouse_down\",\"x\":"+e.X+",\"y\":"+e.Y+",\"matched\":"+(button.Contains(e.Location)?"true":"false")+"}");
    if(e.Button==MouseButtons.Left && button.Contains(e.Location)){details=!details;Invalidate();}
  }
  protected override void Dispose(bool disposing){if(disposing)font.Dispose();base.Dispose(disposing);}
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [STAThread] static void Main(string[] args){if(Array.IndexOf(args,"--dpi-unaware")<0)SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new OwnedCanvas());}
}
