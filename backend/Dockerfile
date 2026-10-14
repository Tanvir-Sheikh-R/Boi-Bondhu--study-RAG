# ========================================================
# Study-RAG (পাঠ সমাধান) - Backend API Dockerfile (Slim RAG)
# ========================================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /app/backend/data/threads \
             /app/embedding_cache

# Copy pre-downloaded model cache directly into image
COPY model_cache/ ./model_cache/

COPY chapters.json ./
COPY backend/ ./backend/
COPY README.md ./

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1

CMD ["python", "-m", "backend.run"]
