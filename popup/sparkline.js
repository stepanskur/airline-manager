// sparkline.js — paint a minimal canvas sparkline.

export function drawSparkline(canvas, values, { color = "#a5b4fc", fill = "rgba(129, 140, 248, 0.18)" } = {}) {
  if (!canvas || !values || values.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200;
  const h = canvas.clientHeight || 40;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  const toX = (i) => (i / Math.max(1, values.length - 1)) * (w - pad * 2) + pad;
  const toY = (v) => h - pad - ((v - min) / range) * (h - pad * 2);

  // fill
  ctx.beginPath();
  ctx.moveTo(toX(0), h - pad);
  values.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(values.length - 1), h - pad);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // line
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = toX(i);
    const y = toY(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // last dot
  const lx = toX(values.length - 1);
  const ly = toY(values[values.length - 1]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
  ctx.fill();
}
