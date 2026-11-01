"""Distributed request limits; keys do not contain raw email addresses."""
import hashlib
import secrets
from functools import lru_cache

from pwdlib import PasswordHash
from redis import Redis, RedisError

from .config import settings
from .errors import AppError

LIMIT_SCRIPT = '''
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('TTL', KEYS[1])
if count > tonumber(ARGV[1]) then return math.max(ttl, 1) end
return 0
'''


def limiter():
    return Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)


def request_limit(category, identity, maximum, seconds):
    digest = hashlib.sha256(str(identity).encode()).hexdigest()
    key = f'nexa:limit:{category}:{digest}'
    try:
        retry = int(limiter().eval(LIMIT_SCRIPT, 1, key, maximum, seconds))
    except RedisError as exc:
        raise AppError('security_unavailable', 'Проверка доступа временно недоступна', 503) from exc
    if retry:
        raise AppError('rate_limited', 'Слишком много попыток. Повторите позже.', 429,
                       headers={'Retry-After': str(retry)})
    return key


def login_limits(email, peer):
    request_limit('login-peer', peer, 120, 60)
    return request_limit('login-account', email.strip().lower(), 8, 900)


def login_succeeded(key):
    try:
        limiter().delete(key)
    except RedisError as exc:
        raise AppError('security_unavailable', 'Проверка доступа временно недоступна', 503) from exc


@lru_cache(maxsize=1)
def dummy_password_hash():
    return PasswordHash.recommended().hash(secrets.token_urlsafe(32))
