from redis import Redis
from rq import Worker
from app.core.config import settings

if __name__ == '__main__':
    Worker(['imports'], connection=Redis.from_url(settings.redis_url)).work()
