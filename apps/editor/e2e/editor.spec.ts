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

async function enterBuilder(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: "Create guided project" }).click();
  await page.getByRole("button", { name: "Enter builder" }).click();
  await expect(page.getByRole("heading", { name: "Builder", exact: true })).toBeVisible();
}

test("toolbar mutations are reflected in the live editor", async ({ page }) => {
  await enterBuilder(page);

  const status = page.getByRole("status");
  await expect(status).toContainText("37 hexes");

  await page.getByRole("button", { name: "Add hex" }).click();
  await expect(status).toContainText("38 hexes");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(status).toContainText("37 hexes");

  const canvas = page.getByLabel(
    "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom.",
  );
  await expect(canvas).toBeVisible();
  await canvas.focus();
  await expect(canvas).toBeFocused();
});

test("mouse interactions select, drag-snap, undo/redo, pan, zoom and expose face adjacency", async ({
  page,
}) => {
  await enterBuilder(page);

  const canvas = page.getByLabel(
    "Interactive hex canvas. Drag hexes, drag empty canvas to pan, and use the mouse wheel to zoom.",
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

test("2k benchmark renders at least 2,000 visible hexes and captures evidence", async ({
  page,
}, testInfo) => {
  await enterBuilder(page, "/?benchmark=2107");

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
