// Runs before first paint (loaded synchronously from index.html) so the saved theme and accent
// color are applied without a flash. Keep storage keys and resolution rules in sync with
// src/shared/lib/theme.ts and src/shared/lib/accent-color.ts.
(function () {
  var pref = "dark";
  var accent = null;
  try {
    var saved = window.localStorage.getItem("ai-usage-tracker:theme");
    if (saved === "dark" || saved === "oled" || saved === "light" || saved === "system") pref = saved;
    var savedAccent = window.localStorage.getItem("ai-usage-tracker:accent-color");
    if (savedAccent && /^#[0-9a-f]{6}$/.test(savedAccent) && savedAccent !== "#6d3bd7") accent = savedAccent;
  } catch (e) {}
  var light =
    pref === "light" ||
    (pref === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.setAttribute("data-theme", light ? "light" : pref === "oled" ? "oled" : "dark");

  if (!accent) return;

  function clampByte(n) {
    return Math.max(0, Math.min(255, Math.round(n)));
  }
  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (v) {
          var s = clampByte(v).toString(16);
          return s.length < 2 ? "0" + s : s;
        })
        .join("")
    );
  }
  function rgbTriplet(rgb) {
    return clampByte(rgb[0]) + " " + clampByte(rgb[1]) + " " + clampByte(rgb[2]);
  }
  function rgbToHsl(rgb) {
    var r = rgb[0] / 255,
      g = rgb[1] / 255,
      b = rgb[2] / 255;
    var max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb(h, s, l) {
    var hn = ((h % 360) + 360) % 360;
    var sc = Math.max(0, Math.min(1, s));
    var lc = Math.max(0, Math.min(1, l));
    var c = (1 - Math.abs(2 * lc - 1)) * sc;
    var x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    var m = lc - c / 2;
    var r = 0,
      g = 0,
      b = 0;
    if (hn < 60) { r = c; g = x; }
    else if (hn < 120) { r = x; g = c; }
    else if (hn < 180) { g = c; b = x; }
    else if (hn < 240) { g = x; b = c; }
    else if (hn < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
  }
  function lum(rgb) {
    var ch = function (v) {
      var n = v / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
  }
  function contrast(a, b) {
    var la = lum(a),
      lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function onFill(rgb, h, s) {
    var lt = hslToRgb(h, Math.min(s, 0.3), 0.99);
    var dk = hslToRgb(h, Math.min(s, 0.35), 0.05);
    return contrast(rgb, lt) >= contrast(rgb, dk) ? rgbToHex(lt) : rgbToHex(dk);
  }
  function ensureContrast(h, s, startL, bg, minRatio, dir) {
    var l = Math.max(0.05, Math.min(0.96, startL));
    var rgb = hslToRgb(h, s, l);
    for (var i = 0; i < 30 && contrast(rgb, bg) < minRatio; i++) {
      l = Math.max(0.05, Math.min(0.96, l + dir * 0.03));
      rgb = hslToRgb(h, s, l);
    }
    return rgb;
  }

  var fillRgb = [
    parseInt(accent.slice(1, 3), 16),
    parseInt(accent.slice(3, 5), 16),
    parseInt(accent.slice(5, 7), 16),
  ];
  var hsl = rgbToHsl(fillRgb);
  var h = hsl[0],
    s = hsl[1],
    l = hsl[2];
  var hoverRgb = hslToRgb(h, Math.min(1, s * 1.02), Math.max(0.12, Math.min(0.92, l + (l > 0.62 ? -0.08 : 0.08))));
  var lineRgb = hslToRgb(h, Math.min(1, s * 0.96), Math.max(0.18, Math.min(0.95, l + (l > 0.62 ? -0.15 : 0.16))));
  var st = document.documentElement.style;
  st.setProperty("--purple-fill", accent);
  st.setProperty("--purple-fill-hover", rgbToHex(hoverRgb));
  st.setProperty("--purple-fill-line", rgbToHex(lineRgb));
  st.setProperty("--purple-fill-rgb", rgbTriplet(fillRgb));
  st.setProperty("--purple-on-fill", onFill(fillRgb, h, s));

  if (light) {
    var bgL = [255, 255, 255];
    var satL = s > 0.08 ? Math.max(s, 0.58) : s;
    var accL = ensureContrast(h, satL, Math.min(l, 0.48), bgL, 4.5, -1);
    var surfL = hslToRgb(h, Math.min(s, 0.52), 0.94);
    var surfActL = hslToRgb(h, Math.min(s, 0.56), 0.89);
    var txtL = ensureContrast(h, satL, Math.min(l, 0.44), surfL, 4.5, -1);
    st.setProperty("--purple-accent", rgbToHex(accL));
    st.setProperty("--purple-accent-rgb", rgbTriplet(accL));
    st.setProperty("--purple-text", rgbToHex(txtL));
    st.setProperty("--purple-text-rgb", rgbTriplet(txtL));
    st.setProperty("--purple-on-text", onFill(txtL, h, s));
    st.setProperty("--purple-ink", rgbToHex(ensureContrast(h, Math.min(s, 0.65), 0.28, bgL, 7, -1)));
    st.setProperty("--purple-chip", rgbToHex(ensureContrast(h, Math.min(s, 0.65), 0.3, bgL, 6.5, -1)));
    st.setProperty("--purple-chip-active", rgbToHex(ensureContrast(h, Math.min(s, 0.68), 0.26, bgL, 7, -1)));
    st.setProperty("--purple-surface", rgbToHex(surfL));
    st.setProperty("--purple-surface-active", rgbToHex(surfActL));
  } else {
    var bgD = [28, 27, 27];
    var satD = s > 0.08 ? Math.min(1, Math.max(s, 0.65)) : s;
    var surfD = hslToRgb(h, Math.min(s, 0.28), 0.18);
    var surfActD = hslToRgb(h, Math.min(s, 0.36), 0.23);
    var accD = ensureContrast(h, satD, Math.max(l, 0.68), bgD, 4.5, 1);
    var txtD = ensureContrast(h, Math.min(s, 0.85), 0.84, surfD, 7, 1);
    st.setProperty("--purple-accent", rgbToHex(accD));
    st.setProperty("--purple-accent-rgb", rgbTriplet(accD));
    st.setProperty("--purple-text", rgbToHex(txtD));
    st.setProperty("--purple-text-rgb", rgbTriplet(txtD));
    st.setProperty("--purple-on-text", onFill(txtD, h, s));
    st.setProperty("--purple-ink", rgbToHex(hslToRgb(h, Math.min(s, 0.45), 0.97)));
    st.setProperty("--purple-chip", rgbToHex(hslToRgb(h, Math.min(s, 0.85), 0.89)));
    st.setProperty("--purple-chip-active", rgbToHex(hslToRgb(h, Math.min(s, 0.85), 0.81)));
    st.setProperty("--purple-surface", rgbToHex(surfD));
    st.setProperty("--purple-surface-active", rgbToHex(surfActD));
  }
})();
