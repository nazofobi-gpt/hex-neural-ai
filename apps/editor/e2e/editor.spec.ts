import { expect, test } from "@playwright/test";

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
});

test("2k benchmark renders at least 2,000 visible hexes and captures evidence", async ({
  page,
}, testInfo) => {
  await page.goto("/?benchmark=2107");

  await page.waitForFunction(() => {
    const metrics = (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: {
          totalNodes: number;
          renderedNodes: number;
        };
      }
    ).__HEX_EDITOR_METRICS__;

    return (
      metrics !== undefined &&
      metrics.totalNodes === 2107 &&
      metrics.renderedNodes >= 2000
    );
  });

  const metrics = await page.evaluate(() => {
    return (
      window as typeof window & {
        __HEX_EDITOR_METRICS__?: {
          totalNodes: number;
          renderedNodes: number;
          renderMs: number;
          scale: number;
          zoomBand: string;
        };
      }
    ).__HEX_EDITOR_METRICS__;
  });

  expect(metrics).toBeDefined();
  expect(metrics!.totalNodes).toBe(2107);
  expect(metrics!.renderedNodes).toBeGreaterThanOrEqual(2000);
  expect(metrics!.renderMs).toBeGreaterThanOrEqual(0);
  expect(metrics!.scale).toBeGreaterThan(0);
  expect(metrics!.zoomBand).toBe("overview");

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
