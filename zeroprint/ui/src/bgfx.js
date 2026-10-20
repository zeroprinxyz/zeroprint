// Background animation, the ZeroPrint idea in motion. Wallets on the left (a linked, traceable
// graph) send labelled particles into the pool: a rotating vault with a radar sweep. Inside, the
// labels are redacted and every particle looks the same; they leave to lone fresh wallets on the
// right with no line back. Behind: a hex lattice and a scrambling hash rain. Pauses when the tab
// is hidden; prefers-reduced-motion gets one still frame.
const TEAL = [124, 231, 208];
const BLUE = [106, 168, 255];
const AMBER = [255, 190, 120];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const HEX = "0123456789abcdef";
const rhex = (n) => Array.from({ length: n }, () => HEX[(Math.random() * 16) | 0]).join("");

export function startShade(
  canvas,
  { intensity = 1, poolY = 0.55, poolR = 0.14, darkCore = false, scanline = true, interactive = null } = {},
) {
  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0;
  let h = 0;
  let sources = [];
  let sinks = [];
  let parts = [];
  let cols = [];
  let lattice = null;
  let pool = { x: 0, y: 0, r: 0 };
  let narrow = false;
  // Vault spin: `phase` replaces wall-clock time for the rings, the sweep and the swirl, so the
  // spin can slow, stop, reverse or be dragged. spin 1 = normal, 0 = still, -1 = reversed.
  const vault = { phase: 0, spin: 1, dir: 1, hover: false, drag: null, last: 0, ptr: null, glow: 0 };

  function buildLattice() {
    // pre-render a faint hexagon lattice once per resize
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const s = narrow ? 26 : 34;
    const hh = s * Math.sqrt(3);
    g.strokeStyle = rgba(TEAL, 0.05);
    g.lineWidth = 1;
    for (let y = -hh; y < h + hh; y += hh / 2) {
      const row = Math.round(y / (hh / 2));
      for (let x = -s * 3; x < w + s * 3; x += s * 3) {
        const cx = x + (row % 2 ? s * 1.5 : 0);
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k;
          const px = cx + s * Math.cos(a);
          const py = y + s * Math.sin(a);
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath();
        g.stroke();
      }
    }
    // fade the lattice toward the edges so the centre stays readable
    const fade = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.15, w / 2, h / 2, Math.max(w, h) * 0.75);
    fade.addColorStop(0, "rgba(0,0,0,0.85)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);
    lattice = c;
  }

  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    narrow = w < 700;
    pool = { x: w / 2, y: h * poolY, r: Math.min(w, h) * (narrow ? Math.max(poolR, 0.17) : poolR) };
    const n = narrow ? 5 : 8;
    const side = (x0, x1) =>
      Array.from({ length: n }, (_, i) => ({
        x: x0 + Math.random() * (x1 - x0),
        y: h * 0.12 + ((h * 0.8) / (n - 1)) * i + (Math.random() - 0.5) * 30,
        pulse: Math.random() * Math.PI * 2,
        id: `0x${rhex(4)}`,
      }));
    sources = side(w * 0.04, w * 0.22);
    sinks = side(w * 0.78, w * 0.96);
    const cw = 16;
    cols = Array.from({ length: Math.ceil(w / cw) }, (_, i) => ({
      x: i * cw + 4,
      y: Math.random() * h,
      speed: 0.2 + Math.random() * 0.6,
      chars: rhex(16).split(""),
      on: Math.random() < 0.3,
    }));
    parts = [];
    buildLattice();
  }

  function spawn() {
    const s = sources[(Math.random() * sources.length) | 0];
    parts.push({
      phase: 0, // 0 = to pool, 1 = mixing, 2 = to a fresh wallet
      x: s.x,
      y: s.y,
      from: s,
      t: 0,
      speed: 0.004 + Math.random() * 0.004,
      ang: Math.random() * Math.PI * 2,
      swirl: 90 + Math.random() * 160, // frames spent mixing
      f: 0,
      sink: sinks[(Math.random() * sinks.length) | 0],
      hue: Math.random() < 0.5 ? BLUE : AMBER, // distinct while traceable
      label: Math.random() < 0.28 ? `0x${rhex(4)}…` : null,
    });
  }

  const ease = (t) => t * t * (3 - 2 * t);

  function drawRain() {
    ctx.font = "11px ui-monospace, Menlo, monospace";
    for (const c of cols) {
      if (!c.on) continue;
      c.y += c.speed;
      if (c.y > h + 240) {
        c.y = -240;
        c.on = Math.random() < 0.6;
      }
      if (Math.random() < 0.08) c.chars[(Math.random() * c.chars.length) | 0] = HEX[(Math.random() * 16) | 0];
      for (let i = 0; i < c.chars.length; i++) {
        const head = i === c.chars.length - 1;
        ctx.fillStyle = rgba(TEAL, (head ? 0.28 : (i / c.chars.length) * 0.08) * intensity);
        ctx.fillText(c.chars[i], c.x, c.y + i * 14);
      }
    }
  }

  function drawScanline(now) {
    const y = ((now / 7000) % 1) * (h + 200) - 100;
    const g = ctx.createLinearGradient(0, y - 60, 0, y + 60);
    g.addColorStop(0, rgba(TEAL, 0));
    g.addColorStop(0.5, rgba(TEAL, 0.035 * intensity));
    g.addColorStop(1, rgba(TEAL, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 60, w, 120);
  }

  function drawNodes(now) {
    ctx.font = "10px ui-monospace, Menlo, monospace";
    // traceable side: a visible graph of linked wallets
    ctx.strokeStyle = rgba(BLUE, 0.08 * intensity);
    ctx.lineWidth = 1;
    for (let i = 1; i < sources.length; i++) {
      ctx.beginPath();
      ctx.moveTo(sources[i - 1].x, sources[i - 1].y);
      ctx.lineTo(sources[i].x, sources[i].y);
      ctx.stroke();
    }
    for (const n of sources) {
      const p = 0.5 + 0.5 * Math.sin(now / 900 + n.pulse);
      ctx.fillStyle = rgba(BLUE, (0.3 + 0.3 * p) * intensity);
      ctx.beginPath();
      ctx.arc(n.x, n.y, 3, 0, Math.PI * 2);
      ctx.fill();
      if (!narrow) {
        ctx.fillStyle = rgba(BLUE, 0.22 * intensity);
        ctx.fillText(n.id, n.x + 7, n.y + 3);
      }
    }
    // fresh wallets: lone hexagons, no links, no names
    for (const n of sinks) {
      const p = 0.5 + 0.5 * Math.sin(now / 1100 + n.pulse);
      ctx.strokeStyle = rgba(TEAL, (0.3 + 0.35 * p) * intensity);
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = n.x + 5 * Math.cos(a);
        const py = n.y + 5 * Math.sin(a);
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  function drawPool(now) {
    const { x, y, r } = pool;
    // glow
    const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r * 2.4);
    g.addColorStop(0, rgba(TEAL, (vault.hover || vault.drag ? 0.18 : 0.11) * intensity));
    g.addColorStop(1, rgba(TEAL, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    if (darkCore) {
      const core = ctx.createRadialGradient(x, y, 0, x, y, r);
      core.addColorStop(0, "rgba(4,6,10,0.82)");
      core.addColorStop(0.75, "rgba(4,6,10,0.6)");
      core.addColorStop(1, "rgba(4,6,10,0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(x, y);
    // radar sweep
    const t = vault.phase;
    const sweep = (t / 2600) % (Math.PI * 2);
    for (let k = 0; k < 24; k++) {
      const a0 = sweep - k * 0.03;
      ctx.fillStyle = rgba(TEAL, (0.06 * (1 - k / 24)) * intensity);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r * 1.02, a0 - 0.03, a0);
      ctx.closePath();
      ctx.fill();
    }
    // segmented vault ring
    ctx.rotate(t / 7000);
    ctx.lineWidth = 2;
    for (let k = 0; k < 12; k++) {
      ctx.strokeStyle = rgba(TEAL, (k % 3 === 0 ? 0.55 : 0.3) * intensity);
      ctx.beginPath();
      ctx.arc(0, 0, r, (k * Math.PI) / 6 + 0.06, ((k + 1) * Math.PI) / 6 - 0.06);
      ctx.stroke();
    }
    // tick ring, counter-rotating
    ctx.rotate(-t / 3500);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(TEAL, 0.25 * intensity);
    for (let k = 0; k < 60; k++) {
      const a = (k * Math.PI) / 30;
      const r0 = r * 1.12;
      const r1 = r * (k % 5 === 0 ? 1.2 : 1.16);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
    // inner dashed ring, leaning a little toward the pointer
    if (vault.ptr && vault.glow > 0.01) {
      ctx.rotate(-(t / 7000) + t / 3500); // back to screen orientation
      ctx.translate(vault.ptr.dx * 0.03 * vault.glow, vault.ptr.dy * 0.03 * vault.glow);
      ctx.rotate(t / 7000 - t / 3500);
    }
    ctx.rotate(t / 5000);
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = rgba(TEAL, 0.2 * intensity);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // the part of the ring nearest the pointer lights up a little
    if (vault.ptr && vault.glow > 0.01) {
      const a = Math.atan2(vault.ptr.dy, vault.ptr.dx);
      const grad = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 1.1);
      grad.addColorStop(0, rgba(TEAL, 0));
      grad.addColorStop(0.5, rgba(TEAL, 0.55 * vault.glow * intensity));
      grad.addColorStop(1, rgba(TEAL, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(x, y, r, a - 0.22, a + 0.22);
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }

  function step() {
    // the flow in and out follows the vault: it stops when the ring stops (direction aside)
    const flow = Math.min(1.5, Math.abs(vault.spin));
    if (parts.length < (narrow ? 40 : 70) && Math.random() < 0.35 * flow) spawn();
    for (const p of parts) {
      p.t += p.speed * flow;
      if (p.phase === 0) {
        const e = ease(Math.min(1, p.t));
        p.x = p.from.x + (pool.x - p.from.x) * e;
        p.y = p.from.y + (pool.y - p.from.y) * e + Math.sin(e * Math.PI) * -40;
        if (p.t >= 1) Object.assign(p, { phase: 1, t: 0 });
      } else if (p.phase === 1) {
        // inside the pool every particle looks the same
        p.ang += 0.03 * vault.spin;
        const rr = pool.r * (darkCore ? 0.7 + 0.25 * Math.abs(Math.sin(p.ang * 0.7)) : 0.2 + 0.62 * Math.abs(Math.sin(p.ang * 0.7)));
        p.x = pool.x + Math.cos(p.ang) * rr;
        p.y = pool.y + Math.sin(p.ang) * rr * 0.9;
        if ((p.f += flow) > p.swirl) Object.assign(p, { phase: 2, t: 0, sx: p.x, sy: p.y });
      } else {
        const e = ease(Math.min(1, p.t));
        p.x = p.sx + (p.sink.x - p.sx) * e;
        p.y = p.sy + (p.sink.y - p.sy) * e + Math.sin(e * Math.PI) * 30;
        if (p.t >= 1) p.dead = true;
      }
    }
    parts = parts.filter((p) => !p.dead);
  }

  function drawParts() {
    ctx.font = "10px ui-monospace, Menlo, monospace";
    for (const p of parts) {
      const c = p.phase === 0 ? p.hue : TEAL;
      const a = (p.phase === 2 ? 1 - Math.min(1, p.t) * 0.6 : p.phase === 1 && darkCore ? 0.45 : 0.9) * intensity;
      if (p.phase === 0) {
        // traceable: a trail back to the source wallet
        ctx.strokeStyle = rgba(c, 0.12 * intensity);
        ctx.beginPath();
        ctx.moveTo(p.from.x, p.from.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(c, a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.phase === 1 ? 1.6 : 2.1, 0, Math.PI * 2);
      ctx.fill();
      if (p.label && !narrow) {
        if (p.phase === 0) {
          ctx.fillStyle = rgba(c, 0.5 * intensity);
          ctx.fillText(p.label, p.x + 6, p.y - 5);
        } else if (p.phase === 1 && p.f < 50) {
          // entering the pool: the label gets redacted, then fades
          ctx.fillStyle = rgba(TEAL, 0.45 * (1 - p.f / 50) * intensity);
          ctx.fillText("█".repeat(6), p.x + 6, p.y - 5);
        }
      }
    }
  }

  function frame(now) {
    ctx.clearRect(0, 0, w, h);
    if (lattice) {
      ctx.globalAlpha = intensity;
      ctx.drawImage(lattice, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    drawRain();
    if (scanline) drawScanline(now);
    drawPool(now);
    drawNodes(now);
    drawParts();
  }

  let raf = 0;
  let running = false;
  function loop(now) {
    const dt = Math.min(64, now - (vault.last || now));
    vault.last = now;
    vault.glow += ((vault.ptr?.inside || vault.hover || vault.drag ? 1 : 0) - vault.glow) * 0.08;
    if (!vault.drag) {
      // inside the ring the pointer nudges the speed: right is faster, left slower (±35%)
      const nudge = vault.ptr?.inside ? 1 + 0.35 * Math.max(-1, Math.min(1, vault.ptr.dx / pool.r)) : 1;
      const target = vault.hover ? 0 : vault.dir * nudge;
      vault.spin += (target - vault.spin) * 0.05;
      vault.phase += dt * vault.spin;
    }
    step();
    frame(now);
    raf = requestAnimationFrame(loop);
  }
  let onScreen = true;
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    onScreen ? start() : stop();
  }).observe(canvas);
  function start() {
    if (running || reduce || !onScreen || document.hidden) return;
    running = true;
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  if (interactive && !reduce) {
    // Hover the ring: it slows to a stop. Click it: the spin reverses. Drag it: turn the vault.
    const local = (e) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const onRing = (p) => {
      const d = Math.hypot(p.x - pool.x, p.y - pool.y);
      return d > pool.r * 0.82 && d < pool.r * 1.28;
    };
    const angle = (p) => Math.atan2(p.y - pool.y, p.x - pool.x);
    const busyTarget = (e) => e.target.closest?.("a, button, input, select, textarea");
    interactive.addEventListener("pointermove", (e) => {
      const p = local(e);
      const dx = p.x - pool.x;
      const dy = p.y - pool.y;
      vault.ptr = { dx, dy, inside: Math.hypot(dx, dy) < pool.r * 1.28 && e.pointerType !== "touch" };
      if (vault.drag?.touch) return; // touch: no dragging, the page must still scroll
      if (vault.drag) {
        const a = angle(p);
        let da = a - vault.drag.a;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        vault.phase += da * 7000; // the outer ring turns by exactly the drag angle
        vault.drag.v = da;
        vault.drag.moved += Math.abs(da);
        vault.drag.a = a;
        return;
      }
      vault.hover = !busyTarget(e) && onRing(p);
      interactive.style.cursor = vault.hover ? "grab" : "";
    });
    interactive.addEventListener("pointerleave", () => {
      if (vault.ptr) vault.ptr.inside = false;
      if (!vault.drag) vault.hover = false;
      interactive.style.cursor = "";
    });
    interactive.addEventListener("pointerdown", (e) => {
      const p = local(e);
      if (busyTarget(e) || !onRing(p)) return;
      if (e.pointerType === "touch") {
        vault.drag = { touch: true, moved: 0, v: 0 }; // a tap reverses; no drag on touch
        return;
      }
      vault.drag = { a: angle(p), v: 0, moved: 0 };
      interactive.setPointerCapture?.(e.pointerId);
      interactive.style.cursor = "grabbing";
      e.preventDefault();
    });
    const release = () => {
      if (!vault.drag) return;
      const { v, moved } = vault.drag;
      vault.drag = null;
      if (moved < 0.03) {
        vault.dir = -vault.dir; // a click: reverse
        vault.spin = 0;
      } else {
        vault.dir = v >= 0 ? 1 : -1; // keep going the way it was turned
        vault.spin = vault.dir * Math.min(6, 1 + Math.abs(v) * 40);
      }
      vault.hover = false;
      interactive.style.cursor = "";
    };
    interactive.addEventListener("pointerup", release);
    // the browser took over (e.g. a scroll started): forget the press, don't reverse
    interactive.addEventListener("pointercancel", () => {
      vault.drag = null;
      vault.hover = false;
      interactive.style.cursor = "";
    });
  }

  layout();
  if (reduce) {
    for (let i = 0; i < 400; i++) step();
    frame(0);
  } else start();

  let resizeT;
  addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      layout();
      if (reduce) frame(0);
    }, 150);
  });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}
