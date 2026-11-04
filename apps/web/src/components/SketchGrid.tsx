// Graph paper and box grid for the Conceptual Sketch look. One canvas draws both the paper lines and
// the square under the mouse, from the same device-pixel-snapped line positions, so they line up at
// every browser zoom level (CSS backgrounds round each tile separately and drift when zoomed). The
// square tints (darker on light paper, lighter on dark) and fades after the pointer leaves it. The
// canvas paints behind the content only (its parent isolates a stacking context), never takes pointer
// events, is hidden from assistive tech, ignores touch, and with reduced motion lights the current
// square without a trail. While it runs, the host's CSS graph paper is switched off (index.css).
import { useEffect, useRef } from 'react';

const CELL = 22; // CSS px, the same as the fallback background-size in index.css
const FADE_MS = 900;

export function SketchGrid() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;
    host.dataset.sketchGrid = 'canvas';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Cells are keyed by column/row from the host's corner, so they move with the page on scroll.
    const fading = new Map<string, { c: number; r: number; t: number }>();
    let current: { c: number; r: number } | null = null;
    let raf = 0;
    let dpr = window.devicePixelRatio || 1;

    /** Position of grid line k from origin o, snapped to a whole device pixel. */
    const snap = (o: number, k: number) => Math.round((o + k * CELL) * dpr) / dpr;

    const draw = (now: number) => {
      raf = 0;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const rect = host.getBoundingClientRect();
      const x0 = Math.max(rect.left, 0);
      const y0 = Math.max(rect.top, 0);
      const x1 = Math.min(rect.right, w);
      const y1 = Math.min(rect.bottom, h);
      if (x1 <= x0 || y1 <= y0) return;
      const line = Math.max(1, Math.round(dpr)) / dpr; // about 1 CSS px, whole device pixels
      const style = getComputedStyle(host);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();

      // Paper: a line on the top and left edge of every cell.
      ctx.fillStyle = style.getPropertyValue('--sketch-grid').trim() || 'transparent';
      for (let k = Math.floor((x0 - rect.left) / CELL); snap(rect.left, k) < x1; k++) {
        ctx.fillRect(snap(rect.left, k), y0, line, y1 - y0);
      }
      for (let k = Math.floor((y0 - rect.top) / CELL); snap(rect.top, k) < y1; k++) {
        ctx.fillRect(x0, snap(rect.top, k), x1 - x0, line);
      }

      // Lit squares fill exactly the inside of a cell, between its snapped lines.
      ctx.fillStyle = style.getPropertyValue('--sketch-cell').trim() || 'transparent';
      const paint = (c: number, r: number, alpha: number) => {
        const left = snap(rect.left, c) + line;
        const top = snap(rect.top, r) + line;
        ctx.globalAlpha = alpha;
        ctx.fillRect(left, top, snap(rect.left, c + 1) - left, snap(rect.top, r + 1) - top);
      };
      for (const [key, cell] of fading) {
        const left = 1 - (now - cell.t) / FADE_MS;
        if (left <= 0) fading.delete(key);
        else paint(cell.c, cell.r, left * left);
      }
      if (current) paint(current.c, current.r, 1);
      ctx.restore();
      if (fading.size) raf = requestAnimationFrame(draw);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    // Browser zoom changes devicePixelRatio; resize the backing store and redraw at the new scale.
    let zoom: MediaQueryList | null = null;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      ctx.setTransform(canvas.width / canvas.clientWidth, 0, 0, canvas.height / canvas.clientHeight, 0, 0);
      zoom?.removeEventListener('change', resize);
      zoom = window.matchMedia(`(resolution: ${dpr}dppx)`);
      zoom.addEventListener('change', resize);
      schedule();
    };

    const release = () => {
      if (current && !reduce.matches) {
        fading.set(`${current.c},${current.r}`, { ...current, t: performance.now() });
      }
      current = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const rect = host.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom;
      // Same snapped lines as the drawing, so the lit cell is the one under the pointer.
      const cellOf = (o: number, p: number) => {
        let k = Math.floor((p - o) / CELL);
        if (p < snap(o, k)) k -= 1;
        else if (p >= snap(o, k + 1)) k += 1;
        return k;
      };
      const next = inside ? { c: cellOf(rect.left, e.clientX), r: cellOf(rect.top, e.clientY) } : null;
      if (next?.c === current?.c && next?.r === current?.r) return;
      release();
      if (next) {
        fading.delete(`${next.c},${next.r}`);
        current = next;
      }
      schedule();
    };
    const onLeave = () => {
      release();
      schedule();
    };

    // Redraw when the host moves or resizes, or the theme class changes the colours.
    const sized = new ResizeObserver(schedule);
    sized.observe(host);
    const themed = new MutationObserver(schedule);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      sized.disconnect();
      themed.disconnect();
      zoom?.removeEventListener('change', resize);
      delete host.dataset.sketchGrid;
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 size-full" />
  );
}
