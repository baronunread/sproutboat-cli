/** The contract of the showcase's two apps, as HTTP requests. Run against any running copy (dev, workerd, a binary). */

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`check failed: ${what}`);
  console.log(`  ok  ${what}`);
}

/** The page's own app: static files, /healthz, and where each section's live data is. */
export async function checkShowcase(base: string): Promise<void> {
  expect((await fetch(base + "/healthz")).ok, "/healthz answers");
  const page = await fetch(base + "/");
  expect(page.ok && (await page.text()).includes('<div id="root">'), "/ serves the page");
  expect((await fetch(base + "/assets/main.js")).ok, "/assets/main.js is served");
  const info = await (await fetch(base + "/api/info")).json();
  expect("edition" in info && "fleet" in info, "/api/info says where the live data is");
  expect((await fetch(base + "/api/nope")).status === 404, "an unknown /api route is a 404");
}

/**
 * One app of the fleet: the first request a process serves says cold, and no later one does. The harness has
 * already sent a request to see that the server is up, so this cannot assume it is the first.
 */
export async function checkFleetApp(base: string): Promise<void> {
  const first = await fetch(base + "/");
  expect(first.headers.get("access-control-allow-origin") === "*", "the fleet app can be called from any page");
  const one = await first.json();
  const two = await (await fetch(base + "/")).json();
  expect(one.cold === (one.served === 1), "only the first request a process serves is cold");
  expect(two.cold === false && two.served === one.served + 1, "the next request is counted and is not cold");
}
