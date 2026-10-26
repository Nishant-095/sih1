"""Optional local reCAPTCHA image solver for an already-open Air India CDP page.

This process makes no flight search. It attaches to the collector's Chrome session,
attempts one challenge, records its outcome, and leaves fare verification to the
JavaScript collector. Install the optional Python dependencies separately.
"""

import argparse
import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright
from recognizer.agents.playwright import AsyncChallenger


def stamp():
    return datetime.now(timezone.utc).isoformat()


async def solve(cdp_url, out_dir):
    out_dir = Path(out_dir)
    result = {"at": stamp(), "status": "failed", "challenge": "Google reCAPTCHA"}
    playwright = await async_playwright().start()
    browser = None
    page = None
    try:
        browser = await playwright.chromium.connect_over_cdp(cdp_url, timeout=10000)
        for context in browser.contexts:
            for candidate in context.pages:
                if "airindia.com" in candidate.url and "refx-booking" in candidate.url:
                    page = candidate
                    break
            if page:
                break
        if page is None:
            raise RuntimeError("No Air India booking challenge page in Chrome session")
        # CDP can attach while the booking handoff is still painting. Starting the
        # solver against that blank document makes its checkbox lookup time out.
        await page.locator("#refx-recaptcha-container iframe[title='reCAPTCHA']").wait_for(
            state="visible", timeout=30000
        )
        result["checkboxVisibleAt"] = stamp()
        await page.screenshot(path=str(out_dir / "local-solver-before.png"), full_page=True)
        solver = AsyncChallenger(page, retry_times=4)
        await asyncio.wait_for(solver.solve_recaptcha(), timeout=150)
        submit = page.locator("#refx-submit-btn")
        if not await submit.is_enabled():
            result["status"] = "challenge_not_cleared"
        else:
            await submit.click(timeout=10000)
            result["status"] = "challenge_submitted"
            await page.wait_for_timeout(5000)
        await page.screenshot(path=str(out_dir / "local-solver-after.png"), full_page=True)
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "detail": str(exc)[:400]}
    finally:
        if page:
            try:
                result["challengeFrameCount"] = sum("bframe" in frame.url for frame in page.frames)
                result["challengeHeadingCount"] = await page.frame_locator(
                    "iframe[src*='bframe']").locator("strong").count()
                await page.screenshot(path=str(out_dir / "local-solver-after.png"), full_page=True)
            except Exception as exc:
                result["evidenceError"] = {"type": type(exc).__name__, "detail": str(exc)[:200]}
        result["finishedAt"] = stamp()
        target = out_dir / "local-solver-result.json"
        temporary = out_dir / "local-solver-result.json.tmp"
        with temporary.open("w") as handle:
            json.dump(result, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        temporary.replace(target)
        # The collector owns Chrome. Stopping this client disconnects CDP; Browser.close()
        # would close Chrome and destroy the collector's page and response evidence.
        await playwright.stop()
    print(json.dumps({"status": result["status"], "error": result.get("error")}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cdp", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    asyncio.run(solve(args.cdp, args.out))


if __name__ == "__main__":
    main()
