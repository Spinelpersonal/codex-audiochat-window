param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Capture', 'Voices', 'Speak')]
    [string] $Action
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    # All nonconstant values arrive as JSON, never as executable PowerShell source.
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($Action -eq 'Voices' -or $Action -eq 'Speak') {
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            if ($Action -eq 'Voices') {
                $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                    @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
                })
                [Console]::Out.Write((ConvertTo-Json -InputObject $voices -Depth 4 -Compress))
            } else {
                if ($request.text -isnot [string] -or $request.text.Length -gt 150000) { throw 'Invalid speech text' }
                $rate = [int]$request.rate
                $volume = [int]$request.volume
                if ($rate -lt -10 -or $rate -gt 10 -or $volume -lt 0 -or $volume -gt 100) { throw 'Invalid speech settings' }
                if (-not [string]::IsNullOrWhiteSpace($request.voice)) { $synth.SelectVoice([string]$request.voice) }
                $synth.Rate = $rate
                $synth.Volume = $volume
                $synth.SetOutputToDefaultAudioDevice()
                # Speak(string), NOT SpeakSsml: model text cannot execute speech markup.
                $synth.Speak([string]$request.text)
                [Console]::Out.Write('true')
            }
        } finally {
            $synth.SpeakAsyncCancelAll()
            $synth.Dispose()
        }
        exit 0
    }

    if ($request.mode -ne 'screen' -and $request.mode -ne 'region') { throw 'Invalid capture mode' }
    if (-not [System.IO.Path]::IsPathRooted([string]$request.outputPath) -or [System.IO.Path]::GetExtension([string]$request.outputPath) -ne '.png') {
        throw 'Invalid capture output path'
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CodexNative {
    internal static class Native {
        [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

        internal static void PhysicalCoordinates() {
            // PMv2 makes Cursor, Screen bounds, CopyFromScreen, and mouse events use physical pixels.
            try {
                if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
                    if (SetThreadDpiAwarenessContext(new IntPtr(-3)) == IntPtr.Zero) SetProcessDPIAware();
            } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        }
    }

    public static class Capture {
        public static bool Save(string mode, string outputPath) {
            Native.PhysicalCoordinates();
            if (mode == "screen") {
                Rectangle bounds = Screen.FromPoint(Cursor.Position).Bounds;
                using (Bitmap image = Snapshot(bounds)) {
                    image.Save(outputPath, ImageFormat.Png);
                }
                return true;
            }
            Rectangle desktop = SystemInformation.VirtualScreen;
            // Exactly one snapshot, taken before showing any overlay. No monitoring or clipboard.
            using (Bitmap frozen = Snapshot(desktop))
            using (SelectionOverlay overlay = new SelectionOverlay(frozen, desktop)) {
                if (overlay.ShowDialog() != DialogResult.OK) return false;
                Rectangle selected = overlay.Selection;
                using (Bitmap region = frozen.Clone(selected, PixelFormat.Format32bppArgb)) {
                    region.Save(outputPath, ImageFormat.Png);
                }
                return true;
            }
        }

        private static Bitmap Snapshot(Rectangle bounds) {
            Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            try {
                using (Graphics graphics = Graphics.FromImage(bitmap)) {
                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                }
                return bitmap;
            } catch {
                bitmap.Dispose();
                throw;
            }
        }
    }

    internal sealed class SelectionOverlay : Form {
        private readonly Bitmap frozen;
        private readonly Rectangle desktop;
        private readonly Timer timeout;
        private Point start;
        private bool dragging;
        public Rectangle Selection { get; private set; }

        internal SelectionOverlay(Bitmap image, Rectangle bounds) {
            frozen = image;
            desktop = bounds;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            DoubleBuffered = true;
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            // Allow time for JSON transport and cleanup inside the parent's 120-second deadline.
            timeout = new Timer { Interval = 115000 };
            timeout.Tick += delegate { CancelSelection(); };
        }

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            // WinForms can constrain a very wide form to one monitor. Reapply the virtual-screen
            // rectangle natively, including its negative origin, without any logical scaling.
            Native.SetWindowPos(Handle, new IntPtr(-1), desktop.Left, desktop.Top, desktop.Width, desktop.Height, 0x0040);
            Activate();
            Focus();
            timeout.Start();
        }

        protected override void WndProc(ref Message message) {
            // One overlay spans monitors at their physical resolution. Do not adopt WM_DPICHANGED's
            // suggested per-monitor scaled rectangle and lose alignment with the frozen bitmap.
            if (message.Msg == 0x02E0) { message.Result = IntPtr.Zero; return; }
            base.WndProc(ref message);
        }

        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.DrawImageUnscaled(frozen, 0, 0);
            using (Brush dim = new SolidBrush(Color.FromArgb(145, Color.Black)))
                e.Graphics.FillRectangle(dim, new Rectangle(Point.Empty, frozen.Size));
            if (Selection.Width > 0 && Selection.Height > 0) {
                e.Graphics.DrawImage(frozen, Selection, Selection, GraphicsUnit.Pixel);
                using (Pen border = new Pen(Color.White, 1))
                    e.Graphics.DrawRectangle(border, Selection.X, Selection.Y, Selection.Width - 1, Selection.Height - 1);
            }
            using (Brush foreground = new SolidBrush(Color.White))
            using (Brush background = new SolidBrush(Color.FromArgb(210, Color.Black)))
            using (Font font = new Font(SystemFonts.MessageBoxFont.FontFamily, 13)) {
                const string hint = "Drag to select a region - Escape to cancel";
                // Put instructions on the cursor's monitor, not offscreen in a gap of the desktop.
                Rectangle monitor = Screen.FromPoint(Cursor.Position).Bounds;
                Point origin = new Point(monitor.Left - desktop.Left + 20, monitor.Top - desktop.Top + 20);
                SizeF size = e.Graphics.MeasureString(hint, font);
                e.Graphics.FillRectangle(background, origin.X - 8, origin.Y - 6, size.Width + 16, size.Height + 12);
                e.Graphics.DrawString(hint, font, foreground, origin);
            }
            base.OnPaint(e);
        }

        private Point Clamped(Point location) {
            return new Point(Math.Max(0, Math.Min(frozen.Width, location.X)), Math.Max(0, Math.Min(frozen.Height, location.Y)));
        }
        private void UpdateSelection(Point location) {
            Point end = Clamped(location);
            Selection = Rectangle.FromLTRB(Math.Min(start.X, end.X), Math.Min(start.Y, end.Y), Math.Max(start.X, end.X), Math.Max(start.Y, end.Y));
            Invalidate();
        }
        protected override void OnMouseDown(MouseEventArgs e) {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right) { CancelSelection(); return; }
            if (e.Button != MouseButtons.Left) return;
            start = Clamped(e.Location);
            Selection = Rectangle.Empty;
            dragging = true;
            Capture = true;
        }
        protected override void OnMouseMove(MouseEventArgs e) {
            base.OnMouseMove(e);
            if (dragging) UpdateSelection(e.Location);
        }
        protected override void OnMouseUp(MouseEventArgs e) {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left || !dragging) return;
            UpdateSelection(e.Location);
            dragging = false;
            Capture = false;
            if (Selection.Width < 2 || Selection.Height < 2) { Selection = Rectangle.Empty; Invalidate(); return; }
            DialogResult = DialogResult.OK;
            Close();
        }
        protected override bool ProcessCmdKey(ref Message message, Keys keyData) {
            if (keyData == Keys.Escape) { CancelSelection(); return true; }
            return base.ProcessCmdKey(ref message, keyData);
        }
        private void CancelSelection() {
            dragging = false;
            Capture = false;
            DialogResult = DialogResult.Cancel;
            Close();
        }
        protected override void Dispose(bool disposing) {
            if (disposing) timeout.Dispose();
            base.Dispose(disposing);
        }
    }
}
'@
    $saved = [CodexNative.Capture]::Save([string]$request.mode, [string]$request.outputPath)
    if ($saved) { [Console]::Out.Write('{"saved":true}') } else { [Console]::Out.Write('null') }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
