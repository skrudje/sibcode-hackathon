import json
from fastapi import FastAPI, HTTPException
from app.core.config import settings

app = FastAPI(title='Демонстрационный API кинотеатра')


@app.get('/events')
def events():
    return json.loads((settings.path('demo_dir') / 'api_A.json').read_text())


@app.get('/contacts/{shop}')
def contacts(shop: int, cursor: int = 0):
    if not 1 <= shop <= 9 or cursor < 0:
        raise HTTPException(404)
    path = settings.path('demo_dir') / f'contacts-{shop}.json'
    if not path.exists():
        raise HTTPException(404)
    data = json.loads(path.read_text())
    rows = data['records']
    end = min(cursor+250, len(rows))
    return {**data, 'records': rows[cursor:end], 'next_cursor': str(end), 'has_more': end < len(rows)}
