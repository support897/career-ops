import time
from playwright.sync_api import sync_playwright

artifacts_dir = "/Users/ilse/.gemini/antigravity-ide/brain/8c085e45-2059-4d3b-b64b-5bdcd1185607"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    # 1. Verify Pipeline Page
    print("Navigating to http://107.175.88.18:3001/pipeline...")
    page.goto("http://107.175.88.18:3001/pipeline", wait_until="networkidle")
    time.sleep(3)
    pipeline_path = f"{artifacts_dir}/vps-pipeline-proof.png"
    page.screenshot(path=pipeline_path)
    print(f"Pipeline screenshot saved: {pipeline_path}")

    # 2. Verify CV Page
    print("Navigating to http://107.175.88.18:3001/cv...")
    page.goto("http://107.175.88.18:3001/cv", wait_until="networkidle")
    time.sleep(3)
    cv_path = f"{artifacts_dir}/vps-cv-proof.png"
    page.screenshot(path=cv_path)
    print(f"CV screenshot saved: {cv_path}")

    # 3. Verify Explore Page
    print("Navigating to http://107.175.88.18:3001/explore...")
    page.goto("http://107.175.88.18:3001/explore", wait_until="networkidle")
    time.sleep(3)
    explore_path = f"{artifacts_dir}/vps-explore-proof.png"
    page.screenshot(path=explore_path)
    print(f"Explore screenshot saved: {explore_path}")

    browser.close()

print("ALL VISUAL PROOF SCREENSHOTS CAPTURED SUCCESSFULLY!")
