# ========================================================
# Study-RAG (বই বন্ধু) - Backend API Dockerfile
# ========================================================
# Note: Context should be project root (.) when building:
#   docker build -f backend/Dockerfile -t study-rag-backend .
# ========================================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    HOST=0.0.0.0 \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /app/backend/data/threads \
             /app/embedding_cache \
             /app/ocr_cache \
             /app/model_cache

COPY chapters.json ./
COPY backend/ ./backend/
COPY README.md ./

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["python", "-m", "backend.run"]
