"""Attempt Air India's visible reCAPTCHA audio challenge in the collector's Chrome.

Requires Playwright, pydub, SpeechRecognition, and ffmpeg. This helper sends no flight
search and never writes a CAPTCHA token or transcription to disk.
"""

import argparse
import asyncio
import json
import os
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from playwright.async_api import async_playwright
from pydub import AudioSegment
import speech_recognition


def stamp():
    return datetime.now(timezone.utc).isoformat()


def transcribe_mp3(content):
    wav = BytesIO()
    AudioSegment.from_mp3(BytesIO(content)).export(wav, format="wav")
    wav.seek(0)
    recognizer = speech_recognition.Recognizer()
    recognizer.operation_timeout = 12
    with speech_recognition.AudioFile(wav) as source:
        audio = recognizer.record(source)
    return recognizer.recognize_google(audio, language="en-US")


async def submit_if_ready(page, result):
    submit = page.locator("#refx-submit-btn")
    for _ in range(20):
        if await submit.is_enabled():
            await submit.click(timeout=10000)
            result["status"] = "challenge_submitted"
            await page.wait_for_timeout(5000)
            return True
        await page.wait_for_timeout(250)
    return False


async def solve(cdp_url, out_dir):
    out_dir = Path(out_dir)
    result = {"at": stamp(), "status": "failed", "challenge": "Google reCAPTCHA audio"}
    playwright = await async_playwright().start()
    page = None
    try:
        browser = await playwright.chromium.connect_over_cdp(cdp_url, timeout=10000)
        page = next((candidate for context in browser.contexts for candidate in context.pages
                     if "airindia.com" in candidate.url and "refx-booking" in candidate.url), None)
        if page is None:
            raise RuntimeError("No Air India booking challenge page in Chrome session")
        await page.locator("#refx-recaptcha-container iframe[title='reCAPTCHA']").wait_for(
            state="visible", timeout=30000
        )
        result["checkboxVisibleAt"] = stamp()
        await page.screenshot(path=str(out_dir / "local-solver-before.png"), full_page=True)
        # This library discovers the challenge only after both Google frames
        # exist. Air India creates the bframe when the checkbox is first clicked.
        await page.frame_locator("iframe[title='reCAPTCHA']").locator(
            "#recaptcha-anchor"
        ).click(timeout=10000)
        if not await submit_if_ready(page, result):
            challenge = page.frame_locator("iframe[src*='/recaptcha/api2/bframe']")
            await challenge.locator("#recaptcha-audio-button").click(timeout=10000)
            result["audioChallengeOpenedAt"] = stamp()
            for attempt in range(1, 3):
                if await challenge.locator(".rc-doscaptcha-header-text").is_visible():
                    result["status"] = "rate_limited"
                    break
                link = challenge.locator(".rc-audiochallenge-tdownload-link")
                await link.wait_for(state="visible", timeout=10000)
                audio_url = await link.get_attribute("href")
                if not audio_url or not audio_url.startswith("https://www.google.com/recaptcha/"):
                    raise RuntimeError("Google did not provide an expected audio challenge URL")
                audio_response = await page.request.get(audio_url, timeout=15000)
                if not audio_response.ok:
                    if audio_response.status == 429:
                        result["status"] = "rate_limited"
                        break
                    raise RuntimeError(f"Audio challenge download returned HTTP {audio_response.status}")
                result["audioAttempts"] = attempt
                try:
                    answer = await asyncio.wait_for(
                        asyncio.to_thread(transcribe_mp3, await audio_response.body()), timeout=30
                    )
                except (speech_recognition.UnknownValueError,
                        speech_recognition.RequestError, TimeoutError) as exc:
                    result["status"] = "audio_unrecognized"
                    result["error"] = {"type": type(exc).__name__,
                                       "detail": ("Audio was not recognized" if isinstance(exc, speech_recognition.UnknownValueError)
                                                  else "Speech service timed out" if isinstance(exc, TimeoutError)
                                                  else str(exc)[:200])}
                    if attempt < 2:
                        await challenge.locator("#recaptcha-reload-button").click(timeout=10000)
                        continue
                    break
                await challenge.locator("#audio-response").fill(answer)
                await challenge.locator("#recaptcha-verify-button").click(timeout=10000)
                if await submit_if_ready(page, result):
                    result.pop("error", None)
                    break
                if attempt < 2:
                    await challenge.locator("#recaptcha-reload-button").click(timeout=10000)
            if result["status"] == "failed":
                result["status"] = "challenge_not_cleared"
    except Exception as exc:
        # A challenge frame can disappear after Google accepts the checkbox.
        # Check the airline's button before labeling that transition a failure.
        try:
            ready = page is not None and await page.locator("#refx-submit-btn").is_enabled()
        except Exception:
            ready = False
        if ready:
            try:
                await submit_if_ready(page, result)
                result["recoveredFrom"] = type(exc).__name__
            except Exception as submit_exc:
                result["error"] = {"type": type(submit_exc).__name__,
                                   "detail": str(submit_exc)[:400]}
        else:
            result["error"] = {"type": type(exc).__name__, "detail": str(exc)[:400]}
    finally:
        if page is not None:
            try:
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
