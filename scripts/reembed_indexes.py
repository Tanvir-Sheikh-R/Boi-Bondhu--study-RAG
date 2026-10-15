"""Rebuild every chapter's FAISS index with the currently configured E5 model.

The cached indexes were built with intfloat/multilingual-e5-large (1024-d) while the
deployment now runs multilingual-e5-base (768-d), so FAISS rejected every query with
"assert d == self.d". This re-embeds each chapter's existing chunks (chunks.json) with
the configured model and rewrites index.faiss/index.pkl in place. chunks.json and
bm25.pkl are text-only and are left untouched, and no PDF/OCR work is involved.

Run inside the backend image, where the model, faiss and langchain already live:

    docker run --rm \
      -v "<repo>/embedding_cache:/app/embedding_cache" \
      -v "<repo>/scripts/reembed_indexes.py:/tmp/reembed_indexes.py:ro" \
      tanvirsheikh/study-rag-backend:latest python /tmp/reembed_indexes.py

Already-matching chapters are skipped, so re-running is cheap and resumes safely.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

# Make "backend" importable both inside the image (code lives in /app) and when this
# script is run straight from the repo.
for candidate in (Path("/app"), Path(__file__).resolve().parent.parent):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import faiss
from langchain_community.vectorstores import FAISS

from backend.config import EMBEDDING_CACHE, EMBEDDING_MODEL
from backend.rag.embeddings import encode_passages, model_info
from backend.rag.retriever import E5QueryEmbeddings


def index_dimension(path: Path) -> int | None:
    """Current vector width of a chapter's index, or None when it is unreadable."""
    try:
        return faiss.read_index(str(path)).d
    except Exception:
        return None


def rebuild(directory: Path) -> int:
    """Re-embed one chapter's chunks and atomically replace its FAISS index."""
    chunks = json.loads((directory / "chunks.json").read_text(encoding="utf-8"))
    texts = [item["text"] for item in chunks]
    metas = [item.get("meta") or {} for item in chunks]
    vectors = encode_passages(texts)

    store = FAISS.from_embeddings(
        text_embeddings=list(zip(texts, vectors)),
        embedding=E5QueryEmbeddings(),
        metadatas=metas,
    )

    # Build into a temp dir so an interrupted run cannot leave a half-written index,
    # clearing any temp dir left behind by a previously aborted run.
    tmp = directory / "_rebuild_tmp"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    store.save_local(str(tmp))
    os.replace(tmp / "index.faiss", directory / "index.faiss")
    os.replace(tmp / "index.pkl", directory / "index.pkl")
    tmp.rmdir()
    return len(texts)


def main() -> int:
    force = "--force" in sys.argv
    info = model_info()
    expected = int(info["dimension"])
    print(f"model={EMBEDDING_MODEL} device={info['device']} dimension={expected}", flush=True)

    # Chapters live in hashed folders (md5(name)[:10]) — that is the layout the
    # retriever resolves. The legacy long-name folders also hold a chunks.json but
    # are only a fallback, so re-embedding them would be wasted work.
    targets = sorted(
        path
        for path in EMBEDDING_CACHE.rglob("*")
        if path.is_dir()
        and re.fullmatch(r"[0-9a-f]{10}", path.name)
        and (path / "chunks.json").exists()
    )
    print(f"hashed chapters to check: {len(targets)}", flush=True)

    done = skipped = failed = chunks_done = 0
    started = time.time()

    for position, directory in enumerate(targets, start=1):
        if index_dimension(directory / "index.faiss") == expected and not force:
            skipped += 1
            continue
        try:
            chunks_done += rebuild(directory)
            done += 1
        except Exception as error:  # noqa: BLE001 - one bad chapter must not stop the run
            failed += 1
            print(f"  FAIL {directory.name}: {type(error).__name__}: {error}", flush=True)

        if position % 25 == 0 or position == len(targets):
            print(
                f"[{position}/{len(targets)}] rebuilt={done} skipped={skipped} "
                f"failed={failed} chunks={chunks_done} ({time.time() - started:.0f}s)",
                flush=True,
            )

    print(
        f"\nrebuilt={done} skipped={skipped} failed={failed} chunks={chunks_done} "
        f"elapsed={time.time() - started:.0f}s"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
