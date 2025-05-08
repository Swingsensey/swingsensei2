from tweety import Twitter
from transformers import pipeline
from redis import Redis
import json
import os
import time
import openrouter

redis_client = Redis(host=os.getenv('REDIS_HOST', 'localhost'), port=int(os.getenv('REDIS_PORT', '6379')), decode_responses=True)
sentiment_analyzer = pipeline('sentiment-analysis', model='facebook/bart-large')
openrouter.api_key = os.getenv('DEEPSEEK_API_KEY')

usernames = [
    'WatcherGuru', 'elonmusk', 'whalewatchalert',
    'gemxbt_agent', 'DegenerateNews', 'TheCryptoDev_', 'aeyakovenko',
    'tradingmate_ai', 'DataC58218', 'orbitcryptoai', '0xNestAI',
    'aikek_agent', 'Zompawcat', 'blknoiz06', 'Matt_Furie'
]

def extract_ticker(tweet: str) -> str:
    words = tweet.split()
    for word in words:
        if word.startswith('$'):
            return word[1:]
    return ''

def analyze_tweet(tweet: str) -> dict:
    bart_result = sentiment_analyzer(tweet)[0]
    sentiment_score = bart_result['score'] if bart_result['label'] == 'POSITIVE' else -bart_result['score']
    deepseek_response = openrouter.chat.completions.create(
        model="deepseek/deepseek-coder:6.7b",
        messages=[{"role": "user", "content": f"Analyze trading pattern in: {tweet}"}]
    )
    pattern = deepseek_response.choices[0].message.content
    ticker = extract_ticker(tweet)
    return {
        'ticker': ticker,
        'sentimentScore': sentiment_score,
        'text': tweet,
        'timestamp': int(time.time()),
        'pattern': pattern
    }

def main():
    client = Twitter()
    for username in usernames:
        try:
            tweets = client.get_tweets(username, pages=1)
            for tweet in tweets:
                if any(keyword.lower() in tweet.text.lower() for keyword in ['solana', '$barsik', '$samo', '$aimk']):
                    analysis = analyze_tweet(tweet.text)
                    if analysis['sentimentScore'] > 0.7 and analysis['ticker']:
                        redis_client.publish('tweets:raw', json.dumps(analysis))
        except Exception as e:
            with open('error.log', 'a') as f:
                f.write(f'Ошибка обработки {username}: {e}\n')

if __name__ == '__main__':
    main()
