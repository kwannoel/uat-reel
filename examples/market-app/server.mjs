// A two-role demo app for multi-actor storyboards: a buyer orders tea, a seller refunds it.
// State lives in memory; POST /reset clears it. Run: node examples/market-app/server.mjs [port]
import http from "node:http";

const layout = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #f6f7f9; color: #1b1f24; }
header { background: #234; color: #fff; padding: 14px 32px; display: flex; justify-content: space-between; }
main { padding: 32px; display: grid; gap: 20px; max-width: 760px; }
.panel { background: #fff; border: 1px solid #dde2ea; border-radius: 8px; padding: 20px; display: grid; gap: 12px; }
label { display: grid; gap: 4px; font-weight: 600; }
input, select { font: inherit; padding: 8px 10px; border: 1px solid #b8c0cc; border-radius: 6px; }
button { font: inherit; padding: 9px 16px; border-radius: 6px; border: 0; background: #2459d6; color: #fff; justify-self: start; cursor: pointer; }
</style></head><body>${body}</body></html>`;

const roleOf = (req) => /(?:^|;\s*)role=(buyer|seller)/.exec(req.headers.cookie ?? "")?.[1] ?? null;

export function startMarketApp(port = 0) {
  let order = null;
  let seq = 1000;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const role = roleOf(req);
    const send = (html) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const redirect = (to, cookie) => {
      res.writeHead(303, { location: to, ...(cookie ? { "set-cookie": cookie } : {}) });
      res.end();
    };
    if (url.pathname === "/reset" && req.method === "POST") {
      order = null;
      seq = 1000;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/sign-in" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("password") !== "demo-password") return redirect("/sign-in?failed=1");
        const who = form.get("email") === "sam@example.com" ? "seller" : "buyer";
        redirect(who === "seller" ? "/orders" : "/", `role=${who}; Path=/; HttpOnly`);
      });
      return;
    }
    if (url.pathname === "/sign-in")
      return send(layout("Sign in", `<main><form class="panel" method="post" action="/sign-in">
<label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label>
<button>Sign in</button></form></main>`));
    if (!role) return redirect("/sign-in");
    const header = `<header><b>Demo Market</b><span>${role === "buyer" ? "Ana (buyer)" : "Sam (seller)"}</span></header>`;
    if (url.pathname === "/place" && role === "buyer") {
      const quantity = Number(url.searchParams.get("quantity") ?? "1");
      order = { number: `ORD-${++seq}`, quantity, total: quantity * 12.5, refunded: false };
      return redirect(`/orders/${order.number}`);
    }
    if (url.pathname === "/refund" && role === "seller" && order) {
      // Slow on purpose, so recordings show a jump cut.
      setTimeout(() => {
        order.refunded = true;
        redirect("/orders");
      }, 1800);
      return;
    }
    if (url.pathname === "/" && role === "buyer")
      return send(layout("Shop", `${header}<main><form class="panel" action="/place">
<h2>Green tea, 1 kg</h2><p>$12.50 each</p>
<label>Quantity <select name="quantity"><option>1</option><option>2</option><option>3</option></select></label>
<button>Place order</button></form></main>`));
    if (url.pathname.startsWith("/orders/") && role === "buyer" && order)
      return send(layout("Order", `${header}<main><section class="panel">
<h2>Order <span data-testid="order-number">${order.number}</span></h2>
<p>${order.quantity} × Green tea · $${order.total.toFixed(2)}</p>
<p data-testid="status"><b>${order.refunded ? `Refunded $${order.total.toFixed(2)}` : "Paid"}</b></p></section></main>`));
    if (url.pathname === "/orders" && role === "seller")
      return send(layout("Orders", `${header}<main><section class="panel" data-testid="seller-orders">
${order ? `<h2>${order.number} · Ana</h2><p>${order.quantity} × Green tea · $${order.total.toFixed(2)}</p>
<p data-testid="seller-status"><b>${order.refunded ? "Refunded" : "Paid"}</b></p>
${order.refunded ? "" : `<form action="/refund"><button>Refund ${order.number}</button></form>`}` : "<p>No orders yet.</p>"}
</section></main>`));
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await startMarketApp(Number(process.argv[2] ?? 4599));
  console.log(`market app on ${app.url}`);
}
