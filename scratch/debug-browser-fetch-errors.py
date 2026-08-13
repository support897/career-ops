import time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    # Capture console logs
    page.on("console", lambda msg: print(f"CONSOLE [{msg.type}]: {msg.text}"))
    page.on("requestfailed", lambda req: print(f"FAIL REQUEST: {req.url} -> {req.failure}"))
    page.on("response", lambda res: print(f"RESPONSE: {res.status} {res.url}"))

    print("=== TESTING /cv PAGE ===")
    page.goto("http://107.175.88.18:3001/cv", wait_until="networkidle")
    time.sleep(2)

    print("=== TESTING /pipeline PAGE ===")
    page.goto("http://107.175.88.18:3001/pipeline", wait_until="networkidle")
    time.sleep(2)

    browser.close()
