// Frame times and long tasks for the fleet stage. Paste into a browser console (or run through a browser
// automation eval) with the page open; it returns a JSON string. Repeat at 390 px with CPU throttling.
(async () => {
  const run = async (label, action) => {
    const frames = [];
    const longs = [];
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longs.push(Math.round(e.duration));
    });
    po.observe({ entryTypes: ["longtask"] });
    let last = performance.now(),
      on = true;
    const tick = (t) => {
      frames.push(t - last);
      last = t;
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await action();
    await new Promise((r) => setTimeout(r, 3000));
    on = false;
    po.disconnect();
    frames.shift();
    const s = [...frames].sort((a, b) => a - b);
    return {
      label,
      frames: frames.length,
      avg: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(2),
      p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
      max: +s.at(-1).toFixed(1),
      over20: frames.filter((f) => f > 20).length,
      longtasks: longs,
    };
  };
  const click = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(text))?.click();
  const sweep = async () => {
    const canvas = document.querySelector("canvas[role=img]");
    const box = canvas.getBoundingClientRect();
    for (let step = 0; step < 60; step++) {
      const init = {
        bubbles: true,
        clientX: box.left + box.width * (0.15 + 0.7 * (step / 60)),
        clientY: box.top + box.height * (0.25 + 0.5 * (step / 60)),
      };
      canvas.dispatchEvent(new PointerEvent("pointermove", init));
      await new Promise((r) => setTimeout(r, 16));
    }
  };
  document.documentElement.style.scrollBehavior = "auto";
  const out = [];
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 7000));
  out.push(await run("hero, idle", async () => {}));
  out.push(await run("hero, wave of 48", async () => click("Wake 48")));
  await new Promise((r) => setTimeout(r, 7000));
  out.push(await run("sweep across the grid", sweep));
  document.getElementById("fleet").scrollIntoView();
  await new Promise((r) => setTimeout(r, 7000));
  out.push(await run("fleet, wave of 48", async () => click("Send a wave")));
  return JSON.stringify(out);
})();
