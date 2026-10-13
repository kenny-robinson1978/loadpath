// Convergence chart: normalized compliance (solid) and volume fraction (dashed), with markers
// where the Heaviside projection sharpens (β doubles).

export function convergenceChart(history, volTarget, W = 600) {
  if (!history.length) return '';
  const H = 120, pl = 34, pr = 40, pt = 10, pb = 20;
  const n = Math.max(history.length, 20);
  const cMax = Math.max(1, ...history.map((h) => h.cNorm));
  const x = (i) => pl + (i / (n - 1)) * (W - pl - pr);
  const yc = (c) => pt + (1 - c / cMax) * (H - pt - pb);
  const yv = (v) => pt + (1 - v) * (H - pt - pb);
  const path = (f) => history.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${f(h).toFixed(1)}`).join('');
  const betas = [];
  for (let i = 1; i < history.length; i++) if (history[i].beta !== history[i - 1].beta) betas.push([i, history[i].beta]);
  const last = history[history.length - 1];
  // keep the two end labels from overlapping
  const vy = yv(last.vol) + 4;
  let cy = Math.min(H - pb - 2, yc(last.cNorm) + 4);
  if (Math.abs(cy - vy) < 12) cy = vy + (cy >= vy ? 12 : -12);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Convergence: compliance fell to ${(last.cNorm * 100).toFixed(0)}% of the initial value over ${history.length} iterations">
    <line class="gridl" x1="${pl}" x2="${W - pr}" y1="${yc(cMax / 2)}" y2="${yc(cMax / 2)}"/>
    <line class="axis" x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}"/>
    ${betas.map(([i, b]) => `<line class="beta" x1="${x(i)}" x2="${x(i)}" y1="${pt}" y2="${H - pb}"/><text x="${x(i) + 3}" y="${pt + 9}">β${b}</text>`).join('')}
    ${volTarget ? `<line class="gridl" x1="${pl}" x2="${W - pr}" y1="${yv(volTarget)}" y2="${yv(volTarget)}"/>` : ''}
    <path class="c-line" d="${path((h) => yc(h.cNorm))}"/>
    <path class="v-line" d="${path((h) => yv(h.vol))}"/>
    <text x="2" y="${pt + 8}">C/C₀</text>
    <text x="2" y="${H - pb}">0</text>
    <text x="${W - pr + 4}" y="${vy}" style="fill:var(--load)">${(last.vol * 100).toFixed(0)}%</text>
    <text x="${W - pr + 4}" y="${cy}" style="fill:var(--accent)">${last.cNorm.toFixed(2)}</text>
    <text x="${pl}" y="${H - 5}">iteration</text>
    <text x="${W - pr}" y="${H - 5}" text-anchor="end">${history.length}</text>
  </svg>`;
}
