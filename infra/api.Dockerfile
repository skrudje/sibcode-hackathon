FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/apps/api
COPY apps/api/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r /app/requirements.lock
COPY apps/api /app/apps/api
COPY demo/templates /app/demo/templates
COPY docs/spec/02_OPENAPI.json /app/docs/spec/02_OPENAPI.json
RUN useradd --uid 10001 --create-home app && mkdir -p /app/.data/uploads /app/.data/demo && chown -R app:app /app/.data
USER app
