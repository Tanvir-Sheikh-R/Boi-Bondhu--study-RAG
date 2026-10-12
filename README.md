# বই বন্ধু (Study-RAG)

Bengali textbook study assistant: pick a class, subject and chapter, ask a question
in Bangla, and get an answer grounded in that NCTB textbook with the source passages
shown.

The retrieval pipeline lives in pipeline/pdf_to_document_cleanV2.ipynb and produces
the artifacts this app reads (chapters.json, ocr_cache/, embedding_cache/,
model_cache/). The backend never rewrites those artifacts.

## Run

### Option 1: Docker (Recommended)

Run both API and Web UI with a single command:

    docker compose up --build

- **Web UI:** http://localhost:3000
- **API Backend:** http://localhost:8000 (Health check: http://localhost:8000/api/health)

Or build and run individually:

    # Backend
    docker build -f Dockerfile.backend -t study-rag-backend .
    docker run -p 8000:8000 --env-file .env study-rag-backend

    # Web UI
    docker build -t study-rag-web ./web
    docker run -p 3000:3000 study-rag-web

### Option 2: Local processes

Two processes:

    # 1. API (first start loads multilingual-e5-large onto the GPU, ~20s)
    python -m backend.run                 # http://127.0.0.1:8000

    # 2. Web UI
    cd web
    npm install
    npm run dev                           # http://localhost:3000

The web app talks to NEXT_PUBLIC_API_BASE (web/.env.local, default
http://127.0.0.1:8000).

## How it works

- Selection: a blocking popup picks class -> subject -> chapter from chapters.json.
  Class 9-10 has one extra level (stream, e.g. general), so a book key is
  class/subject or class/stream/subject, matching both the PDF layout
  (pdf/Class_9_10/General/English.pdf) and embedding_cache/.
- Retrieval: BM25 + FAISS hybrid (EnsembleRetriever, weights 0.4/0.6, k=5) over the
  chapter's cached vectors.npy; nothing is re-embedded at query time. If a chapter
  has no cache, the whole book is searched and the UI says so.
- Answer: DeepSeek (deepseek-chat) streams the answer as NDJSON events
  (status, sources, delta, done), so the UI can show retrieval progress, the source
  chunks, and an error mid-stream.
- Threads: one JSON file per thread in backend/data/threads/, holding thread_id,
  class/subject/chapter context, messages[], created_at and updated_at. A thread can
  be opened directly with /?thread=<thread_id>.

## Checks

    python scripts/api_smoke_test.py            # end-to-end API + streamed answer
    node scripts/verify-stream.mjs <thread_id>  # frontend NDJSON parsing
    cd web; npx tsc --noEmit                    # types




# 1. API Backend
docker build -f Dockerfile.backend -t tanvirsheikh/study-rag-backend .
docker push tanvirsheikh/study-rag-backend
docker run -p 8000:8000 --env-file .env tanvirsheikh/study-rag-backend

# 2. Web UI
docker build -t tanvirsheikh/study-rag-web ./web
docker push tanvirsheikh/study-rag-web
docker run -p 3000:3000 tanvirsheikh/study-rag-web
