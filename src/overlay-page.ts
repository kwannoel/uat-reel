/**
 * Runs inside the page (serialized into a context init script), so it must not
 * reference anything outside its own body. Installs `window.__uatReel`.
 */
export function installOverlay(args: { driverCss: string }): void {
  const w = window as unknown as Record<string, any>;
  if (w.__uatReel) return;

  const Z = "2147483647";
  const css = `
    #uat-reel-box { position: fixed; pointer-events: none; z-index: ${Z}; box-sizing: border-box;
      border-radius: 6px; transition: opacity 120ms ease; }
    #uat-reel-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; pointer-events: none;
      z-index: ${Z}; transition-property: transform; transition-timing-function: cubic-bezier(.4,0,.2,1);
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
    .uat-reel-ripple { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
      pointer-events: none; z-index: ${Z}; animation: uat-reel-ripple 520ms ease-out forwards; }
    @keyframes uat-reel-ripple { from { transform: scale(1); opacity: .9 } to { transform: scale(4.5); opacity: 0 } }
    #uat-reel-chip { position: fixed; top: 12px; left: 12px; z-index: ${Z}; pointer-events: none;
      font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
      background: rgba(17,17,17,.78); padding: 6px 10px; border-radius: 999px; letter-spacing: .01em; }
    .uat-reel-popover.driver-popover { border-top: 4px solid var(--uat-reel-color, #ff1f3d); max-width: 320px; }
    .uat-reel-popover .driver-popover-title { font: 700 16px/1.3 system-ui, -apple-system, sans-serif; }
    .uat-reel-popover .driver-popover-title:empty { display: none !important; }
    .uat-reel-popover .driver-popover-description { font: 400 14px/1.4 system-ui, -apple-system, sans-serif; }
    .uat-reel-popover .driver-popover-footer, .uat-reel-popover .driver-popover-close-btn { display: none !important; }
  `;

  let box: HTMLDivElement | null = null;
  let proxy: HTMLDivElement | null = null;
  let cursor: HTMLDivElement | null = null;
  let chip: HTMLDivElement | null = null;
  let tracking = 0;
  let drv: { destroy(): void } | null = null;

  function ready(): Promise<void> {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  }

  function ensureStyles() {
    if (document.getElementById("uat-reel-style")) return;
    const style = document.createElement("style");
    style.id = "uat-reel-style";
    style.textContent = args.driverCss + css;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function el<T extends HTMLElement>(id: string, tag = "div"): T {
    let node = document.getElementById(id) as T | null;
    if (!node) {
      node = document.createElement(tag) as T;
      node.id = id;
      document.body.appendChild(node);
    }
    return node;
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The rect worth framing. A non-interactive element whose content is much narrower than its box
   * (right-aligned text in a full-width paragraph, say) is framed around the content instead.
   */
  function frameRect(target: Element): DOMRect {
    const r = target.getBoundingClientRect();
    if (target.matches("button, input, select, textarea, a, label, img, svg, video, canvas, [role=button], [role=link]")) return r;
    const range = document.createRange();
    range.selectNodeContents(target);
    const c = range.getBoundingClientRect();
    return c.width > 0 && c.height > 0 && c.width < r.width * 0.6 ? c : r;
  }

  async function highlight(
    target: Element,
    opts: { label?: string; note?: string; color: string; width: number; padding: number; dim: number },
  ) {
    await ready();
    ensureStyles();
    clear();
    document.documentElement.style.setProperty("--uat-reel-color", opts.color);

    // driver.js spotlights a fixed proxy that tracks frameRect, so the dimmed stage and the red box agree.
    proxy = el<HTMLDivElement>("uat-reel-target");
    proxy.style.cssText = "position:fixed;pointer-events:none;background:transparent;";
    box = el<HTMLDivElement>("uat-reel-box");
    box.style.border = `${opts.width}px solid ${opts.color}`;
    box.style.boxShadow = `0 0 0 2px rgba(255,255,255,.85), 0 0 18px ${opts.color}66`;
    box.style.opacity = "1";
    const pad = opts.padding + opts.width;
    const place = () => {
      if (!box || !proxy) return;
      const r = frameRect(target);
      proxy.style.left = `${r.left}px`;
      proxy.style.top = `${r.top}px`;
      proxy.style.width = `${r.width}px`;
      proxy.style.height = `${r.height}px`;
      box.style.left = `${r.left - pad}px`;
      box.style.top = `${r.top - pad}px`;
      box.style.width = `${r.width + pad * 2}px`;
      box.style.height = `${r.height + pad * 2}px`;
      tracking = requestAnimationFrame(place);
    };
    place();

    const driverNs = w.driver?.js;
    const popover = opts.label || opts.note;
    if (driverNs && (opts.dim > 0 || popover)) {
      drv = driverNs.driver({
        animate: true,
        smoothScroll: false,
        allowClose: false,
        overlayClickBehavior: "none",
        overlayOpacity: opts.dim,
        overlayColor: "#000",
        stagePadding: opts.padding,
        stageRadius: 6,
        popoverClass: "uat-reel-popover",
        showButtons: [],
      });
      (drv as any).highlight({
        element: proxy,
        popover: popover ? { title: opts.label ?? "", description: opts.note ?? "", side: "bottom", align: "start" } : undefined,
      });
    }
    // Let driver.js finish its stage animation before the caller starts the hold.
    await sleep(opts.dim > 0 || popover ? 350 : 60);
    const r = frameRect(target);
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function clear() {
    cancelAnimationFrame(tracking);
    drv?.destroy();
    drv = null;
    box?.remove();
    box = null;
    proxy?.remove();
    proxy = null;
  }

  async function cursorTo(x: number, y: number, ms: number) {
    await ready();
    ensureStyles();
    cursor = el<HTMLDivElement>("uat-reel-cursor");
    if (!cursor.firstChild) {
      cursor.innerHTML =
        '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11-6.6 1.2L16 22l-3 1.4-3.6-7.9L4 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    }
    cursor.style.transitionDuration = `${ms}ms`;
    // The arrow tip sits at (4,2) inside the 24-unit viewBox.
    cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
    await sleep(ms);
  }

  function placeCursor(x: number, y: number) {
    if (!document.body) return;
    ensureStyles();
    cursor = el<HTMLDivElement>("uat-reel-cursor");
    if (!cursor.firstChild) void cursorTo(x, y, 0);
    cursor.style.transitionDuration = "0ms";
    cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
  }

  function ripple(x: number, y: number, color: string) {
    if (!document.body) return;
    const dot = document.createElement("div");
    dot.className = "uat-reel-ripple";
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    dot.style.background = color;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }

  function setChip(text: string | null) {
    if (!document.body) return;
    ensureStyles();
    if (!text) {
      chip?.remove();
      chip = null;
      return;
    }
    chip = el<HTMLDivElement>("uat-reel-chip");
    chip.textContent = text;
  }

  w.__uatReel = { highlight, clear, cursorTo, placeCursor, ripple, setChip, ready };
}
