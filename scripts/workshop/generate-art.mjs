// Generates pz-mod/workshop/art/bridge.svg (the 512/256 "emergency broadcast
// console" art) and pz-mod/workshop/art/bridge-icon.svg (the 32 px mod-list
// icon). Edit the art here, then run `npm run workshop:art`, which regenerates
// both SVGs and renders them to the committed PNGs.
// Procedural bits (scratches, grille, knurling, marker lettering, torn tape)
// come from a seeded RNG so the output is stable between runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pz-mod", "workshop", "art");

let seed = 20260928;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const rr = (a, b) => a + (b - a) * rnd();
const f = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- palette
const C = {
  wallA: "#1c1b16",
  wallB: "#0b0b09",
  olive1: "#5b5d42",
  olive2: "#464830",
  olive3: "#343627",
  face1: "#4d4f37",
  face2: "#3a3c2b",
  bezel: "#121310",
  metal: "#a9a693",
  phos: "#7dff5e",
  phosCore: "#e6ffd9",
  glass1: "#1d5419",
  glass2: "#0a2509",
  glass3: "#030c03",
  led: "#ff2a14",
  blood1: "#5a0806",
  blood2: "#8e160e",
  tape1: "#c9c8bf",
  tape2: "#9f9e95",
  ink: "#141414",
  paint: "#d6d0b4",
};

// ---------------------------------------------------------------- geometry
const BODY = { x: 30, y: 112, w: 452, h: 328, rx: 22 };
const FACE = { x: 46, y: 128, w: 420, h: 296, rx: 12 };
const HOUSING = { x: 62, y: 144, w: 274, h: 192, rx: 18 };
const GLASS = { x: 76, y: 158, w: 246, h: 164, rx: 26 };
const GCX = GLASS.x + GLASS.w / 2;
const GCY = GLASS.y + GLASS.h / 2;
const BASE = GCY + 6; // trace baseline
const KNOB = { cx: 402, cy: 264, r: 38 };
const LED = { cx: 374, cy: 176 };
const TOGGLE = { cx: 430, cy: 176 };

// ---------------------------------------------------------------- scratches
function scratches() {
  let out = "";
  for (let i = 0; i < 140; i++) {
    const x = rr(BODY.x + 6, BODY.x + BODY.w - 6);
    const y = rr(BODY.y + 6, BODY.y + BODY.h - 6);
    const len = rnd() < 0.85 ? rr(4, 22) : rr(24, 60);
    const a = (rnd() < 0.7 ? rr(-18, 18) : rr(-80, 80)) * (Math.PI / 180);
    const x2 = x + Math.cos(a) * len;
    const y2 = y + Math.sin(a) * len;
    const light = rnd() < 0.8;
    out += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${light ? "#c9c5ae" : "#15150f"}" stroke-width="${f(rr(0.5, 1.2))}" opacity="${f(light ? rr(0.08, 0.3) : rr(0.2, 0.45))}"/>`;
  }
  return out;
}

// ---------------------------------------------------------------- grille
function grille() {
  const x0 = 64, x1 = 336, y0 = 350, y1 = 412;
  let out = "";
  const step = 10.5;
  let row = 0;
  for (let y = y0 + 5; y <= y1 - 4; y += step * 0.866, row++) {
    for (let x = x0 + 6 + (row % 2 ? step / 2 : 0); x <= x1 - 5; x += step) {
      out += `<circle cx="${f(x)}" cy="${f(y)}" r="3.1"/>`;
    }
  }
  return `<rect x="${x0 - 4}" y="${y0 - 4}" width="${x1 - x0 + 8}" height="${y1 - y0 + 8}" rx="8" fill="#1d1f19"/>
  <rect x="${x0 - 4}" y="${y0 - 4}" width="${x1 - x0 + 8}" height="${y1 - y0 + 8}" rx="8" fill="none" stroke="#0c0d0a" stroke-width="2"/>
  <rect x="${x0 - 4}" y="${y0 - 3}" width="${x1 - x0 + 8}" height="${y1 - y0 + 8}" rx="8" fill="none" stroke="#5b5d4c" stroke-width="1" opacity=".35"/>
  <g fill="#6b6c5a" opacity=".55" transform="translate(0 1)">${out}</g>
  <g fill="#070806">${out}</g>`;
}

// ---------------------------------------------------------------- screws
function screw(cx, cy, r = 6, rot = rr(0, 180)) {
  return `<g transform="translate(${cx} ${cy})">
    <circle r="${r + 1.5}" fill="#15160f" opacity=".7"/>
    <circle r="${r}" fill="url(#gScrew)"/>
    <g transform="rotate(${f(rot)})"><rect x="${-r + 1}" y="-1" width="${2 * r - 2}" height="2" fill="#1b1b16"/></g>
  </g>`;
}

// ---------------------------------------------------------------- knob
function knob() {
  const { cx, cy, r } = KNOB;
  let ticks = "";
  for (let i = 0; i <= 10; i++) {
    const a = ((-135 + i * 27) * Math.PI) / 180;
    const r1 = r + 8, r2 = r + (i % 5 === 0 ? 17 : 13);
    ticks += `<line x1="${f(cx + Math.sin(a) * r1)}" y1="${f(cy - Math.cos(a) * r1)}" x2="${f(cx + Math.sin(a) * r2)}" y2="${f(cy - Math.cos(a) * r2)}"/>`;
  }
  let knurl = "";
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    knurl += `<line x1="${f(cx + Math.cos(a) * (r - 6))}" y1="${f(cy + Math.sin(a) * (r - 6))}" x2="${f(cx + Math.cos(a) * r)}" y2="${f(cy + Math.sin(a) * r)}"/>`;
  }
  const ind = (-40 * Math.PI) / 180;
  return `<g>
    <g stroke="${C.paint}" stroke-width="2.4" stroke-linecap="round" opacity=".7">${ticks}</g>
    <circle cx="${cx}" cy="${cy + 5}" r="${r + 3}" fill="#000" opacity=".45" filter="url(#fSoft)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#161612"/>
    <g stroke="#4a4a40" stroke-width="2">${knurl}</g>
    <circle cx="${cx}" cy="${cy}" r="${r - 7}" fill="url(#gKnobCap)"/>
    <circle cx="${cx}" cy="${cy}" r="${r - 7}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="1.5"/>
    <path d="M${cx - 22} ${cy - 16} A${r - 9} ${r - 9} 0 0 1 ${cx + 12} ${cy - 27}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="3" stroke-linecap="round"/>
    <line x1="${f(cx + Math.sin(ind) * 8)}" y1="${f(cy - Math.cos(ind) * 8)}" x2="${f(cx + Math.sin(ind) * (r - 11))}" y2="${f(cy - Math.cos(ind) * (r - 11))}" stroke="${C.paint}" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

// ---------------------------------------------------------------- toggle
function toggle() {
  const { cx, cy } = TOGGLE;
  return `<g>
    <rect x="${cx - 17}" y="${cy - 24}" width="34" height="48" rx="5" fill="#1a1b16" stroke="#0a0a08" stroke-width="1.5"/>
    <rect x="${cx - 16}" y="${cy - 23}" width="32" height="46" rx="4.5" fill="none" stroke="#5c5d4d" stroke-opacity=".35" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="10" fill="url(#gChrome)" stroke="#0c0c0a" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="4.5" fill="#0d0d0b"/>
    <path d="M${cx - 3.2} ${cy} L${cx - 5.5} ${cy - 25} A5.5 5.5 0 0 1 ${cx + 5.5} ${cy - 25} L${cx + 3.2} ${cy} Z" fill="url(#gChromeBat)" stroke="#0c0c0a" stroke-width="1"/>
    <ellipse cx="${cx}" cy="${cy - 25.5}" rx="5.5" ry="4" fill="#e9e6d8"/>
  </g>`;
}

// ---------------------------------------------------------------- LED
function led() {
  const { cx, cy } = LED;
  return `<g>
    <circle cx="${cx}" cy="${cy}" r="34" fill="url(#gLedGlow)"/>
    <circle cx="${cx}" cy="${cy}" r="13" fill="url(#gChrome)" stroke="#0a0a08" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="9" fill="#2a0202"/>
    <circle cx="${cx}" cy="${cy}" r="8" fill="url(#gLed)"/>
    <ellipse cx="${cx - 2.6}" cy="${cy - 3}" rx="3" ry="2" fill="#fff" opacity=".85"/>
  </g>`;
}

// ---------------------------------------------------------------- screen
function dotText(str, x, y, d) {
  const F = {
    L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
    K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  };
  let out = "";
  let cx = x;
  for (const ch of str) {
    const g = F[ch];
    g.forEach((row, j) => {
      [...row].forEach((b, i) => {
        if (b === "1") out += `<rect x="${f(cx + i * d)}" y="${f(y + j * d)}" width="${f(d * 0.8)}" height="${f(d * 0.8)}"/>`;
      });
    });
    cx += 6 * d;
  }
  return out;
}

// ECG-like "link heartbeat": flat, P bump, QRS spike, T bump, sweep head.
const HEAD_X = GLASS.x + GLASS.w - 34;
const TRACE = [
  `M${GLASS.x + 4} ${BASE}`,
  `H${GCX - 58}`,
  `Q${GCX - 49} ${BASE - 13} ${GCX - 40} ${BASE}`,
  `H${GCX - 24}`,
  `L${GCX - 17} ${BASE + 9}`,
  `L${GCX - 6} ${BASE - 70}`,
  `L${GCX + 7} ${BASE + 44}`,
  `L${GCX + 16} ${BASE}`,
  `H${GCX + 30}`,
  `Q${GCX + 44} ${BASE - 22} ${GCX + 58} ${BASE}`,
  `H${HEAD_X}`,
].join(" ");

function screen() {
  const { x, y, w, h, rx } = GLASS;
  let grid = "";
  for (let i = 1; i < 10; i++) grid += `<line x1="${f(x + (w * i) / 10)}" y1="${y}" x2="${f(x + (w * i) / 10)}" y2="${y + h}"/>`;
  for (let j = 1; j < 7; j++) grid += `<line x1="${x}" y1="${f(y + (h * j) / 7)}" x2="${x + w}" y2="${f(y + (h * j) / 7)}"/>`;
  let minor = "";
  for (let i = 1; i < 50; i++) minor += `<line x1="${f(x + (w * i) / 50)}" y1="${BASE - 2}" x2="${f(x + (w * i) / 50)}" y2="${BASE + 2}"/>`;
  // signal bars, top right
  let bars = "";
  for (let i = 0; i < 4; i++) bars += `<rect x="${x + w - 52 + i * 8}" y="${y + 30 - (i + 1) * 4.5}" width="5" height="${(i + 1) * 4.5}"/>`;

  const H = HOUSING;
  return `
  <!-- housing -->
  <rect x="${H.x}" y="${H.y + 2}" width="${H.w}" height="${H.h}" rx="${H.rx}" fill="#6a6b58" opacity=".35"/>
  <rect x="${H.x}" y="${H.y}" width="${H.w}" height="${H.h}" rx="${H.rx}" fill="url(#gHousing)"/>
  <rect x="${H.x + 0.75}" y="${H.y + 0.75}" width="${H.w - 1.5}" height="${H.h - 1.5}" rx="${H.rx}" fill="none" stroke="#000" stroke-opacity=".6" stroke-width="1.5"/>
  <!-- phosphor spill on the faceplate and bezel -->
  <rect x="${H.x - 10}" y="${H.y - 6}" width="${H.w + 20}" height="${H.h + 18}" rx="${H.rx + 8}" fill="${C.phos}" opacity=".07" filter="url(#fBloom)"/>
  <rect x="${x - 8}" y="${y - 8}" width="${w + 16}" height="${h + 16}" rx="${rx + 6}" fill="${C.phos}" opacity=".16" filter="url(#fBloom)"/>
  <g clip-path="url(#cpGlass)">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#gGlass)"/>
    <g stroke="${C.phos}" stroke-width="1" opacity=".13">${grid}</g>
    <g stroke="${C.phos}" stroke-width="1" opacity=".22">${minor}</g>
    <line x1="${GCX}" y1="${y}" x2="${GCX}" y2="${y + h}" stroke="${C.phos}" stroke-width="1" opacity=".1"/>
    <g fill="${C.phos}" opacity=".62" filter="url(#fGlowS)">
      ${dotText("LINK OK", x + 22, y + 16, 2.1)}
      ${bars}
    </g>
    <!-- trace: wide glow, mid glow, core -->
    <path d="${TRACE}" fill="none" stroke="url(#gTraceGlow)" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" opacity=".55" filter="url(#fBlur6)"/>
    <path d="${TRACE}" fill="none" stroke="url(#gTrace)" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round" filter="url(#fBlur1)"/>
    <path d="${TRACE}" fill="none" stroke="url(#gTraceCore)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${HEAD_X}" cy="${BASE}" r="10" fill="${C.phos}" opacity=".6" filter="url(#fBlur6)"/>
    <circle cx="${HEAD_X}" cy="${BASE}" r="3.4" fill="${C.phosCore}"/>
    <!-- scanlines, vignette, glass sheen -->
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#pScan)"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#gGlassVig)"/>
    <path d="M${x + 12} ${y + 58} Q${x + 12} ${y + 12} ${x + 66} ${y + 9}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".13"/>
    <ellipse cx="${x + 70}" cy="${y + 36}" rx="80" ry="40" fill="url(#gSheen)"/>
  </g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="none" stroke="#000" stroke-opacity=".8" stroke-width="3"/>
  <rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" rx="${rx + 2}" fill="none" stroke="#6f705e" stroke-opacity=".25" stroke-width="1"/>`;
}

// ---------------------------------------------------------------- tape + marker
const GLYPHS = {
  P: { w: 0.6, s: ["M0 1 L0 0 L0.5 0 C1 0 1 0.52 0.5 0.52 L0 0.52"] },
  A: { w: 0.72, s: ["M0 1 L0.5 0 L1 1", "M0.2 0.64 L0.8 0.64"] },
  N: { w: 0.66, s: ["M0 1 L0 0 L1 1 L1 0"] },
  E: { w: 0.54, s: ["M1 0 L0 0 L0 1 L1 1", "M0 0.5 L0.8 0.5"] },
  L: { w: 0.52, s: ["M0 0 L0 1 L1 1"] },
  B: { w: 0.6, s: ["M0 1 L0 0 L0.5 0 C0.95 0 0.95 0.47 0.5 0.47 L0 0.47", "M0.45 0.47 C1.05 0.47 1.05 1 0.5 1 L0 1"] },
  R: { w: 0.62, s: ["M0 1 L0 0 L0.5 0 C1 0 1 0.52 0.5 0.52 L0 0.52", "M0.42 0.52 L1 1"] },
  I: { w: 0.34, s: ["M0.5 0 L0.5 1", "M0 0 L1 0", "M0 1 L1 1"] },
  D: { w: 0.64, s: ["M0 0 L0 1 L0.38 1 C1.05 1 1.05 0 0.38 0 Z"] },
  G: { w: 0.68, s: ["M0.97 0.18 C0.84 0.02 0.7 0 0.52 0 C0.08 0 0 0.3 0 0.5 C0 0.78 0.12 1 0.52 1 C0.86 1 1 0.84 1 0.56 L0.56 0.56"] },
  " ": { w: 0.3, s: [] },
};

function markerText(text, H, sw) {
  const gap = 0.3 * H;
  const widths = [...text].map((ch) => GLYPHS[ch].w * H);
  const total = widths.reduce((a, b) => a + b, 0) + gap * (text.length - 1);
  let x = -total / 2;
  let out = "";
  [...text].forEach((ch, idx) => {
    const g = GLYPHS[ch];
    const W = widths[idx];
    const dy = rr(-1.2, 1.2);
    const rot = rr(-3, 3);
    const paths = g.s.map((s) =>
      s.replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, a, b) => `${f(+a * W + rr(-0.7, 0.7))} ${f(+b * H + rr(-0.7, 0.7))}`),
    );
    if (paths.length)
      out += `<g transform="translate(${f(x)} ${f(-H / 2 + dy)}) rotate(${f(rot)} ${f(W / 2)} ${f(H / 2)})">${paths
        .map((d) => `<path d="${d}"/>`)
        .join("")}</g>`;
    x += W + gap;
  });
  return `<g fill="none" stroke="${C.ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${out}</g>`;
}

function tapePath(L, T) {
  const pts = [];
  const hx = L / 2, hy = T / 2;
  // top edge, left to right (slightly wavy)
  pts.push([-hx + rr(0, 4), -hy]);
  pts.push([hx - rr(0, 4), -hy + rr(-0.6, 0.6)]);
  // right torn end, top to bottom
  for (let i = 1; i < 9; i++) pts.push([hx + (i % 2 ? rr(2, 6) : rr(-3, 0)), -hy + (T * i) / 9]);
  pts.push([hx - rr(0, 3), hy]);
  pts.push([-hx + rr(0, 3), hy + rr(-0.6, 0.6)]);
  for (let i = 8; i > 0; i--) pts.push([-hx - (i % 2 ? rr(2, 6) : rr(-3, 0)), -hy + (T * i) / 9]);
  return "M" + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L") + " Z";
}

function tape() {
  const L = 336, T = 52;
  const d = tapePath(L, T);
  let wr = "";
  for (let i = 0; i < 7; i++) {
    const y = rr(-T / 2 + 4, T / 2 - 4);
    const x1 = rr(-L / 2, 0), x2 = x1 + rr(60, 180);
    wr += `<path d="M${f(x1)} ${f(y)} Q${f((x1 + x2) / 2)} ${f(y + rr(-3, 3))} ${f(x2)} ${f(y + rr(-2, 2))}" stroke="${rnd() < 0.5 ? "#fff" : "#000"}" stroke-opacity="${f(rr(0.06, 0.14))}" stroke-width="${f(rr(1, 2.4))}" fill="none"/>`;
  }
  return `<g transform="translate(196 381) rotate(-3.5)">
    <path d="${d}" fill="#000" opacity=".55" transform="translate(1.5 3)" filter="url(#fSoft)"/>
    <path d="${d}" fill="url(#gTape)"/>
    <g clip-path="url(#cpTape)">
      <rect x="${-L / 2 - 10}" y="${-T / 2 - 2}" width="${L + 20}" height="${T + 4}" fill="url(#pScrim)"/>
      ${wr}
      <rect x="${-L / 2 - 10}" y="${-T / 2 - 2}" width="${L + 20}" height="${T + 4}" fill="#3a2d1a" opacity=".5" filter="url(#fDirt)"/>
    </g>
    <path d="${d}" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="1"/>
    <g filter="url(#fInk)" opacity=".92">${markerText("PANEL BRIDGE", 28, 4.6)}</g>
  </g>
  <clipPath id="cpTape"><path d="${d}"/></clipPath>`;
}

// ---------------------------------------------------------------- blood hand
function hand() {
  // Right hand, palm pressed flat, fingers up (thumb on the viewer's left).
  // Local coords: palm centre at origin. A print is pads, not a silhouette:
  // finger segments with crease gaps, the pad band under the fingers, the
  // thumb mound and outer heel, and a faint hollow in the middle.
  const fingers = [
    // [baseX, baseY, tipX, tipY, width]
    [-19, -27, -27, -78, 14],
    [-5, -31, -8, -89, 15],
    [9, -30, 14, -83, 14],
    [22, -23, 33, -64, 11.5],
  ];
  const seg = (x1, y1, x2, y2, w, parts) =>
    parts
      .map(([a, b], i) => {
        const ax = x1 + (x2 - x1) * a, ay = y1 + (y2 - y1) * a;
        const bx = x1 + (x2 - x1) * b, by = y1 + (y2 - y1) * b;
        return `<path d="M${f(ax)} ${f(ay)} L${f(bx)} ${f(by)}" stroke-width="${f(w * (i === parts.length - 1 ? 1.06 : 0.92))}"/>`;
      })
      .join("");
  const P3 = [
    [0.06, 0.3],
    [0.42, 0.6],
    [0.73, 1],
  ];
  const fingersSvg = fingers.map((p) => seg(...p, P3)).join("");
  const thumb = seg(-25, 2, -55, -27, 16.5, [
    [0, 0.44],
    [0.56, 1],
  ]);
  // Solid palm with the three main creases and a faint hollow knocked out.
  const palm = `<path d="M-27 -24 C-31 -10 -34 16 -22 30 C-14 39 4 42 14 38 C24 34 29 22 29 6 C29 -6 28 -14 26 -21 Q0 -34 -27 -24 Z" stroke="none"/>`;
  const creases = `
    <path d="M27 -9 Q8 -13 -11 -17" stroke-width="1.8"/>
    <path d="M-25 -9 Q-3 -2 21 7" stroke-width="1.6"/>
    <path d="M-23 -6 Q-11 12 -8 36" stroke-width="1.8"/>
    <ellipse cx="3" cy="8" rx="12" ry="12" fill="#9a9a9a" stroke="none"/>`;
  const drips = [
    [-6, 38, 17, 3.8],
    [8, 38, 24, 3.4],
  ]
    .map(
      ([x, y, len, w]) =>
        `<path d="M${x} ${y} C${x + 0.4} ${y + len * 0.4} ${x - 0.4} ${y + len * 0.7} ${x + 0.6} ${y + len}" fill="none" stroke-width="${w}"/><circle cx="${x + 0.6}" cy="${y + len + 1}" r="${f(w * 0.8)}" stroke="none"/>`,
    )
    .join("");
  let spatter = "";
  for (let i = 0; i < 12; i++) {
    const a = rr(-Math.PI * 0.9, Math.PI * 0.1), d = rr(72, 110);
    spatter += `<circle cx="${f(Math.cos(a) * d * 0.75)}" cy="${f(Math.sin(a) * d * 0.8 - 18)}" r="${f(rr(0.8, 2.4))}" stroke="none"/>`;
  }
  return `<g filter="url(#fBlood)">
    <g transform="translate(416 372) rotate(18) scale(0.98)" fill="${C.blood1}" stroke="${C.blood1}" stroke-linecap="round">
      <mask id="mPalm" maskUnits="userSpaceOnUse" x="-120" y="-140" width="240" height="280">
        <rect x="-120" y="-140" width="240" height="280" fill="#fff"/>
        <g stroke="#000" fill="none" stroke-linecap="round">${creases}</g>
      </mask>
      <g mask="url(#mPalm)">${palm}${fingersSvg}${thumb}</g>
      ${drips}${spatter}
    </g>
  </g>`;
}

// ---------------------------------------------------------------- antenna + handle
function antenna() {
  const bx = 452, by = 100, tx = 484, ty = 22;
  const lerp = (t) => [bx + (tx - bx) * t, by + (ty - by) * t];
  const [m1x, m1y] = lerp(0.42);
  const [m2x, m2y] = lerp(0.74);
  return `<g stroke-linecap="round">
    <rect x="440" y="96" width="26" height="18" rx="4" fill="#1b1c16"/>
    <rect x="440" y="96" width="26" height="4" rx="2" fill="#4a4b3f"/>
    <line x1="${bx}" y1="${by}" x2="${f(m1x)}" y2="${f(m1y)}" stroke="#1d1d19" stroke-width="8"/>
    <line x1="${bx}" y1="${by}" x2="${f(m1x)}" y2="${f(m1y)}" stroke="#8c8a7c" stroke-width="2" transform="translate(-2 0)" opacity=".7"/>
    <line x1="${f(m1x)}" y1="${f(m1y)}" x2="${f(m2x)}" y2="${f(m2y)}" stroke="#262620" stroke-width="5.5"/>
    <line x1="${f(m1x)}" y1="${f(m1y)}" x2="${f(m2x)}" y2="${f(m2y)}" stroke="#a7a595" stroke-width="1.5" transform="translate(-1.4 0)" opacity=".75"/>
    <line x1="${f(m2x)}" y1="${f(m2y)}" x2="${tx}" y2="${ty}" stroke="#2c2c26" stroke-width="3.6"/>
    <line x1="${f(m2x)}" y1="${f(m2y)}" x2="${tx}" y2="${ty}" stroke="#bdbbab" stroke-width="1" transform="translate(-1 0)" opacity=".8"/>
    <circle cx="${tx}" cy="${ty}" r="5.5" fill="url(#gChrome)" stroke="#111" stroke-width="1"/>
    ${tapeWrap(f(m1x), f(m1y), (Math.atan2(ty - by, tx - bx) * 180) / Math.PI, 15, 13)}
  </g>`;
}

// A short band of duct tape wrapped round a rod (antenna, handle bar).
// Local x runs along the rod; the band is w long and h across.
function tapeWrap(cx, cy, angle, w, h) {
  const hw = w / 2, hh = h / 2;
  const d = `M${-hw} ${-hh} L${hw} ${-hh + 0.6} L${hw + 1.5} ${-hh / 3} L${hw - 0.8} ${hh / 4} L${hw + 1.2} ${hh} L${-hw} ${hh - 0.4} L${-hw - 1.4} ${hh / 3} L${-hw + 0.8} 0 L${-hw - 1} ${-hh / 2} Z`;
  return `<g transform="translate(${cx} ${cy}) rotate(${f(angle)})">
    <path d="${d}" fill="#000" opacity=".4" transform="translate(1 1.5)"/>
    <path d="${d}" fill="url(#gTapeRod)"/>
    <path d="M${-hw + 2} ${-hh / 2} L${hw - 2} ${-hh / 2 + 0.5}" stroke="#fff" stroke-opacity=".25" stroke-width="1"/>
    <path d="M${-hw + 3} ${hh / 3} L${hw - 1} ${hh / 3 - 0.5}" stroke="#000" stroke-opacity=".12" stroke-width="1"/>
  </g>`;
}

function handle() {
  const d = "M150 112 V88 Q150 70 168 70 H344 Q362 70 362 88 V112";
  return `<g>
    <path d="${d}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="18" transform="translate(0 4)" filter="url(#fSoft)"/>
    <path d="${d}" fill="none" stroke="#1c1d17" stroke-width="15"/>
    <path d="M150 104 V88 Q150 72 168 72 H344 Q362 72 362 88 V104" fill="none" stroke="#6e705d" stroke-width="3" stroke-linecap="round" opacity=".55" transform="translate(-3 -3)"/>
    <rect x="134" y="100" width="32" height="16" rx="3" fill="#262720"/>
    <rect x="346" y="100" width="32" height="16" rx="3" fill="#262720"/>
    <rect x="134" y="100" width="32" height="3" rx="1.5" fill="#6a6b5a" opacity=".6"/>
    <rect x="346" y="100" width="32" height="3" rx="1.5" fill="#6a6b5a" opacity=".6"/>
    ${tapeWrap(214, 70, 3, 26, 21)}
  </g>`;
}

// ---------------------------------------------------------------- main art
function mainSvg() {
  const B = BODY, F = FACE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<!-- Zomboid Control Panel Bridge (ZCPB) Workshop art: "emergency broadcast
     console". Original artwork; no Indie Stone / Spiffo / Steam marks. -->
<defs>
  <radialGradient id="gWall" cx="0.42" cy="0.42" r="0.75">
    <stop offset="0" stop-color="${C.wallA}"/>
    <stop offset="1" stop-color="${C.wallB}"/>
  </radialGradient>
  <radialGradient id="gSpill" cx="0.39" cy="0.47" r="0.55">
    <stop offset="0" stop-color="${C.phos}" stop-opacity=".22"/>
    <stop offset=".6" stop-color="${C.phos}" stop-opacity=".05"/>
    <stop offset="1" stop-color="${C.phos}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="gTable" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a2016"/>
    <stop offset="1" stop-color="#0d0a07"/>
  </linearGradient>
  <linearGradient id="gBody" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.olive1}"/>
    <stop offset=".5" stop-color="${C.olive2}"/>
    <stop offset="1" stop-color="${C.olive3}"/>
  </linearGradient>
  <linearGradient id="gFace" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.face1}"/>
    <stop offset="1" stop-color="${C.face2}"/>
  </linearGradient>
  <linearGradient id="gHousing" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0e0f0c"/>
    <stop offset="1" stop-color="#1c1d18"/>
  </linearGradient>
  <radialGradient id="gGlass" cx="0.5" cy="0.52" r="0.62">
    <stop offset="0" stop-color="${C.glass1}"/>
    <stop offset=".6" stop-color="${C.glass2}"/>
    <stop offset="1" stop-color="${C.glass3}"/>
  </radialGradient>
  <radialGradient id="gSheen">
    <stop offset="0" stop-color="#fff" stop-opacity=".06"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <pattern id="pBlocks" width="76" height="38" patternUnits="userSpaceOnUse" patternTransform="translate(-20 6)">
    <path d="M0 1 H76 M0 20 H76 M1 1 V20 M39 20 V38" stroke="#000" stroke-width="2.4" fill="none" opacity=".75"/>
    <path d="M0 3 H76 M0 22 H76" stroke="#fff" stroke-width="1" opacity=".05"/>
  </pattern>
  <radialGradient id="gBlockMask" cx="0.4" cy="0.45" r="0.6">
    <stop offset="0" stop-color="#fff" stop-opacity="1"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.15"/>
  </radialGradient>
  <mask id="mBlocks" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="424" fill="url(#gBlockMask)"/></mask>
  <radialGradient id="gGlassVig" cx="0.5" cy="0.5" r="0.7">
    <stop offset=".6" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity=".65"/>
  </radialGradient>
  <linearGradient id="gTrace" gradientUnits="userSpaceOnUse" x1="${GLASS.x}" y1="0" x2="${HEAD_X}" y2="0">
    <stop offset="0" stop-color="${C.phos}" stop-opacity=".15"/>
    <stop offset=".55" stop-color="${C.phos}" stop-opacity=".85"/>
    <stop offset="1" stop-color="${C.phos}" stop-opacity="1"/>
  </linearGradient>
  <linearGradient id="gTraceCore" gradientUnits="userSpaceOnUse" x1="${GLASS.x}" y1="0" x2="${HEAD_X}" y2="0">
    <stop offset="0" stop-color="${C.phosCore}" stop-opacity=".1"/>
    <stop offset=".55" stop-color="${C.phosCore}" stop-opacity=".9"/>
    <stop offset="1" stop-color="${C.phosCore}" stop-opacity="1"/>
  </linearGradient>
  <linearGradient id="gTraceGlow" gradientUnits="userSpaceOnUse" x1="${GLASS.x}" y1="0" x2="${HEAD_X}" y2="0">
    <stop offset="0" stop-color="${C.phos}" stop-opacity="0"/>
    <stop offset="1" stop-color="${C.phos}" stop-opacity="1"/>
  </linearGradient>
  <pattern id="pScan" width="4" height="3" patternUnits="userSpaceOnUse">
    <rect width="4" height="1.2" fill="#000" opacity=".38"/>
  </pattern>
  <pattern id="pScrim" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
    <rect width="3.2" height=".7" fill="#000" opacity=".08"/>
    <rect width=".7" height="3.2" fill="#fff" opacity=".1"/>
  </pattern>
  <radialGradient id="gLed" cx="0.42" cy="0.38" r="0.65">
    <stop offset="0" stop-color="#ffd2c0"/>
    <stop offset=".3" stop-color="${C.led}"/>
    <stop offset="1" stop-color="#7a0602"/>
  </radialGradient>
  <radialGradient id="gLedGlow">
    <stop offset="0" stop-color="${C.led}" stop-opacity=".55"/>
    <stop offset=".35" stop-color="${C.led}" stop-opacity=".18"/>
    <stop offset="1" stop-color="${C.led}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="gChrome" cx="0.35" cy="0.3" r="0.8">
    <stop offset="0" stop-color="#e8e6da"/>
    <stop offset=".45" stop-color="#8d8b7e"/>
    <stop offset="1" stop-color="#2c2b26"/>
  </radialGradient>
  <linearGradient id="gChromeBat" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#5a5950"/>
    <stop offset=".35" stop-color="#f0eee2"/>
    <stop offset=".7" stop-color="#9a988b"/>
    <stop offset="1" stop-color="#3a3933"/>
  </linearGradient>
  <radialGradient id="gScrew" cx="0.35" cy="0.3" r="0.8">
    <stop offset="0" stop-color="#bdb9a6"/>
    <stop offset=".6" stop-color="#6e6c5e"/>
    <stop offset="1" stop-color="#34332c"/>
  </radialGradient>
  <radialGradient id="gKnobCap" cx="0.38" cy="0.3" r="0.8">
    <stop offset="0" stop-color="#57574c"/>
    <stop offset=".55" stop-color="#2a2a24"/>
    <stop offset="1" stop-color="#121210"/>
  </radialGradient>
  <linearGradient id="gTape" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.tape1}"/>
    <stop offset=".55" stop-color="#b6b5ac"/>
    <stop offset="1" stop-color="${C.tape2}"/>
  </linearGradient>
  <linearGradient id="gTapeRod" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#8e8d85"/>
    <stop offset=".35" stop-color="#d2d1c8"/>
    <stop offset="1" stop-color="#6d6c65"/>
  </linearGradient>
  <linearGradient id="gBevelTop" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#e8e4c8" stop-opacity=".22"/>
    <stop offset="1" stop-color="#e8e4c8" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gBevelBot" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity=".45"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gBevelL" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#e8e4c8" stop-opacity=".1"/>
    <stop offset="1" stop-color="#e8e4c8" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="gBevelR" x1="1" y1="0" x2="0" y2="0">
    <stop offset="0" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="gVignette" cx="0.5" cy="0.5" r="0.72">
    <stop offset=".62" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity=".6"/>
  </radialGradient>

  <clipPath id="cpGlass"><rect x="${GLASS.x}" y="${GLASS.y}" width="${GLASS.w}" height="${GLASS.h}" rx="${GLASS.rx}"/></clipPath>
  <clipPath id="cpBody"><rect x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}" rx="${B.rx}"/></clipPath>

  <filter id="fSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
  <filter id="fBlur1" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.2"/></filter>
  <filter id="fBlur6" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="fBloom" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="fGlowS" x="-20%" y="-50%" width="140%" height="200%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="fGrainDark" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="4"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.2 0 0 0 -1.75"/>
  </filter>
  <filter id="fGrainLight" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="2" seed="9"/>
    <feColorMatrix type="matrix" values="0 0 0 0 .85  0 0 0 0 .83  0 0 0 0 .72  0 3 0 0 -1.75"/>
  </filter>
  <filter id="fGrime" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency=".018" numOctaves="4" seed="21"/>
    <feColorMatrix type="matrix" values="0 0 0 0 .16  0 0 0 0 .11  0 0 0 0 .05  2.6 0 0 0 -1.25"/>
  </filter>
  <filter id="fWear" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="4" seed="5" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  7 0 0 0 -4.1" result="m"/>
    <feComposite in="SourceGraphic" in2="m" operator="in"/>
  </filter>
  <filter id="fDirt" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency=".05 .12" numOctaves="3" seed="13"/>
    <feColorMatrix type="matrix" values="0 0 0 0 .25  0 0 0 0 .18  0 0 0 0 .1  2.2 0 0 0 -1.1"/>
  </filter>
  <filter id="fInk" x="-10%" y="-30%" width="120%" height="160%">
    <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="1" seed="2" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="fBlood" x="0" y="0" width="512" height="512" filterUnits="userSpaceOnUse">
    <feTurbulence type="fractalNoise" baseFrequency=".06" numOctaves="3" seed="7" result="warp"/>
    <feDisplacementMap in="SourceGraphic" in2="warp" scale="4.5" xChannelSelector="R" yChannelSelector="G" result="rough"/>
    <feTurbulence type="fractalNoise" baseFrequency=".22" numOctaves="2" seed="11" result="sp"/>
    <feColorMatrix in="sp" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.2 0 0 0 -0.2" result="spA"/>
    <feComposite in="rough" in2="spA" operator="in" result="tex"/>
    <feMorphology in="tex" operator="erode" radius="1.6" result="inner"/>
    <feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="2" seed="31" result="hl"/>
    <feColorMatrix in="hl" type="matrix" values="0 0 0 0 .46  0 0 0 0 .06  0 0 0 0 .035  1.7 0 0 0 -0.8" result="hlC"/>
    <feComposite in="hlC" in2="inner" operator="in" result="hl2"/>
    <feMerge><feMergeNode in="tex"/><feMergeNode in="hl2"/></feMerge>
  </filter>
</defs>

<!-- room: dark wall + table -->
<rect width="512" height="512" fill="url(#gWall)"/>
<rect width="512" height="424" fill="url(#pBlocks)" mask="url(#mBlocks)" opacity=".9"/>
<rect width="512" height="512" fill="url(#gSpill)"/>
<rect width="512" height="424" filter="url(#fGrime)" opacity=".2"/>
<rect width="512" height="512" filter="url(#fGrainDark)" opacity=".35"/>
<rect x="0" y="424" width="512" height="88" fill="url(#gTable)"/>
<rect x="0" y="424" width="512" height="2" fill="#4a3a28" opacity=".6"/>
<g stroke="#000" stroke-opacity=".35" stroke-width="1">
  <path d="M0 446 Q180 442 512 449"/><path d="M0 468 Q260 464 512 472"/><path d="M0 492 Q300 488 512 495"/>
</g>
<ellipse cx="256" cy="442" rx="238" ry="12" fill="#000" opacity=".75" filter="url(#fSoft)"/>

${handle()}
${antenna()}

<!-- body -->
<rect x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}" rx="${B.rx}" fill="url(#gBody)"/>
<g clip-path="url(#cpBody)">
  <rect width="512" height="512" filter="url(#fGrime)" opacity=".7"/>
  <rect width="512" height="512" filter="url(#fGrainDark)" opacity=".4"/>
  <rect width="512" height="512" filter="url(#fGrainLight)" opacity=".1"/>
  ${scratches()}
</g>
<rect x="${B.x + 2}" y="${B.y + 2}" width="${B.w - 4}" height="${B.h - 4}" rx="${B.rx - 1}" fill="none" stroke="${C.metal}" stroke-width="5" filter="url(#fWear)" clip-path="url(#cpBody)" opacity=".85"/>
<rect x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}" rx="${B.rx}" fill="none" stroke="#0b0b08" stroke-width="1.5"/>
<g clip-path="url(#cpBody)">
  <rect x="${B.x}" y="${B.y}" width="${B.w}" height="14" fill="url(#gBevelTop)"/>
  <rect x="${B.x}" y="${B.y + B.h - 14}" width="${B.w}" height="14" fill="url(#gBevelBot)"/>
  <rect x="${B.x}" y="${B.y}" width="10" height="${B.h}" fill="url(#gBevelL)"/>
  <rect x="${B.x + B.w - 10}" y="${B.y}" width="10" height="${B.h}" fill="url(#gBevelR)"/>
</g>
<path d="M${B.x + B.rx} ${B.y + 1.5} H${B.x + B.w - B.rx}" stroke="#e2dfc6" stroke-opacity=".35" stroke-width="1.5"/>

<!-- faceplate (recessed) -->
<rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" rx="${F.rx}" fill="url(#gFace)"/>
<g clip-path="url(#cpBody)">
  <rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" filter="url(#fGrainDark)" opacity=".3"/>
</g>
<rect x="${F.x + 1}" y="${F.y + 1}" width="${F.w - 2}" height="${F.h - 2}" rx="${F.rx}" fill="none" stroke="#000" stroke-opacity=".65" stroke-width="2"/>
<path d="M${F.x + 4} ${F.y + F.h + 0.5} H${F.x + F.w - 4}" stroke="#8d8b76" stroke-opacity=".35" stroke-width="1.2"/>
${screw(F.x + 12, F.y + 12)}${screw(F.x + F.w - 12, F.y + 12)}${screw(F.x + 12, F.y + F.h - 12)}${screw(F.x + F.w - 12, F.y + F.h - 12)}

${screen()}
${led()}
${toggle()}
${knob()}
${grille()}

<!-- zombie: bloody hand dragged down the casing -->
<g clip-path="url(#cpBody)">${hand()}</g>
${tape()}

<!-- final grade -->
<rect width="512" height="512" fill="url(#gVignette)"/>
<rect width="512" height="512" filter="url(#fGrainLight)" opacity=".07"/>
</svg>
`;
}

// ---------------------------------------------------------------- 32 px icon
function iconSvg() {
  const pulse = "M5 13 H10.5 L13 5.5 L16.5 19.5 L18.5 13 H27";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<!-- ZCPB mod-list icon: the console's phosphor screen + red status LED on the
     olive casing. Same palette and pulse as bridge-radio.svg. -->
<defs>
  <linearGradient id="iBody" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#55573e"/>
    <stop offset="1" stop-color="#2f3124"/>
  </linearGradient>
  <radialGradient id="iGlass" cx="0.5" cy="0.55" r="0.72">
    <stop offset="0" stop-color="#2a7a20"/>
    <stop offset=".65" stop-color="#0e360b"/>
    <stop offset="1" stop-color="#041204"/>
  </radialGradient>
  <radialGradient id="iLed" cx="0.4" cy="0.35" r="0.7">
    <stop offset="0" stop-color="#ffd0bd"/>
    <stop offset=".35" stop-color="#ff2a14"/>
    <stop offset="1" stop-color="#8a0703"/>
  </radialGradient>
  <radialGradient id="iLedGlow">
    <stop offset="0" stop-color="#ff2a14" stop-opacity=".5"/>
    <stop offset="1" stop-color="#ff2a14" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect x="0.5" y="0.5" width="31" height="31" rx="6" fill="url(#iBody)" stroke="#0b0c08"/>
<path d="M6 1.5 H26" stroke="#c9c6a8" stroke-opacity=".35"/>
<rect x="3" y="3" width="26" height="18" rx="3.5" fill="url(#iGlass)" stroke="#070806"/>
<path d="${pulse}" fill="none" stroke="#7dff5e" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" opacity=".35"/>
<path d="${pulse}" fill="none" stroke="#efffe4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="25" cy="26" r="5" fill="url(#iLedGlow)"/>
<circle cx="25" cy="26" r="3" fill="url(#iLed)" stroke="#1a0503" stroke-width=".8"/>
</svg>
`;
}

fs.writeFileSync(path.join(here, "bridge.svg"), mainSvg());
fs.writeFileSync(path.join(here, "bridge-icon.svg"), iconSvg());
console.log("wrote pz-mod/workshop/art/bridge.svg and bridge-icon.svg");
