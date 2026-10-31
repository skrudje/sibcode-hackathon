import json
from fastapi import FastAPI
from app.core.config import settings

app = FastAPI(title='Демонстрационный API кинотеатра')


@app.get('/events')
def events():
    return json.loads((settings.path('demo_dir') / 'api_A.json').read_text())
