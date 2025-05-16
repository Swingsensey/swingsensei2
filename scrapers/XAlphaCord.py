# swingsensei/scrapers/XAlphaCord.py
import asyncio
import json
import os
from datetime import datetime
from playwright.async_api import async_playwright, Playwright
from redis.asyncio import Redis
from telethon import TelegramClient
from winston.logger import create_logger
from dotenv import load_dotenv
from fake_useragent import UserAgent

load_dotenv()
logger = create_logger(
    name="XAlphaCord",
    filename="logs/xalphacord.log",
    level="info",
    rotate={"size": 10485760, "count": 5}
)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
BRIGHTDATA_PROXY = os.getenv("BRIGHTDATA_PROXY")
TELEGRAM_API_ID = int(os.getenv("TELEGRAM_API_ID"))
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH")
TELEGRAM_PHONE = os.getenv("TELEGRAM_PHONE")
SCRAPE_INTERVAL = 300
XALPHA_URL = "https://x-alpha.ai/app/trending"

async def get_telegram_auth_token(client: TelegramClient) -> str:
    redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
    token = await redis_client.get("xalpha:auth_token")
    if token:
        logger.info("Loaded Telegram auth token from Redis")
        return token

    logger.info("No auth token, initiating Telegram login")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto("https://x-alpha.ai/app")
        await page.wait_for_selector(".telegram-login-button", timeout=10000)
        await page.click(".telegram-login-button")
        
        await page.wait_for_url("https://t.me/*", timeout=30000)
        auth_url = page.url
        logger.info(f"Telegram auth URL: {auth_url}")

        await client.send_message("me", f"X-Alpha auth URL: {auth_url}")
        logger.info("Sent auth URL to your Telegram account. Click it to authorize.")
        
        for _ in range(60):
            cookies = await page.context.cookies()
            auth_token = next((c["value"] for c in cookies if c["name"] == "auth_token"), None)
            if auth_token:
                await redis_client.set("xalpha:auth_token", auth_token, ex=3600)
                logger.info("Auth token saved to Redis")
                await browser.close()
                return auth_token
            await asyncio.sleep(5)
        
        logger.error("Failed to get auth token")
        await browser.close()
        return ""

async def scrape_xalpha(playwright: Playwright, auth_token: str) -> list:
    ua = UserAgent()
    browser = await playwright.chromium.launch(
        headless=True,
        proxy={"server": BRIGHTDATA_PROXY} if BRIGHTDATA_PROXY else None
    )
    context = await browser.new_context(user_agent=ua.random)
    page = await context.new_page()

    try:
        await context.add_cookies([{
            "name": "auth_token",
            "value": auth_token,
            "domain": ".x-alpha.ai",
            "path": "/"
        }])
        logger.info(f"Navigating to {XALPHA_URL}")
        response = await page.goto(XALPHA_URL, wait_until="networkidle", timeout=30000)
        if response.status != 200:
            logger.error(f"Failed to load page, status: {response.status}")
            return []

        api_data = []
        page.on("response", lambda resp: api_data.append(resp) if "api.x-alpha.ai" in resp.url else None)
        await page.wait_for_selector(".trending-list", timeout=10000)
        
        data = await page.evaluate("""
            () => {
                const items = document.querySelectorAll('.trending-item');
                return Array.from(items).slice(0, 10).map(item => ({
                    ticker: item.querySelector('.symbol')?.textContent?.trim(),
                    socialPosts: parseInt(item.querySelector('.posts')?.textContent) || 0,
                    sentiment: parseFloat(item.querySelector('.sentiment')?.textContent) || 0,
                    influenceScore: parseFloat(item.querySelector('.influence')?.textContent) || 0
                })).filter(item => item.ticker);
            }
        """)

        for response in api_data:
            if "trends" in response.url:
                try:
                    json_data = await response.json()
                    logger.info(f"Intercepted API data: {json_data}")
                except:
                    pass

        logger.info(f"Scraped {len(data)} tokens from x-alpha.ai")
        return data

    except Exception as e:
        logger.error(f"Error scraping x-alpha.ai: {str(e)}")
        return []

    finally:
        await browser.close()

async def publish_to_redis(data: list, redis_client: Redis):
    for item in data:
        item["timestamp"] = datetime.utcnow().isoformat()
        await redis_client.publish("xalpha:raw", json.dumps(item))
        logger.info(f"Published to xalpha:raw: {item['ticker']}")

async def main():
    redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
    client = TelegramClient('xalpha_session', TELEGRAM_API_ID, TELEGRAM_API_HASH)
    
    await client.start(phone=TELEGRAM_PHONE)
    if not await client.is_user_authorized():
        logger.info("Authorization required")
        await client.send_code_request(TELEGRAM_PHONE)
        code = input("Enter Telegram authorization code: ")
        await client.sign_in(TELEGRAM_PHONE, code)

    auth_token = await get_telegram_auth_token(client)
    if not auth_token:
        logger.error("Cannot proceed without auth token")
        return

    async with async_playwright() as playwright:
        while True:
            try:
                data = await scrape_xalpha(playwright, auth_token)
                if data:
                    await publish_to_redis(data, redis_client)
                else:
                    logger.warning("No data scraped, retrying...")
                await asyncio.sleep(SCRAPE_INTERVAL)
            except Exception as e:
                logger.error(f"Main loop error: {str(e)}")
                await asyncio.sleep(60)

if __name__ == "__main__":
    asyncio.run(main())
