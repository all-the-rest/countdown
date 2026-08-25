// Generic manifest-driven screenshot spec for the ui-review skill.
//
// Reads the route/state/viewport matrix from the manifest and captures a
// full-page PNG PER COMBO plus viewport-height SECTION captures of the whole
// page (see `captureSections`). This file is intentionally generic — route
// specifics (nav steps) live in the manifest.
//
// WHY SECTIONS: Full-page PNGs of long pages get downscaled for the vision
// model — regions below the fold become unreadable and bugs there are missed.
// `captureSections` scrolls the whole page in 80 %-viewport steps (20 % overlap)
// and saves `<name>-secN.png` files. It detects the real scroll container:
// the window normally, but if the app scrolls in an inner overflow container
// (100vh layout, `<main class="…overflow-auto">`), that container is scrolled
// instead — otherwise long pages only ever produce sec0.
//
// This project (Countdown) has no auth and no multi-tenant setup, so there is
// no login or tenant handling: every route is reached via UI clicks from the
// main menu.

import { test } from "@playwright/test";
import type { Page } from "@playwright/test";
import path from "node:path";
import process from "node:process";
import { routes, uiReviewConfig } from "./ui-review.config";
import type { UiReviewNavStep, UiReviewRoute, UiReviewState, UiReviewViewport } from "./ui-review.config";

const BASE_URL = "http://localhost:3000";
const SCREENSHOT_OUTPUT_DIR = uiReviewConfig.outputDir;

const out = (state: UiReviewState, viewport: UiReviewViewport, file: string) =>
  path.resolve(process.cwd(), SCREENSHOT_OUTPUT_DIR, state, viewport, file);

function viewportForProject(projectName: string): UiReviewViewport {
  return projectName === "Mobile Chrome" ? "mobile" : "desktop";
}

/** Let the SPA + i18n settle so later clicks never race a layout shift. */
async function waitForAppSettled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

/**
 * Captures the whole page in readable viewport-height sections (80 % step,
 * 20 % overlap). Detects the real scroll container: prefers the window
 * (document.scrollingElement); if the app scrolls in an INNER overflow
 * container (100vh layout, `<main class="…overflow-auto">`), that container is
 * scrolled instead — otherwise long pages only ever produce sec0.
 */
async function captureSections(
  page: Page,
  state: UiReviewState,
  viewport: UiReviewViewport,
  name: string,
): Promise<void> {
  const scroller = await page.evaluate(() => {
    const doc = document.scrollingElement;
    const winH = window.innerHeight;
    if (doc && doc.scrollHeight > winH + 4) {
      return { kind: "window", max: doc.scrollHeight - winH, step: Math.round(winH * 0.8) };
    }
    const main = document.querySelector("main");
    if (main && main.scrollHeight > main.clientHeight + 4) {
      return {
        kind: "main",
        max: main.scrollHeight - main.clientHeight,
        step: Math.round(main.clientHeight * 0.8),
      };
    }
    return { kind: "window", max: 0, step: Math.round(winH * 0.8) };
  });
  const scroll = (y: number) =>
    page.evaluate(
      ({ kind, y }) => {
        if (kind === "main") {
          const el = document.querySelector("main");
          if (el) el.scrollTop = y;
        } else {
          window.scrollTo(0, y);
        }
      },
      { kind: scroller.kind, y },
    );
  let y = 0;
  let i = 0;
  for (;;) {
    await scroll(y);
    await page.waitForTimeout(200);
    await page.screenshot({ path: out(state, viewport, `${name}-sec${i}.png`), fullPage: false });
    if (y >= scroller.max) break;
    i += 1;
    y = Math.min(scroller.max, y + scroller.step);
  }
  await scroll(0);
}

async function applyNavStep(page: Page, step: UiReviewNavStep): Promise<void> {
  if (step.kind === "goto") {
    await page.goto(step.path);
    return;
  }
  const locator = page.getByRole(step.role, step.name !== undefined ? { name: step.name, exact: false } : undefined);
  await locator.first().click();
  await waitForAppSettled(page);
}

async function settleAndCapture(
  page: Page,
  route: UiReviewRoute,
  state: UiReviewState,
  viewport: UiReviewViewport,
): Promise<void> {
  await waitForAppSettled(page);
  await page.screenshot({ path: out(state, viewport, `${route.name}.png`), fullPage: true });
  await captureSections(page, state, viewport, route.name);
}

for (const route of routes) {
  for (const state of route.states) {
    for (const viewport of route.viewports ?? ["desktop", "mobile"]) {
      test(
        `screenshot ${route.name} (${state}, ${viewport})`,
        { tag: ["@screenshot"] },
        async ({ page }, testInfo) => {
          test.skip(
            viewportForProject(testInfo.project.name) !== viewport,
            `project ${testInfo.project.name} renders the ${viewportForProject(testInfo.project.name)} viewport`,
          );

          await page.goto(`${BASE_URL}${route.path}`);
          await waitForAppSettled(page);

          for (const step of route.nav?.[state] ?? []) {
            await applyNavStep(page, step);
          }

          await settleAndCapture(page, route, state, viewport);
        },
      );
    }
  }
}
