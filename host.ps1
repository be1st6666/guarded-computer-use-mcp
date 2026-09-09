#requires -Version 5.1
<#
  PowerShell host process for computer-use-mcp.

  Design notes:
    - The C# helper is compiled ONCE at startup, so per-call cost is just a
      script dispatch instead of a full Add-Type compile.
    - SetProcessDPIAware() runs BEFORE any measurement, so screenshots and
      mouse coordinates share one physical coordinate space.
    - Protocol: one base64(UTF-8 JSON request) per stdin line, one
      base64(UTF-8 JSON response) per stdout line. Everything on the wire is
      ASCII, which sidesteps Windows PowerShell 5.1 console encoding entirely.
    - THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI
      when there is no BOM; a single non-ASCII byte can swallow a newline and
      corrupt the embedded C#.
#>

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
if ($PSVersionTable.PSEdition -eq 'Core') {
    Add-Type -AssemblyName System.Drawing.Common
} else {
    Add-Type -AssemblyName System.Drawing
}

# -ReferencedAssemblies behaves differently across editions:
#   5.1 : ADDS to the default reference set
#   7.x : REPLACES it, so every assembly the C# touches must be listed
if ($PSVersionTable.PSEdition -eq 'Core') {
    # UIAutomation + WindowsBase must come from $PSHOME by full path: a bare
    # name resolves to the .NET Framework 4.0 copies and then CS1705-fails
    # against UIAutomationClient 10.0.
    $refs = @('System.Drawing.Common', 'System.Drawing.Primitives', 'System.Windows.Forms',
              'System.Private.Windows.Core', 'System.Private.Windows.GdiPlus',
              'System.Collections', 'System.Runtime', 'System.Runtime.InteropServices',
              'System.Diagnostics.Process', 'System.ComponentModel.Primitives',
              'System.Text.Encoding.Extensions', 'System.Memory', 'System.Linq',
              'System.Threading.Thread',
              (Join-Path $PSHOME 'UIAutomationClient.dll'),
              (Join-Path $PSHOME 'UIAutomationTypes.dll'),
              (Join-Path $PSHOME 'WindowsBase.dll'))
} else {
    $refs = @('System.Drawing', 'System.Windows.Forms',
              'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
}

# ---- DPI awareness must come first ----
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiShim {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try { [void][DpiShim]::SetProcessDPIAware() } catch { }

# ---- the actual implementation ----
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class Dsh
{
    // ---------------- Win32 ----------------
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    delegate bool EnumProc(IntPtr h, IntPtr p);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MD_LEFT_DOWN = 0x0002, MD_LEFT_UP = 0x0004, MD_RIGHT_DOWN = 0x0008, MD_RIGHT_UP = 0x0010,
               MD_MID_DOWN = 0x0020, MD_MID_UP = 0x0040, MD_WHEEL = 0x0800;
    const uint KEY_UP = 0x0002, KEY_UNICODE = 0x0004;

    static int SZ { get { return Marshal.SizeOf(typeof(INPUT)); } }

    static void Send(params INPUT[] inputs) {
        uint r = SendInput((uint)inputs.Length, inputs, SZ);
        if (r != (uint)inputs.Length) throw new Exception("SendInput blocked, win32 error " + Marshal.GetLastWin32Error());
    }

    static INPUT KeyInput(ushort vk, bool up) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? KEY_UP : 0;
        return i;
    }

    // ---------------- queries ----------------
    public static string ScreenSize() {
        Rectangle v = System.Windows.Forms.SystemInformation.VirtualScreen;
        return "{\"width\":" + v.Width + ",\"height\":" + v.Height + ",\"x\":" + v.X + ",\"y\":" + v.Y + "}";
    }

    public static string CursorPos() {
        POINT p; GetCursorPos(out p);
        return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}";
    }

    public static string Displays() {
        StringBuilder sb = new StringBuilder("[");
        System.Windows.Forms.Screen[] screens = System.Windows.Forms.Screen.AllScreens;
        for (int i = 0; i < screens.Length; i++) {
            System.Windows.Forms.Screen s = screens[i];
            if (i > 0) sb.Append(",");
            sb.Append("{\"index\":").Append(i)
              .Append(",\"device\":\"").Append(Esc(s.DeviceName)).Append("\"")
              .Append(",\"primary\":").Append(s.Primary ? "true" : "false")
              .Append(",\"bounds\":[").Append(s.Bounds.X).Append(",").Append(s.Bounds.Y).Append(",")
              .Append(s.Bounds.Width).Append(",").Append(s.Bounds.Height).Append("]}");
        }
        return sb.Append("]").ToString();
    }

    public static string ListWindows() {
        StringBuilder sb = new StringBuilder("[");
        bool first = true;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowText(h, t, 512);
            string title = t.ToString();
            if (title.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            RECT r; GetWindowRect(h, out r);
            if (!first) sb.Append(",");
            first = false;
            sb.Append("{\"handle\":").Append(h.ToInt64())
              .Append(",\"pid\":").Append(pid)
              .Append(",\"minimized\":").Append(IsIconic(h) ? "true" : "false")
              .Append(",\"title\":\"").Append(Esc(title)).Append("\"")
              .Append(",\"rect\":[").Append(r.L).Append(",").Append(r.T).Append(",")
              .Append(r.R).Append(",").Append(r.B).Append("]}");
            return true;
        }, IntPtr.Zero);
        return sb.Append("]").ToString();
    }

    public static string ActiveWindow() {
        IntPtr h = GetForegroundWindow();
        StringBuilder t = new StringBuilder(512);
        GetWindowText(h, t, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        return "{\"handle\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"process\":\"" + Esc(name) +
               "\",\"title\":\"" + Esc(t.ToString()) + "\",\"rect\":[" + r.L + "," + r.T + "," + r.R + "," + r.B + "]}";
    }

    // ---------------- screenshot ----------------
    // Capture + downscale in ONE GDI call (StretchBlt), so there is no
    // intermediate full-size bitmap to allocate and resample. Measured on a
    // 2560x1600 screen: capture+scale dropped from ~105ms to ~35ms.
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern bool StretchBlt(IntPtr hdcD, int xD, int yD, int wD, int hD,
        IntPtr hdcS, int xS, int yS, int wS, int hS, int rop);
    [DllImport("gdi32.dll")] static extern int SetStretchBltMode(IntPtr hdc, int mode);
    [DllImport("gdi32.dll")] static extern bool SetBrushOrgEx(IntPtr hdc, int x, int y, IntPtr prev);
    const int SRCCOPY = 0x00CC0020, HALFTONE = 4, COLORONCOLOR = 3;

    // Returns newline-delimited fields, NOT json:
    //   data, mime, width, height, capturedWidth, capturedHeight, bytes,
    //   captureMs, scaleMs, encodeMs, base64Ms
    // Windows PowerShell 5.1's ConvertFrom-Json fails on multi-hundred-KB
    // strings, so the caller must never round-trip this payload through json.
    public static string Shot(int x, int y, int w, int h, int maxSide, string format, int quality, string interp) {
        Stopwatch sw = Stopwatch.StartNew();

        int ow = w, oh = h;
        if (maxSide > 0 && Math.Max(w, h) > maxSide) {
            double s = (double)maxSide / Math.Max(w, h);
            ow = Math.Max(1, (int)Math.Round(w * s));
            oh = Math.Max(1, (int)Math.Round(h * s));
        }

        Bitmap outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(outBmp)) {
            IntPtr destDc = g.GetHdc();
            IntPtr srcDc = GetDC(IntPtr.Zero);
            try {
                int mode = (interp == "nearest") ? COLORONCOLOR : HALFTONE;
                SetStretchBltMode(destDc, mode);
                SetBrushOrgEx(destDc, 0, 0, IntPtr.Zero);
                StretchBlt(destDc, 0, 0, ow, oh, srcDc, x, y, w, h, SRCCOPY);
            } finally {
                ReleaseDC(IntPtr.Zero, srcDc);
                g.ReleaseHdc(destDc);
            }
        }
        double tCap = sw.Elapsed.TotalMilliseconds; sw.Restart();

        byte[] bytes;
        bool isJpeg = (format == "jpeg");
        using (MemoryStream ms = new MemoryStream()) {
            if (isJpeg) {
                ImageCodecInfo jpg = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    if (c.MimeType == "image/jpeg") { jpg = c; break; }
                EncoderParameters ps = new EncoderParameters(1);
                ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                outBmp.Save(ms, jpg, ps);
            } else {
                outBmp.Save(ms, ImageFormat.Png);
            }
            bytes = ms.ToArray();
        }
        outBmp.Dispose();
        double tEnc = sw.Elapsed.TotalMilliseconds; sw.Restart();
        string b64 = Convert.ToBase64String(bytes);
        double tB64 = sw.Elapsed.TotalMilliseconds;

        return b64 + "\n" + (isJpeg ? "image/jpeg" : "image/png") + "\n" +
               ow + "\n" + oh + "\n" + w + "\n" + h + "\n" + bytes.Length + "\n" +
               tCap.ToString("F1") + "\n0.0\n" + tEnc.ToString("F1") + "\n" + tB64.ToString("F1");
    }

    // Capture a region straight to a PNG file, for external OCR backends.
    public static string SavePng(int x, int y, int w, int h, string path) {
        using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr destDc = g.GetHdc();
                IntPtr srcDc = GetDC(IntPtr.Zero);
                try {
                    SetStretchBltMode(destDc, HALFTONE);
                    SetBrushOrgEx(destDc, 0, 0, IntPtr.Zero);
                    StretchBlt(destDc, 0, 0, w, h, srcDc, x, y, w, h, SRCCOPY);
                } finally {
                    ReleaseDC(IntPtr.Zero, srcDc);
                    g.ReleaseHdc(destDc);
                }
            }
            bmp.Save(path, ImageFormat.Png);
        }
        return "{\"path\":\"" + Esc(path) + "\",\"width\":" + w + ",\"height\":" + h + "}";
    }

    // Cheap perceptual fingerprint of the screen: StretchBlt straight down to
    // 64x40 (no full-size intermediate), then FNV-1a the pixels. Used by
    // wait_for_change so callers never poll with full screenshots.
    public static string Fingerprint(int x, int y, int w, int h) {
        int tw = 64, th = Math.Max(1, 64 * h / Math.Max(1, w));
        using (Bitmap small = new Bitmap(tw, th, PixelFormat.Format24bppRgb)) {
            using (Graphics g = Graphics.FromImage(small)) {
                IntPtr destDc = g.GetHdc();
                IntPtr srcDc = GetDC(IntPtr.Zero);
                try {
                    SetStretchBltMode(destDc, HALFTONE);
                    SetBrushOrgEx(destDc, 0, 0, IntPtr.Zero);
                    StretchBlt(destDc, 0, 0, tw, th, srcDc, x, y, w, h, SRCCOPY);
                } finally {
                    ReleaseDC(IntPtr.Zero, srcDc);
                    g.ReleaseHdc(destDc);
                }
            }
            ulong h1 = 1469598103934665603UL;
            for (int yy = 0; yy < th; yy++) {
                for (int xx = 0; xx < tw; xx++) {
                    Color c = small.GetPixel(xx, yy);
                    int v = (c.R + c.G + c.B) / 3;
                    h1 = (h1 ^ (ulong)v) * 1099511628211UL;
                }
            }
            return h1.ToString();
        }
    }

    // ---------------- mouse ----------------
    public static void MoveTo(int x, int y) {
        if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed");
        System.Threading.Thread.Sleep(20);
    }

    static uint ButtonFlag(string button, bool down) {
        if (button == "right") return down ? MD_RIGHT_DOWN : MD_RIGHT_UP;
        if (button == "middle") return down ? MD_MID_DOWN : MD_MID_UP;
        return down ? MD_LEFT_DOWN : MD_LEFT_UP;
    }

    static void Button(string button, bool down) {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = ButtonFlag(button, down);
        Send(i);
    }

    public static void Click(int x, int y, string button, int count) {
        MoveTo(x, y);
        for (int k = 0; k < count; k++) {
            Button(button, true);
            System.Threading.Thread.Sleep(12);
            Button(button, false);
            System.Threading.Thread.Sleep(12);
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button, int steps) {
        MoveTo(x1, y1);
        Button(button, true);
        System.Threading.Thread.Sleep(60);
        for (int i = 1; i <= steps; i++) {
            SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
            System.Threading.Thread.Sleep(12);
        }
        System.Threading.Thread.Sleep(60);
        Button(button, false);
    }

    // mouseData is unchecked-cast to uint so a negative (scroll down) value
    // keeps the right bits. The old third-party package declared it uint in
    // PowerShell and threw on every downward scroll.
    public static void Scroll(int notches) {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = MD_WHEEL;
        i.u.mi.mouseData = unchecked((uint)(notches * 120));
        Send(i);
    }

    // ---------------- keyboard ----------------
    // Unicode injection: CJK, quotes and emoji go through verbatim, with no
    // string escaping anywhere in the path.
    public static void TypeText(string textValue) {
        foreach (char c in textValue) {
            INPUT[] pair = new INPUT[2];
            pair[0].type = INPUT_KEYBOARD;
            pair[0].u.ki.wScan = (ushort)c;
            pair[0].u.ki.dwFlags = KEY_UNICODE;
            pair[1].type = INPUT_KEYBOARD;
            pair[1].u.ki.wScan = (ushort)c;
            pair[1].u.ki.dwFlags = KEY_UNICODE | KEY_UP;
            Send(pair);
            System.Threading.Thread.Sleep(2);
        }
    }

    static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        {"backspace",8},{"tab",9},{"enter",13},{"return",13},{"shift",16},{"ctrl",17},{"control",17},
        {"alt",18},{"pause",19},{"capslock",20},{"esc",27},{"escape",27},{"space",32},
        {"pageup",33},{"pagedown",34},{"end",35},{"home",36},{"left",37},{"up",38},{"right",39},{"down",40},
        {"insert",45},{"delete",46},{"del",46},{"numlock",144},{"scrolllock",145},
        {"win",91},{"super",91},{"meta",91},{"printscreen",44},
        {"f1",112},{"f2",113},{"f3",114},{"f4",115},{"f5",116},{"f6",117},{"f7",118},{"f8",119},
        {"f9",120},{"f10",121},{"f11",122},{"f12",123}
    };

    public static ushort VkOf(string key) {
        ushort v;
        if (VK.TryGetValue(key.Trim(), out v)) return v;
        if (key.Trim().Length == 1) return (ushort)char.ToUpperInvariant(key.Trim()[0]);
        throw new Exception("unknown key: " + key);
    }

    public static void KeyCombo(string combo) {
        string[] parts = combo.Split('+');
        List<ushort> vks = new List<ushort>();
        foreach (string p in parts) if (p.Trim().Length > 0) vks.Add(VkOf(p));
        if (vks.Count == 0) throw new Exception("empty key combo");
        List<INPUT> seq = new List<INPUT>();
        foreach (ushort vk in vks) seq.Add(KeyInput(vk, false));
        for (int i = vks.Count - 1; i >= 0; i--) seq.Add(KeyInput(vks[i], true));
        Send(seq.ToArray());
    }

    public static void HoldKey(string key, int ms) {
        ushort vk = VkOf(key);
        Send(KeyInput(vk, false));
        System.Threading.Thread.Sleep(Math.Max(1, ms));
        Send(KeyInput(vk, true));
    }

    // ---------------- windows ----------------
    public static string ActivateWindow(string titleMatch, int pid) {
        IntPtr found = IntPtr.Zero;
        string foundTitle = null;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            uint wp; GetWindowThreadProcessId(h, out wp);
            if (pid > 0 && (int)wp != pid) return true;
            StringBuilder t = new StringBuilder(512);
            GetWindowText(h, t, 512);
            string title = t.ToString();
            if (title.Length == 0) return true;
            if (pid > 0 || (titleMatch != null && title.IndexOf(titleMatch, StringComparison.OrdinalIgnoreCase) >= 0)) {
                found = h; foundTitle = title;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) throw new Exception("window not found");
        if (IsIconic(found)) ShowWindow(found, 9);
        SetForegroundWindow(found);
        System.Threading.Thread.Sleep(150);
        return "{\"handle\":" + found.ToInt64() + ",\"title\":\"" + Esc(foundTitle) + "\"}";
    }

    // ---------------- clipboard ----------------
    public static string ReadClipboard() {
        string s = System.Windows.Forms.Clipboard.GetText();
        return s == null ? "" : s;
    }

    public static void WriteClipboard(string value) {
        System.Windows.Forms.Clipboard.SetText(value == null ? "" : value);
    }

    // ---------------- UI Automation (semantic targeting) ----------------
    // Coordinates fail silently when a window moves; the accessibility tree
    // does not. Prefer these over pixel coordinates wherever the app exposes
    // a control tree; fall back to screenshot + coordinates for canvas-style
    // UI that has none.
    static readonly Dictionary<string, ControlType> CTYPES = new Dictionary<string, ControlType>(StringComparer.OrdinalIgnoreCase) {
        {"button", ControlType.Button}, {"edit", ControlType.Edit}, {"textbox", ControlType.Edit},
        {"text", ControlType.Text}, {"label", ControlType.Text}, {"checkbox", ControlType.CheckBox},
        {"radio", ControlType.RadioButton}, {"combobox", ControlType.ComboBox}, {"list", ControlType.List},
        {"listitem", ControlType.ListItem}, {"menu", ControlType.Menu}, {"menuitem", ControlType.MenuItem},
        {"window", ControlType.Window}, {"pane", ControlType.Pane}, {"document", ControlType.Document},
        {"hyperlink", ControlType.Hyperlink}, {"tab", ControlType.Tab}, {"tabitem", ControlType.TabItem},
        {"image", ControlType.Image}, {"slider", ControlType.Slider}, {"spinner", ControlType.Spinner},
        {"tooltip", ControlType.ToolTip}, {"group", ControlType.Group}, {"tree", ControlType.Tree},
        {"treeitem", ControlType.TreeItem}, {"scrollbar", ControlType.ScrollBar},
        {"progressbar", ControlType.ProgressBar}, {"separator", ControlType.Separator}
    };

    static ControlType CTof(string s) {
        if (string.IsNullOrEmpty(s)) return null;
        ControlType ct;
        return CTYPES.TryGetValue(s.Trim(), out ct) ? ct : null;
    }

    static string SafeName(AutomationElement e) {
        try { return e.Current.Name ?? ""; } catch { return ""; }
    }

    static AutomationElement TopWindow(string titleSub) {
        AutomationElementCollection wins =
            AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in wins) {
            string t = SafeName(w);
            if (t.Length == 0) continue;
            if (string.IsNullOrEmpty(titleSub) ||
                t.IndexOf(titleSub, StringComparison.OrdinalIgnoreCase) >= 0) return w;
        }
        return null;
    }

    static List<AutomationElement> MatchElems(string nameSub, string controlType, string automationId,
                                              string cls, string windowTitle, int max) {
        AutomationElement scope;
        if (!string.IsNullOrEmpty(windowTitle)) {
            scope = TopWindow(windowTitle);
            if (scope == null) throw new Exception("window not found: " + windowTitle);
        } else {
            scope = AutomationElement.FromHandle(GetForegroundWindow());
            if (scope == null) scope = AutomationElement.RootElement;
        }

        Condition cond = Condition.TrueCondition;
        ControlType ct = CTof(controlType);
        if (ct != null) cond = new AndCondition(cond, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
        if (!string.IsNullOrEmpty(automationId))
            cond = new AndCondition(cond, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
        if (!string.IsNullOrEmpty(cls))
            cond = new AndCondition(cond, new PropertyCondition(AutomationElement.ClassNameProperty, cls));

        AutomationElementCollection found = scope.FindAll(TreeScope.Descendants, cond);
        List<AutomationElement> hits = new List<AutomationElement>();
        foreach (AutomationElement e in found) {
            if (!string.IsNullOrEmpty(nameSub)) {
                string n = SafeName(e);
                if (n.IndexOf(nameSub, StringComparison.OrdinalIgnoreCase) < 0) continue;
            }
            hits.Add(e);
            if (max > 0 && hits.Count >= max) break;
        }
        return hits;
    }

    static string ElemJson(AutomationElement e) {
        AutomationElement.AutomationElementInformation c = e.Current;
        var r = c.BoundingRectangle;
        ControlType t = c.ControlType;
        return "{\"name\":\"" + Esc(c.Name) + "\""
             + ",\"controlType\":\"" + Esc(t == null ? "" : t.ProgrammaticName.Replace("ControlType.", "")) + "\""
             + ",\"automationId\":\"" + Esc(c.AutomationId) + "\""
             + ",\"className\":\"" + Esc(c.ClassName) + "\""
             + ",\"enabled\":" + (c.IsEnabled ? "true" : "false")
             + ",\"offscreen\":" + (c.IsOffscreen ? "true" : "false")
             + ",\"center\":[" + (int)(r.X + r.Width / 2) + "," + (int)(r.Y + r.Height / 2) + "]"
             + ",\"rect\":[" + (int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height + "]}";
    }

    public static string FindElements(string nameSub, string controlType, string automationId,
                                      string cls, string windowTitle, int max) {
        List<AutomationElement> hits = MatchElems(nameSub, controlType, automationId, cls, windowTitle, max);
        StringBuilder b = new StringBuilder("{\"count\":").Append(hits.Count).Append(",\"elements\":[");
        for (int i = 0; i < hits.Count; i++) {
            if (i > 0) b.Append(",");
            b.Append(ElemJson(hits[i]));
        }
        return b.Append("]}").ToString();
    }

    public static string ClickElement(string nameSub, string controlType, string automationId,
                                      string cls, string windowTitle, int index) {
        List<AutomationElement> hits = MatchElems(nameSub, controlType, automationId, cls, windowTitle, 50);
        if (hits.Count == 0) throw new Exception("no element matched the criteria");
        if (index < 0 || index >= hits.Count)
            throw new Exception("index " + index + " out of range (matched " + hits.Count + ")");
        AutomationElement e = hits[index];

        string how = "";
        try {
            object pat;
            if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) {
                ((InvokePattern)pat).Invoke();
                how = "invoke";
            }
        } catch { }
        if (how.Length == 0) {
            var r = e.Current.BoundingRectangle;
            if (r.Width <= 0 || r.Height <= 0) throw new Exception("element has no clickable bounds");
            Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", 1);
            how = "mouse";
        }
        System.Threading.Thread.Sleep(100);
        return "{\"how\":\"" + how + "\",\"element\":" + ElemJson(e) + "}";
    }

    // Compact indented dump for discovering what an app exposes.
    public static string UiTree(string windowTitle, int maxDepth, int maxNodes) {
        AutomationElement root = string.IsNullOrEmpty(windowTitle)
            ? AutomationElement.FromHandle(GetForegroundWindow())
            : TopWindow(windowTitle);
        if (root == null) throw new Exception("window not found");
        StringBuilder b = new StringBuilder();
        int n = 0;
        Walk(root, 0, maxDepth, maxNodes, b, ref n);
        return "{\"nodes\":" + n + ",\"tree\":\"" + Esc(b.ToString()) + "\"}";
    }

    static void Walk(AutomationElement e, int depth, int maxDepth, int maxNodes, StringBuilder b, ref int n) {
        if (n >= maxNodes || depth > maxDepth) return;
        n++;
        for (int i = 0; i < depth; i++) b.Append("  ");
        ControlType t = e.Current.ControlType;
        string label = t == null ? "?" : t.ProgrammaticName.Replace("ControlType.", "");
        b.Append(label);
        string nm = SafeName(e);
        if (nm.Length > 0) b.Append(" \"").Append(nm).Append("\"");
        string aid = e.Current.AutomationId;
        if (!string.IsNullOrEmpty(aid)) b.Append(" #").Append(aid);
        b.Append("\n");
        AutomationElementCollection kids;
        try { kids = e.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { return; }
        foreach (AutomationElement k in kids) Walk(k, depth + 1, maxDepth, maxNodes, b, ref n);
    }

    // ---------------- launch ----------------
    // UseShellExecute=true so app aliases ("calc.exe"), documents and URLs all
    // work the same way the Run dialog would. Optionally wait for a window
    // whose title matches, using the UIA tree rather than polling pixels.
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    const uint GA_ROOT = 2;

    /// Which window owns a screen point? Used by the policy layer to decide
    /// whether a click is allowed before it happens.
    public static string WindowAt(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return "{\"found\":false}";
        IntPtr root = GetAncestor(h, GA_ROOT);
        if (root != IntPtr.Zero) h = root;
        uint pid; GetWindowThreadProcessId(h, out pid);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        StringBuilder t = new StringBuilder(512);
        GetWindowText(h, t, 512);
        return "{\"found\":true,\"handle\":" + h.ToInt64() + ",\"pid\":" + pid +
               ",\"process\":\"" + Esc(name) + "\",\"title\":\"" + Esc(t.ToString()) + "\"}";
    }

    public static string LaunchApp(string target, string args, string windowTitle, int waitMs) {
        ProcessStartInfo psi = new ProcessStartInfo(target);
        if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
        psi.UseShellExecute = true;
        Process.Start(psi);
        if (!string.IsNullOrEmpty(windowTitle) && waitMs > 0) {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < waitMs) {
                AutomationElement w = TopWindow(windowTitle);
                if (w != null) {
                    return "{\"launched\":true,\"windowFound\":true,\"title\":\"" +
                           Esc(SafeName(w)) + "\",\"waitedMs\":" +
                           (int)sw.ElapsedMilliseconds + "}";
                }
                System.Threading.Thread.Sleep(150);
            }
            return "{\"launched\":true,\"windowFound\":false,\"waitedMs\":" + waitMs + "}";
        }
        return "{\"launched\":true}";
    }

    // ---------------- helpers ----------------
    static string Esc(string s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder();
        foreach (char c in s) {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n");
            else if (c == '\r') b.Append("\\r");
            else if (c == '\t') b.Append("\\t");
            else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.ToString();
    }
}
'@

# ---- main loop ----
# Shot() returns newline-delimited fields; PS 5.1's ConvertFrom-Json cannot
# handle the several-hundred-KB base64 payload, so parse by hand.
function Convert-Shot($raw) {
    $f = $raw -split "`n"
    return @{
        data = $f[0]; mime = $f[1]
        width = [int]$f[2]; height = [int]$f[3]
        capturedWidth = [int]$f[4]; capturedHeight = [int]$f[5]
        bytes = [int]$f[6]
        ms = @{ capture = [double]$f[7]; scale = [double]$f[8]
                encode = [double]$f[9]; base64 = [double]$f[10] }
    }
}

$stdout = [Console]::Out
$running = $true
while ($running) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $id = -1
    $op = ''
    $resp = $null
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $req  = $json | ConvertFrom-Json
        $id   = $req.id
        $op   = [string]$req.op
        $a    = $req.args

        $result = switch ($op) {
            'ping'           { @{ pong = $true; pid = $PID } }
            'screen_size'    { [Dsh]::ScreenSize() | ConvertFrom-Json }
            'list_displays'  { [Dsh]::Displays() | ConvertFrom-Json }

            'screenshot' {
                $maxSide = if ($null -ne $a.max_side) { [int]$a.max_side } else { 1600 }
                $fmt     = if ($null -ne $a.format)   { [string]$a.format } else { 'jpeg' }
                $q       = if ($null -ne $a.quality)  { [int]$a.quality } else { 88 }
                $ip      = if ($null -ne $a.interp)   { [string]$a.interp } else { 'bilinear' }
                if ($null -ne $a.x) {
                    $raw = [Dsh]::Shot([int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height, $maxSide, $fmt, $q, $ip)
                } else {
                    $ss = [Dsh]::ScreenSize() | ConvertFrom-Json
                    $raw = [Dsh]::Shot($ss.x, $ss.y, $ss.width, $ss.height, $maxSide, $fmt, $q, $ip)
                }
                $f = $raw -split "`n"
                @{
                    data = $f[0]; mime = $f[1]
                    width = [int]$f[2]; height = [int]$f[3]
                    capturedWidth = [int]$f[4]; capturedHeight = [int]$f[5]
                    bytes = [int]$f[6]
                    ms = @{ capture = [double]$f[7]; scale = [double]$f[8]
                            encode = [double]$f[9]; base64 = [double]$f[10] }
                }
            }

            'fingerprint' {
                if ($null -ne $a.x) {
                    @{ hash = [Dsh]::Fingerprint([int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height) }
                } else {
                    $ss = [Dsh]::ScreenSize() | ConvertFrom-Json
                    @{ hash = [Dsh]::Fingerprint($ss.x, $ss.y, $ss.width, $ss.height) }
                }
            }

            'wait_for_change' {
                $timeout  = if ($null -ne $a.timeout_ms)  { [int]$a.timeout_ms }  else { 10000 }
                $interval = if ($null -ne $a.interval_ms) { [int]$a.interval_ms } else { 120 }
                if ($null -ne $a.x) {
                    $rx = [int]$a.x; $ry = [int]$a.y; $rw = [int]$a.width; $rh = [int]$a.height
                } else {
                    $ss = [Dsh]::ScreenSize() | ConvertFrom-Json
                    $rx = $ss.x; $ry = $ss.y; $rw = $ss.width; $rh = $ss.height
                }
                $base = [Dsh]::Fingerprint($rx, $ry, $rw, $rh)
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $changed = $false
                while ($sw.Elapsed.TotalMilliseconds -lt $timeout) {
                    Start-Sleep -Milliseconds $interval
                    if ([Dsh]::Fingerprint($rx, $ry, $rw, $rh) -ne $base) { $changed = $true; break }
                }
                @{ changed = $changed; elapsed_ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); baseline = $base }
            }

            'bench' {
                $ss = [Dsh]::ScreenSize() | ConvertFrom-Json
                $variants = @(
                    @{ name = 'png_bicubic_1600';  fmt = 'png';  ms = 1600; ip = 'bicubic'; q = 88 },
                    @{ name = 'png_bilinear_1600'; fmt = 'png';  ms = 1600; ip = 'bilinear'; q = 88 },
                    @{ name = 'png_nearest_1600';  fmt = 'png';  ms = 1600; ip = 'nearest'; q = 88 },
                    @{ name = 'jpeg88_bilinear_1600'; fmt = 'jpeg'; ms = 1600; ip = 'bilinear'; q = 88 },
                    @{ name = 'jpeg75_bilinear_1600'; fmt = 'jpeg'; ms = 1600; ip = 'bilinear'; q = 75 },
                    @{ name = 'jpeg88_bilinear_1280'; fmt = 'jpeg'; ms = 1280; ip = 'bilinear'; q = 88 },
                    @{ name = 'png_native';  fmt = 'png';  ms = 0; ip = 'bilinear'; q = 88 },
                    @{ name = 'jpeg88_native'; fmt = 'jpeg'; ms = 0; ip = 'bilinear'; q = 88 }
                )
                $rows = @()
                foreach ($v in $variants) {
                    try {
                        $t = [System.Diagnostics.Stopwatch]::StartNew()
                        $r = Convert-Shot ([Dsh]::Shot($ss.x, $ss.y, $ss.width, $ss.height, $v.ms, $v.fmt, $v.q, $v.ip))
                        $t.Stop()
                        $rows += @{
                            name = $v.name
                            total_ms = [math]::Round($t.Elapsed.TotalMilliseconds, 1)
                            capture = $r.ms.capture; scale = $r.ms.scale
                            encode = $r.ms.encode; base64 = $r.ms.base64
                            bytes = $r.bytes; size = "$($r.width)x$($r.height)"
                        }
                    } catch {
                        $rows += @{ name = $v.name; total_ms = -1; size = 'FAILED'; bytes = 0
                                    capture = 0; scale = 0; encode = 0; base64 = 0
                                    err = $_.Exception.Message }
                    }
                }
                $fp = [System.Diagnostics.Stopwatch]::StartNew()
                $h1 = [Dsh]::Fingerprint($ss.x, $ss.y, $ss.width, $ss.height)
                $fp.Stop()
                $rows += @{ name = 'fingerprint_only'; total_ms = [math]::Round($fp.Elapsed.TotalMilliseconds, 1); bytes = $h1.Length }
                $rows
            }

            'cursor_position' { [Dsh]::CursorPos() | ConvertFrom-Json }
            'mouse_move'      { [Dsh]::MoveTo([int]$a.x, [int]$a.y); @{ ok = $true } }

            'click' {
                $btn = if ($null -ne $a.button) { [string]$a.button } else { 'left' }
                $cnt = if ($null -ne $a.count)  { [int]$a.count }     else { 1 }
                if ($null -ne $a.x) {
                    [Dsh]::Click([int]$a.x, [int]$a.y, $btn, $cnt)
                } else {
                    $cp = [Dsh]::CursorPos() | ConvertFrom-Json
                    [Dsh]::Click($cp.x, $cp.y, $btn, $cnt)
                }
                @{ ok = $true }
            }

            'drag' {
                $btn = if ($null -ne $a.button) { [string]$a.button } else { 'left' }
                $st  = if ($null -ne $a.steps)  { [int]$a.steps }     else { 24 }
                [Dsh]::Drag([int]$a.x1, [int]$a.y1, [int]$a.x2, [int]$a.y2, $btn, $st)
                @{ ok = $true }
            }

            'scroll' {
                $n   = if ($null -ne $a.amount) { [int]$a.amount } else { 3 }
                $dir = if ($null -ne $a.direction) { [string]$a.direction } else { 'down' }
                if ($null -ne $a.x) { [Dsh]::MoveTo([int]$a.x, [int]$a.y) }
                $notches = if ($dir -eq 'up') { $n } else { -$n }
                [Dsh]::Scroll($notches)
                @{ ok = $true; notches = $notches }
            }

            'type_text' { [Dsh]::TypeText([string]$a.text); @{ ok = $true; chars = ([string]$a.text).Length } }
            'key'       { [Dsh]::KeyCombo([string]$a.combo); @{ ok = $true } }
            'hold_key'  { [Dsh]::HoldKey([string]$a.key, [int]$a.ms); @{ ok = $true } }

            'list_windows'  { [Dsh]::ListWindows() | ConvertFrom-Json }
            'active_window' { [Dsh]::ActiveWindow() | ConvertFrom-Json }
            'window_at'     { [Dsh]::WindowAt([int]$a.x, [int]$a.y) | ConvertFrom-Json }

            'activate_window' {
                $t = if ($null -ne $a.title) { [string]$a.title } else { $null }
                $p = if ($null -ne $a.pid)   { [int]$a.pid }      else { 0 }
                [Dsh]::ActivateWindow($t, $p) | ConvertFrom-Json
            }

            'clipboard_read'  { @{ text = [Dsh]::ReadClipboard() } }
            'clipboard_write' { [Dsh]::WriteClipboard([string]$a.text); @{ ok = $true } }

            'find_elements' {
                $max = if ($null -ne $a.max) { [int]$a.max } else { 25 }
                [Dsh]::FindElements([string]$a.name, [string]$a.control_type, [string]$a.automation_id,
                                    [string]$a.class_name, [string]$a.window, $max) | ConvertFrom-Json
            }

            'click_element' {
                $idx = if ($null -ne $a.index) { [int]$a.index } else { 0 }
                [Dsh]::ClickElement([string]$a.name, [string]$a.control_type, [string]$a.automation_id,
                                    [string]$a.class_name, [string]$a.window, $idx) | ConvertFrom-Json
            }

            'ui_tree' {
                $depth = if ($null -ne $a.depth) { [int]$a.depth } else { 4 }
                $nodes = if ($null -ne $a.max_nodes) { [int]$a.max_nodes } else { 400 }
                [Dsh]::UiTree([string]$a.window, $depth, $nodes) | ConvertFrom-Json
            }

            'launch_app' {
                $wt = if ($null -ne $a.window) { [string]$a.window } else { '' }
                $wm = if ($null -ne $a.wait_ms) { [int]$a.wait_ms } else { 0 }
                [Dsh]::LaunchApp([string]$a.target, [string]$a.arguments, $wt, $wm) | ConvertFrom-Json
            }

            'save_png' {
                $p = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'dsh-shot-' + [guid]::NewGuid().ToString('N') + '.png')
                if ($null -ne $a.x) {
                    [Dsh]::SavePng([int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height, $p) | ConvertFrom-Json
                } else {
                    $ss = [Dsh]::ScreenSize() | ConvertFrom-Json
                    [Dsh]::SavePng($ss.x, $ss.y, $ss.width, $ss.height, $p) | ConvertFrom-Json
                }
            }

            'wait'     { Start-Sleep -Milliseconds ([int]$a.ms); @{ ok = $true } }
            'shutdown' { @{ ok = $true }; $running = $false }

            default { throw "unknown op: $op" }
        }
        $resp = @{ id = $id; ok = $true; result = $result }
    }
    catch {
        $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }

    $out = $resp | ConvertTo-Json -Compress -Depth 12
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($out))
    $stdout.WriteLine($b64)
    $stdout.Flush()
}
