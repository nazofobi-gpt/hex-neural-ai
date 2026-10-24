import { expect, test, type Page } from "@playwright/test";

interface EditorMetrics {
  totalNodes: number;
  renderedNodes: number;
  renderMs: number;
  scale: number;
  zoomBand: string;
  viewportX: number;
  viewportY: number;
  selectedId: string | null;
  selectedQ: number | null;
  selectedR: number | null;
  adjacentFaceCount: number;
}

async function readMetrics(page: Page): Promise<EditorMetrics> {
  return page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;

    if (!metrics) {
      throw new Error("Editor metrics are not available");
    }

    return metrics;
  });
}

test("toolbar mutations are reflected in the live editor", async ({ page }) => {
  await page.goto("/");

  const status = page.locator(".toolbar").getByRole("status");
  await expect(status).toContainText("37 hexes");

  await page.getByRole("button", { name: "Add hex" }).click();
  await expect(status).toContainText("38 hexes");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(status).toContainText("37 hexes");

  const canvas = page.getByLabel(
    "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom. Use arrow keys to select nodes and Shift+arrow keys to move them.",
  );
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await expect(canvas).toBeFocused();
});

test("keyboard navigation selects and moves nodes without drag", async ({ page }) => {
  await page.goto("/");

  const canvas = page.getByLabel(
    "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom. Use arrow keys to select nodes and Shift+arrow keys to move them.",
  );
  await canvas.focus();
  await canvas.press("ArrowRight");

  let metrics = await readMetrics(page);
  expect(metrics.selectedId).toBe("hex-1");
  expect(metrics.selectedQ).toBe(-3);
  expect(metrics.selectedR).toBe(0);

  await canvas.press("Shift+ArrowLeft");
  metrics = await readMetrics(page);
  expect(metrics.selectedId).toBe("hex-1");
  expect(metrics.selectedQ).toBe(-4);
  expect(metrics.selectedR).toBe(0);

  const navigator = page.getByRole("navigation", { name: "Graph navigator" });
  await expect(navigator.locator("ol button")).toHaveCount(37);
  await expect(
    navigator.getByRole("button", { name: "Hex 1 at q -4, r 0" }),
  ).toHaveAttribute("aria-current", "true");
});

test("graph navigator retains focus and supports arrow selection", async ({ page }) => {
  await page.goto("/");

  const navigator = page.getByRole("navigation", { name: "Graph navigator" });
  const first = navigator.getByRole("button", { name: "Hex 1 at q -3, r 0" });
  await first.click();
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-current", "true");

  await first.press("ArrowRight");
  const selected = navigator.locator('button[aria-current="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeFocused();
  const metrics = await readMetrics(page);
  expect(metrics.selectedQ).toBe(-2);
  expect(metrics.selectedR).toBe(0);
});

test("2k graph navigator keeps DOM bounded while every node remains reachable", async ({ page }) => {
  await page.goto("/?benchmark=2107");
  const navigator = page.getByRole("navigation", { name: "Graph navigator" });
  const nodeButtons = navigator.locator("ol button");
  const next = navigator.getByRole("button", { name: "Next page" });
  const previous = navigator.getByRole("button", { name: "Previous page" });

  await expect(nodeButtons).toHaveCount(100);
  await expect(navigator.getByRole("status")).toContainText("Showing 1–100 of 2107 nodes");
  await expect(previous).toBeDisabled();

  await next.click();
  await expect(navigator.getByRole("status")).toContainText("Showing 101–200 of 2107 nodes");
  await expect(nodeButtons).toHaveCount(100);
  await navigator.getByRole("button", { name: "Last page" }).click();

  await expect(navigator.getByRole("status")).toContainText("Showing 2101–2107 of 2107 nodes");
  await expect(nodeButtons).toHaveCount(7);
  await expect(next).toBeDisabled();
  const lastNode = nodeButtons.last();
  await lastNode.click();
  await expect(lastNode).toHaveAttribute("aria-current", "true");
  await expect(lastNode).toBeFocused();
  const metrics = await readMetrics(page);
  expect(metrics.totalNodes).toBe(2107);
  expect(metrics.selectedId).toBe("hex-2107");

  await navigator.getByRole("button", { name: "First page" }).click();
  await expect(navigator.getByRole("status")).toContainText("Showing 1–100 of 2107 nodes");
  await expect(nodeButtons).toHaveCount(100);
});

test("graph navigator switches Turkish and English without losing selection", async ({ page }) => {
  await page.goto("/?benchmark=2107");
  const english = page.getByRole("navigation", { name: "Graph navigator" });
  await english.getByRole("combobox", { name: "Navigator language" }).selectOption("tr");

  const turkish = page.getByRole("navigation", { name: "Grafik gezgini" });
  await expect(turkish).toHaveAttribute("lang", "tr");
  await expect(page.getByRole("region", { name: "Hex düzenleyici" })).toHaveAttribute("lang", "tr");
  await expect(page.locator(".canvas-host canvas")).toHaveAttribute("aria-label", /Etkileşimli altıgen tuvali/);
  await expect(page.getByRole("region", { name: "Hex düzenleyici" })).toBeVisible();
  const turkishToolbar = page.getByRole("toolbar", { name: "Hex düzenleyici kontrolleri" });
  for (const label of ["Altıgen ekle", "Seçileni sil", "Geri al", "Yinele"]) {
    await expect(turkishToolbar.getByRole("button", { name: label })).toBeVisible();
  }
  await expect(page.locator(".hint")).toContainText("Altıgeni sürükleyerek yerleştirin");
  await expect(turkish.getByRole("status")).toContainText("1–100 / 2107 düğüm gösteriliyor");
  await turkish.getByRole("button", { name: "Sonraki sayfa" }).click();
  await expect(turkish.getByRole("status")).toContainText("101–200 / 2107 düğüm gösteriliyor");

  const node = turkish.getByRole("button", { name: /^Hex 101 konum q / });
  await node.click();
  await expect(node).toHaveAttribute("aria-current", "true");
  await turkish.getByRole("combobox", { name: "Gezgin dili" }).selectOption("en");

  const restored = page.getByRole("navigation", { name: "Graph navigator" });
  await expect(page.getByRole("region", { name: "Hex editor" })).toHaveAttribute("lang", "en");
  await expect(page.locator(".canvas-host canvas")).toHaveAttribute("aria-label", "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom. Use arrow keys to select nodes and Shift+arrow keys to move them.");
  await expect(page.getByRole("toolbar", { name: "Hex editor controls" })
    .getByRole("button", { name: "Add hex" })).toBeVisible();
  await expect(page.locator(".hint")).toContainText("Drag a hex to snap");
  await expect(restored.getByRole("button", { name: /^Hex 101 at q / }))
    .toHaveAttribute("aria-current", "true");
  await expect(restored.getByRole("status")).toContainText("Showing 101–200 of 2107 nodes");
});

test("benchmark status formats counts and render timing for English and Turkish", async ({ page }) => {
  await page.goto("/?benchmark=2107");
  const englishStatus = page.getByRole("toolbar", { name: "Hex editor controls" })
    .getByRole("status");
  await expect(englishStatus).toContainText("2,107 hexes");
  await expect(englishStatus).toContainText(/rendered [\d,]+\/2,107 · [\d,]+\.\dms/);

  await page.getByRole("navigation", { name: "Graph navigator" })
    .getByRole("combobox", { name: "Navigator language" }).selectOption("tr");
  const turkishStatus = page.getByRole("toolbar", { name: "Hex düzenleyici kontrolleri" })
    .getByRole("status");
  await expect(turkishStatus).toContainText("2.107 altıgen");
  await expect(turkishStatus).toContainText(/çizilen [\d.]+\/2\.107 · [\d.]+,\dms/);
});

test("editor live status follows Turkish and English without losing edits", async ({ page }) => {
  await page.goto("/");
  const navigator = page.getByRole("navigation", { name: "Graph navigator" });
  await navigator.getByRole("combobox", { name: "Navigator language" }).selectOption("tr");

  const status = page.getByRole("toolbar", { name: "Hex düzenleyici kontrolleri" })
    .getByRole("status");
  await expect(status).toContainText("Hazır · 37 altıgen");
  await page.getByRole("button", { name: "Altıgen ekle" }).click();
  await expect(status).toContainText("Eklendi · 38 altıgen");
  await page.getByRole("button", { name: "Geri al" }).click();
  await expect(status).toContainText("Geri alındı · 37 altıgen");

  await page.getByRole("navigation", { name: "Grafik gezgini" })
    .getByRole("combobox", { name: "Gezgin dili" }).selectOption("en");
  await expect(page.getByRole("toolbar", { name: "Hex editor controls" })
    .getByRole("status")).toContainText("Undo · 37 hexes");
});

test("mouse interactions select, drag-snap, undo/redo, pan, zoom and expose face adjacency", async ({
  page,
}) => {
  await page.goto("/");

  const canvas = page.getByLabel(
    "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom. Use arrow keys to select nodes and Shift+arrow keys to move them.",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;

  await page.mouse.click(centerX, centerY);
  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;
    return (
      metrics?.selectedQ === 0 &&
      metrics.selectedR === 0 &&
      metrics.adjacentFaceCount === 6
    );
  });

  let metrics = await readMetrics(page);
  expect(metrics.selectedQ).toBe(0);
  expect(metrics.selectedR).toBe(0);
  expect(metrics.adjacentFaceCount).toBe(6);

  const fourHexesRight = Math.sqrt(3) * 42 * 4;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + fourHexesRight, centerY, { steps: 1 });
  await page.mouse.up();

  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;
    return metrics?.selectedQ === 4 && metrics.selectedR === 0;
  });
  metrics = await readMetrics(page);
  expect(metrics.selectedQ).toBe(4);
  expect(metrics.selectedR).toBe(0);
  expect(metrics.adjacentFaceCount).toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;
    return metrics?.selectedQ === 0 && metrics.selectedR === 0;
  });

  await page.getByRole("button", { name: "Redo" }).click();
  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;
    return metrics?.selectedQ === 4 && metrics.selectedR === 0;
  });

  await page.getByRole("button", { name: "Undo" }).click();
  const beforePan = await readMetrics(page);

  const panX = box!.x + 40;
  const panY = box!.y + 40;
  await page.mouse.move(panX, panY);
  await page.mouse.down();
  await page.mouse.move(panX + 60, panY + 45, { steps: 1 });
  await page.mouse.up();

  const afterPan = await readMetrics(page);
  expect(afterPan.viewportX).toBeGreaterThan(beforePan.viewportX + 40);
  expect(afterPan.viewportY).toBeGreaterThan(beforePan.viewportY + 25);

  const scaleBeforeWheel = afterPan.scale;
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction(
    (previousScale) => {
      const metrics = (
        window as typeof window & {
          __HEX_EDITOR_METRICS__?: EditorMetrics;
        }
      ).__HEX_EDITOR_METRICS__;
      return metrics !== undefined && metrics.scale > previousScale;
    },
    scaleBeforeWheel,
  );
  const afterZoom = await readMetrics(page);
  expect(afterZoom.scale).toBeGreaterThan(scaleBeforeWheel);
});


test("compact 200%-equivalent viewport keeps keyboard navigator below the canvas", async ({ page }) => {
  // This checks responsive CSS at a reduced effective viewport, not manual browser zoom or AT acceptance.
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto("/");

  const canvasHost = page.locator(".canvas-host");
  const navigator = page.getByRole("navigation", { name: "Graph navigator" });
  await expect(navigator).toBeVisible();
  expect(await navigator.evaluate((element) => getComputedStyle(element).position)).toBe("relative");

  const canvasBox = await canvasHost.boundingBox();
  const navigatorBox = await navigator.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(navigatorBox).not.toBeNull();
  expect(navigatorBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height - 1);

  const first = navigator.getByRole("button", { name: "Hex 1 at q -3, r 0" });
  await first.click();
  await expect(first).toBeFocused();
  await first.press("ArrowRight");
  const selected = navigator.locator('button[aria-current="true"]');
  await expect(selected).toBeFocused();
  expect((await readMetrics(page)).selectedQ).toBe(-2);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("2k benchmark renders at least 2,000 visible hexes and captures evidence", async ({
  page,
}, testInfo) => {
  await page.goto("/?benchmark=2107");

  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: EditorMetrics;
      }
    ).__HEX_EDITOR_METRICS__;

    return (
      metrics !== undefined &&
      metrics.totalNodes === 2107 &&
      metrics.renderedNodes >= 2000
    );
  });

  const metrics = await readMetrics(page);

  expect(metrics.totalNodes).toBe(2107);
  expect(metrics.renderedNodes).toBeGreaterThanOrEqual(2000);
  expect(metrics.renderMs).toBeGreaterThanOrEqual(0);
  expect(metrics.scale).toBeGreaterThan(0);
  expect(metrics.zoomBand).toBe("overview");

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("benchmark-2107.png"),
    fullPage: true,
  });
  await testInfo.attach("benchmark-2107", {
    body: screenshot,
    contentType: "image/png",
  });

  console.log("G197_BENCHMARK", JSON.stringify(metrics));
});
