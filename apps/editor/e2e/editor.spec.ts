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

interface ClusterMetrics {
  scale: number;
  visibleNodeIds: string[];
  visibleConnectionCount: number;
  collapseLevel: 0 | 1 | 2;
  semanticCollapseLevel: 0 | 1 | 2;
  manualCollapseLevel: 0 | 1 | 2;
  revision: number;
  identityFingerprint: string;
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

async function readClusterMetrics(page: Page): Promise<ClusterMetrics> {
  return page.evaluate(() => {
    const metrics = (
      window as typeof window & {
        __HEX_CLUSTER_METRICS__?: ClusterMetrics;
      }
    ).__HEX_CLUSTER_METRICS__;

    if (!metrics) {
      throw new Error("Cluster metrics are not available");
    }

    return metrics;
  });
}

test("toolbar mutations are reflected in the live editor", async ({ page }) => {
  await page.goto("/");

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
  await page.goto("/");

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

test("recursive cluster collapse, undo/redo and semantic zoom preserve identity", async ({
  page,
}, testInfo) => {
  await page.goto("/?clusterDemo=1");

  const status = page.getByRole("status");
  await expect(status).toContainText("Cluster detail");
  let metrics = await readClusterMetrics(page);
  const identity = metrics.identityFingerprint;

  expect(metrics.collapseLevel).toBe(0);
  expect(metrics.visibleNodeIds).toHaveLength(13);
  expect(metrics.visibleConnectionCount).toBe(12);

  await page.getByRole("button", { name: "Collapse cluster" }).click();
  await expect(status).toContainText("Cluster nested");
  metrics = await readClusterMetrics(page);
  expect(metrics.collapseLevel).toBe(1);
  expect(metrics.visibleNodeIds).toHaveLength(7);
  expect(metrics.visibleNodeIds).toContain("cluster-inner");
  expect(metrics.identityFingerprint).toBe(identity);

  await page.getByRole("button", { name: "Collapse cluster" }).click();
  await expect(status).toContainText("Cluster application");
  metrics = await readClusterMetrics(page);
  expect(metrics.collapseLevel).toBe(2);
  expect(metrics.visibleNodeIds).toEqual(["cluster-root"]);
  expect(metrics.identityFingerprint).toBe(identity);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(status).toContainText("Cluster nested");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(status).toContainText("Cluster application");

  await page.getByRole("button", { name: "Expand cluster" }).click();
  await page.getByRole("button", { name: "Expand cluster" }).click();
  await expect(status).toContainText("Cluster detail");
  metrics = await readClusterMetrics(page);
  expect(metrics.manualCollapseLevel).toBe(0);
  expect(metrics.identityFingerprint).toBe(identity);

  const canvas = page.getByLabel(
    "Recursive cluster semantic zoom canvas",
  );
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(
    box!.x + box!.width / 2,
    box!.y + box!.height / 2,
  );

  for (let index = 0; index < 10; index += 1) {
    await page.mouse.wheel(0, 300);
  }

  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_CLUSTER_METRICS__?: ClusterMetrics;
      }
    ).__HEX_CLUSTER_METRICS__;
    return metrics?.semanticCollapseLevel === 2;
  });

  metrics = await readClusterMetrics(page);
  expect(metrics.collapseLevel).toBe(2);
  expect(metrics.manualCollapseLevel).toBe(0);
  expect(metrics.visibleNodeIds).toEqual(["cluster-root"]);
  expect(metrics.identityFingerprint).toBe(identity);

  const screenshot = await page.screenshot({
    path: testInfo.outputPath("recursive-cluster-overview.png"),
    fullPage: true,
  });
  await testInfo.attach("recursive-cluster-overview", {
    body: screenshot,
    contentType: "image/png",
  });

  console.log("G199_CLUSTER", JSON.stringify(metrics));
});
