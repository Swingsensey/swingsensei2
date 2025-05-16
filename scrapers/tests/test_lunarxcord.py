# swingsensei/scrapers/tests/test_lunarxcord.py
import pytest
from playwright.async_api import async_playwright
from LunarXCord import scrape_lunarcrush, publish_to_redis
from redis.asyncio import Redis

@pytest.mark.asyncio
async def test_scrape_lunarcrush():
    async with async_playwright() as playwright:
        data = await scrape_lunarcrush(playwright)
        assert isinstance(data, list)
        if data:
            assert "ticker" in data[0]
            assert "socialVolume" in data[0]

@pytest.mark.asyncio
async def test_publish_to_redis():
    redis_client = Redis.from_url("redis://localhost:6379", decode_responses=True)
    data = [{"ticker": "TEST", "socialVolume": 100, "timestamp": "2025-05-14"}]
    await publish_to_redis(data, redis_client)
    message = await redis_client.lpop("lunar:raw")
    assert message is not None
