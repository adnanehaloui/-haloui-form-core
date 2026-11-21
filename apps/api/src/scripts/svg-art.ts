/** Small SVG generators for demo listings (icons and showcase images). No external assets. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function iconSvg(glyph: string, from: string, to: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient><radialGradient id="h" cx=".25" cy=".15" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="256" height="256" fill="url(#g)"/><rect width="256" height="256" fill="url(#h)"/><text x="128" y="128" dy=".35em" text-anchor="middle" font-family="system-ui,Segoe UI Emoji,Apple Color Emoji,sans-serif" font-size="128">${esc(glyph)}</text></svg>`;
}

export function storyboardSvg(frames: string[], color: string) {
  const w = 1200, h = 675, cols = 3, pad = 28, fw = (w - pad * (cols + 1)) / cols, fh = (h - pad * 3 - 60) / 2;
  const cells = frames.slice(0, 6).map((f, i) => {
    const x = pad + (i % cols) * (fw + pad), y = 80 + Math.floor(i / cols) * (fh + pad);
    return `<g><rect x="${x}" y="${y}" width="${fw}" height="${fh}" rx="18" fill="#0f0f14"/><rect x="${x}" y="${y}" width="${fw}" height="${fh}" rx="18" fill="url(#s${i})" opacity=".9"/><defs><linearGradient id="s${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${0.35 + i * 0.1}"/><stop offset="1" stop-color="#111" stop-opacity=".2"/></linearGradient></defs><text x="${x + 18}" y="${y + 34}" fill="#fff" opacity=".7" font-family="system-ui" font-size="18" font-weight="600">SHOT ${i + 1}</text><text x="${x + 18}" y="${y + fh - 24}" fill="#fff" font-family="system-ui" font-size="22">${esc(f.slice(0, 32))}</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#1b1b22"/><text x="${pad}" y="52" fill="#fff" font-family="system-ui" font-size="28" font-weight="700">Storyboard · 18s · 1080p</text>${cells.join("")}</svg>`;
}

export function paletteSvg(name: string, colors: string[]) {
  const w = 1200, h = 675, sw = w / colors.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fafafa"/>${colors.map((c, i) => `<rect x="${i * sw}" y="0" width="${sw}" height="430" fill="${c}"/><text x="${i * sw + 24}" y="470" font-family="ui-monospace,monospace" font-size="24" fill="#222">${c}</text>`).join("")}<text x="24" y="560" font-family="Georgia,serif" font-size="64" fill="#111">${esc(name)}</text><text x="24" y="620" font-family="system-ui" font-size="26" fill="#666">Primary · Secondary · Accent · Neutral · Ink</text></svg>`;
}

export function chartSvg(title: string, values: [string, number][], color: string) {
  const w = 1200, h = 675, max = Math.max(...values.map((v) => v[1])), bw = (w - 160) / values.length - 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><text x="60" y="70" font-family="system-ui" font-size="32" font-weight="700" fill="#111">${esc(title)}</text>${values
    .map(([l, v], i) => {
      const bh = (v / max) * 440, x = 80 + i * (bw + 24), y = 580 - bh;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="10" fill="${color}" opacity="${0.55 + (0.45 * v) / max}"/><text x="${x + bw / 2}" y="${y - 12}" text-anchor="middle" font-family="system-ui" font-size="22" fill="#333">${v}</text><text x="${x + bw / 2}" y="620" text-anchor="middle" font-family="system-ui" font-size="22" fill="#666">${esc(l)}</text>`;
    })
    .join("")}</svg>`;
}
