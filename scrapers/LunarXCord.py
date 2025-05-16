# swingsensei/scrapers/LunarXCord.py
import asyncio
import json
import os
from datetime import datetime
from playwright.async_api import async_playwright, Playwright
from redis.asyncio import Redis
from winston.logger import create_logger
from dotenv import load_dotenv
from fake_useragent import UserAgent

load_dotenv()
logger = create_logger(
    name="LunarXCord",
    filename="logs/lunarxcord.log",
    level="info",
    rotate={"size": 10485760, "count": 5}
)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
BRIGHTDATA_PROXY = os.getenv("BRIGHTDATA_PROXY")
SCRAPE_INTERVAL = 300
LUNARCRUSH_URL = "https://lunarcrush.com/markets"

async def scrape_lunarcrush(playwright: Playwright) -> list:
    ua = UserAgent()
    browser = await playwright.chromium.launch(
        headless=True,
        proxy={"server": BRIGHTDATA_PROXY} if BRIGHTDATA_PROXY else None
    )
    context = await browser.new_context(user_agent=ua.random)
    page = await context.new_page()

    try:
        logger.info(f"Navigating to {LUNARCRUSH_URL}")
        response = await page.goto(LUNARCRUSH_URL, wait_until="networkidle", timeout=30000)
        if response.status != 200:
            logger.error(f"Failed to load page, status: {response.status}")
            return []

        await page.wait_for_selector(".markets-table", timeout=10000)
        data = await page.evaluate("""
            () => {
                const rows = document.querySelectorAll('.markets-table tr');
                return Array.from(rows).slice(0, 10).map(row => ({
                    ticker: row.querySelector('.symbol')?.textContent?.trim(),
                    socialVolume: parseFloat(row.querySelector('.social-volume')?.textContent) || 0,
                    socialScore: parseFloat(row.querySelector('.social-score')?.textContent) || 0,
                    galaxyScore: parseFloat(row.querySelector('.galaxy-score')?.textContent) || 0,
                    sentiment: parseFloat(row.querySelector('.sentiment')?.textContent) || 0,
                    socialPosts: parseInt(row.querySelector('.social-posts')?.textContent) || 0
                })).filter(item => item.ticker);
            }
        """)
        logger.info(f"Scraped {len(data)} tokens from LunarCrush")
        return data

    except Exception as e:
        logger.error(f"Error scraping LunarCrush: {str(e)}")
        return []

    finally:
        await browser.close()

async def publish_to_redis(data: list, redis_client: Redis):
    for item in data:
        item["timestamp"] = datetime.utcnow().isoformat()
        await redis_client.publish("lunar:raw", json.dumps(item))
        logger.info(f"Published to lunar:raw: {item['ticker']}")

async def main():
    redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
    async with async_playwright() as playwright:
        while True:
            try:
                data = await scrape_lunarcrush(playwright)
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
