// Section backgrounds for the landing page. Each scene illustrates its section:
//   crowd   identical notes keep swapping places while an observer's lens finds nothing
//   merkle  a commitment joins the tree and its hash climbs to the root
//   cipher  hex columns decrypt into protocol words, then scramble again
// Scenes only animate while on screen; prefers-reduced-motion gets one still frame.
const TEAL = [124, 231, 208];
const BLUE = [106, 168, 255];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const HEX = "0123456789abcdef";
const rhex = (n) => Array.from({ length: n }, () => HEX[(Math.random() * 16) | 0]).join("");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Shared runner: sizing, DPR, resize, and start/stop when the canvas enters/leaves the viewport. */
export function runScene(canvas, scene) {
  const ctx = canvas.getContext("2d");
  const s = { ctx, w: 0, h: 0, t: 0 };
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    s.w = canvas.clientWidth;
    s.h = canvas.clientHeight;
    canvas.width = s.w * dpr;
    canvas.height = s.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene.layout(s);
  }
  let raf = 0;
  let visible = false;
  const loop = (now) => {
    s.t = now;
    scene.step?.(s);
    ctx.clearRect(0, 0, s.w, s.h);
    scene.draw(s);
    raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (reduce || raf || !visible || document.hidden) return;
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  size();
  if (reduce) {
    for (let i = 0; i < 300; i++) scene.step?.(Object.assign(s, { t: i * 16 }));
    scene.draw(s);
  }
  new IntersectionObserver(([e]) => ((visible = e.isIntersecting), visible ? start() : stop())).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      size();
      if (reduce) scene.draw(s);
    }, 150);
  });
  return { start, stop };
}

// ---------------------------------------------------------------- crowd
export const crowd = () => {
  let dots = [];
  let lens = { x: 0, y: 0, tx: 0, ty: 0 };
  let nextSwap = 0;
  let nextLens = 0;
  return {
    layout(s) {
      const gap = s.w < 700 ? 34 : 42;
      dots = [];
      for (let y = gap; y < s.h - gap / 2; y += gap)
        for (let x = gap; x < s.w - gap / 2; x += gap) {
          const jx = x + (Math.random() - 0.5) * 12;
          const jy = y + (Math.random() - 0.5) * 12;
          dots.push({ x: jx, y: jy, tx: jx, ty: jy, ph: Math.random() * 6 });
        }
      lens = { x: s.w * 0.3, y: s.h * 0.5, tx: s.w * 0.6, ty: s.h * 0.4 };
    },
    step(s) {
      if (s.t > nextSwap && dots.length > 2) {
        // swap a few pairs: who is where keeps changing
        for (let k = 0; k < 6; k++) {
          const a = dots[(Math.random() * dots.length) | 0];
          const b = dots[(Math.random() * dots.length) | 0];
          [a.tx, b.tx] = [b.tx, a.tx];
          [a.ty, b.ty] = [b.ty, a.ty];
        }
        nextSwap = s.t + 700;
      }
      if (s.t > nextLens) {
        lens.tx = s.w * (0.15 + Math.random() * 0.7);
        lens.ty = s.h * (0.2 + Math.random() * 0.6);
        nextLens = s.t + 2600;
      }
      for (const d of dots) {
        d.x += (d.tx - d.x) * 0.04;
        d.y += (d.ty - d.y) * 0.04;
      }
      lens.x += (lens.tx - lens.x) * 0.02;
      lens.y += (lens.ty - lens.y) * 0.02;
    },
    draw({ ctx, w, h, t }) {
      const R = Math.min(w, h) * 0.16;
      for (const d of dots) {
        const inLens = Math.hypot(d.x - lens.x, d.y - lens.y) < R;
        const p = 0.5 + 0.5 * Math.sin(t / 1200 + d.ph);
        ctx.fillStyle = rgba(inLens ? TEAL : BLUE, inLens ? 0.55 : 0.12 + 0.1 * p);
        ctx.beginPath();
        ctx.arc(d.x, d.y, inLens ? 2.6 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // the observer's lens: every note it looks at is the same
      ctx.strokeStyle = rgba(TEAL, 0.35);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(lens.x, lens.y, R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.arc(lens.x, lens.y, R * 1.15, t / 3000, t / 3000 + Math.PI * 1.4);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(lens.x + R * 0.7, lens.y + R * 0.7);
      ctx.lineTo(lens.x + R * 1.05, lens.y + R * 1.05);
      ctx.stroke();
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.fillStyle = rgba(TEAL, 0.5);
      ctx.fillText("observer: match = ?", lens.x - R * 0.55, lens.y - R - 10);
    },
  };
};

// ---------------------------------------------------------------- merkle
export const merkle = () => {
  const LEAVES = 16;
  let nodes = []; // levels[0] = leaves
  let filled = 0;
  let pulse = null; // { level, idx, at }
  let next = 0;
  let root = rhex(8);
  return {
    layout(s) {
      const levels = Math.log2(LEAVES) + 1;
      const top = s.h * 0.12;
      const bottom = s.h * 0.88;
      const width = Math.min(s.w * 0.86, 1100);
      const x0 = (s.w - width) / 2;
      nodes = [];
      for (let l = 0; l < levels; l++) {
        const count = LEAVES >> l;
        const y = bottom - ((bottom - top) / (levels - 1)) * l;
        nodes.push(Array.from({ length: count }, (_, i) => ({ x: x0 + (width / count) * (i + 0.5), y, lit: 0 })));
      }
      filled = 3;
      for (let i = 0; i < filled; i++) nodes[0][i].lit = 1;
    },
    step(s) {
      if (!pulse && s.t > next) {
        if (filled >= LEAVES) {
          filled = 0;
          nodes.forEach((lv) => lv.forEach((n) => (n.lit = 0)));
        }
        pulse = { level: 0, idx: filled, at: s.t };
        nodes[0][filled].lit = 1;
        filled++;
      }
      if (pulse && s.t - pulse.at > 380) {
        if (pulse.level < nodes.length - 1) {
          pulse = { level: pulse.level + 1, idx: pulse.idx >> 1, at: s.t };
          nodes[pulse.level][pulse.idx].lit = 1;
        } else {
          root = rhex(8);
          pulse = null;
          next = s.t + 900;
        }
      }
      nodes.forEach((lv) => lv.forEach((n) => (n.lit = Math.max(0.25 * (n.lit > 0), n.lit - 0.004))));
    },
    draw({ ctx, w }) {
      ctx.lineWidth = 1;
      for (let l = 1; l < nodes.length; l++)
        nodes[l].forEach((p, i) => {
          for (const c of [nodes[l - 1][i * 2], nodes[l - 1][i * 2 + 1]]) {
            const hot = pulse && pulse.level === l && pulse.idx === i;
            ctx.strokeStyle = rgba(TEAL, hot ? 0.6 : 0.08 + 0.2 * Math.min(p.lit, c.lit));
            ctx.beginPath();
            ctx.moveTo(c.x, c.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
        });
      ctx.font = "10px ui-monospace, Menlo, monospace";
      nodes.forEach((lv, l) =>
        lv.forEach((n, i) => {
          const hot = pulse && pulse.level === l && pulse.idx === i;
          ctx.fillStyle = rgba(hot ? TEAL : BLUE, hot ? 0.95 : 0.15 + 0.45 * n.lit);
          ctx.beginPath();
          ctx.arc(n.x, n.y, hot ? 4.5 : l === nodes.length - 1 ? 4 : 2.6, 0, Math.PI * 2);
          ctx.fill();
          if (hot) {
            ctx.strokeStyle = rgba(TEAL, 0.35);
            ctx.beginPath();
            ctx.arc(n.x, n.y, 10, 0, Math.PI * 2);
            ctx.stroke();
          }
        }),
      );
      const r = nodes[nodes.length - 1][0];
      ctx.fillStyle = rgba(TEAL, 0.55);
      ctx.fillText(`root 0x${root}…`, r.x + 10, r.y + 4);
      if (w > 700 && pulse?.level === 0) {
        const n = nodes[0][pulse.idx];
        ctx.fillText("commitment", n.x - 30, n.y + 18);
      }
    },
  };
};

// ---------------------------------------------------------------- cipher
const WORDS = ["nullifier", "commitment", "poseidon", "groth16", "merkle_root", "asp_root", "label", "secret", "withdraw", "ragequit", "zk-snark", "scope"];
export const cipher = () => {
  let cols = [];
  return {
    layout(s) {
      const cw = s.w < 700 ? 18 : 22;
      cols = Array.from({ length: Math.floor(s.w / cw) }, (_, i) => ({
        x: i * cw + 6,
        y: Math.random() * s.h,
        v: 0.25 + Math.random() * 0.5,
        word: null,
        until: 0,
        chars: rhex(18).split(""),
      }));
    },
    step(s) {
      for (const c of cols) {
        c.y += c.v;
        if (c.y > s.h + 30) c.y = -18 * 22;
        if (!c.word && Math.random() < 0.0015) {
          c.word = WORDS[(Math.random() * WORDS.length) | 0];
          c.until = s.t + 2200;
        }
        if (c.word && s.t > c.until) c.word = null;
        if (Math.random() < 0.1) c.chars[(Math.random() * c.chars.length) | 0] = HEX[(Math.random() * 16) | 0];
      }
    },
    draw({ ctx, t }) {
      ctx.font = "12px ui-monospace, Menlo, monospace";
      for (const c of cols) {
        const n = c.chars.length;
        for (let i = 0; i < n; i++) {
          let ch = c.chars[i];
          let a = (i / n) * 0.1;
          let col = TEAL;
          if (c.word) {
            // decrypt: the word settles in from the bottom of the column
            const k = i - (n - c.word.length);
            const settle = Math.min(1, 1 - (c.until - t) / 2200 + 0.2);
            if (k >= 0 && k / c.word.length < settle * 1.5) {
              ch = c.word[k];
              a = 0.55;
              col = BLUE;
            }
          }
          ctx.fillStyle = rgba(col, a);
          ctx.fillText(ch, c.x, c.y + i * 18);
        }
      }
    },
  };
};
