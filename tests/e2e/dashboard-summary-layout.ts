import { expect, type Page, type TestInfo } from "@playwright/test";

export async function verifyDashboardSummaryLayout(page: Page, info: TestInfo, width: number): Promise<void> {
  const strip = page.locator(".dv-summary-strip");
  await expect(strip.locator("a.dv-summary-card")).toHaveCount(5);
  const layout = await strip.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, left: bounds.left, right: bounds.right, overflow: element.scrollWidth > element.clientWidth + 1,
      cards: [...element.querySelectorAll<HTMLElement>(".dv-summary-card")].map(card => {
        const box = card.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
          clipped: [...card.querySelectorAll<HTMLElement>(".dv-summary-top,.dv-summary-count,.dv-summary-cue,.dv-task-mix-label")].some(text => text.scrollWidth > text.clientWidth + 1) };
      }) };
  });
  expect(layout.overflow).toBe(false);
  for (const card of layout.cards) {
    expect(card.x).toBeGreaterThanOrEqual(layout.left - 1);
    expect(card.right).toBeLessThanOrEqual(layout.right + 1);
    expect(card.width).toBeGreaterThanOrEqual(Math.min(200, layout.width) - 1);
    expect(card.clipped).toBe(false);
    expect(card.height).toBeGreaterThanOrEqual(44);
  }
  for (let i = 0; i < layout.cards.length; i++) for (let j = i + 1; j < layout.cards.length; j++) {
    const a = layout.cards[i]!, b = layout.cards[j]!;
    expect(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1).toBe(true);
  }
  if (width <= 600) expect(new Set(layout.cards.map(card => Math.round(card.x))).size).toBe(1);
  await strip.screenshot({ path: info.outputPath(`dashboard-summaries-${width}.png`) });
}
