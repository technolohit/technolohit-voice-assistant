#!/usr/bin/env python3
"""Ingest approved TechnoloHit product/FAQ/markdown knowledge through RAG API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_API_URL = "http://localhost:8080"


def post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {url} failed status={exc.code}: {detail}") from exc


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def product_documents(path: Path) -> list[dict[str, Any]]:
    catalog = load_json(path)
    docs = []
    for product in catalog.get("products", []):
        title = str(product.get("name") or product.get("id") or "TechnoloHit Produkt")
        aliases = ", ".join(product.get("aliases_de") or [])
        forbidden = ", ".join(product.get("forbidden_claims") or [])
        content = "\n".join(
            [
                f"Produkt: {title}",
                f"Kurzname: {product.get('short_name', '')}",
                f"Aliasse: {aliases}",
                f"Kurze Telefonantwort: {product.get('phone_short_de', '')}",
                f"Detailantwort: {product.get('phone_detail_de', '')}",
                f"Nicht versprechen: {forbidden}",
            ]
        )
        docs.append(
            {
                "source_type": "product_catalog",
                "source_uri": f"{path.as_posix()}#{product.get('id', title)}",
                "title": title,
                "content": content,
                "metadata": {
                    "catalog_version": catalog.get("version"),
                    "product_id": product.get("id"),
                    "product_number": product.get("number"),
                },
            }
        )
    return docs


def faq_documents(path: Path) -> list[dict[str, Any]]:
    catalog = load_json(path)
    docs = []
    for faq in catalog.get("faqs", []):
        title = f"FAQ: {faq.get('id', 'TechnoloHit')}"
        keywords = ", ".join(faq.get("keywords_de") or [])
        content = "\n".join(
            [
                title,
                f"Schlüsselwörter: {keywords}",
                f"Antwort: {faq.get('answer_de', '')}",
            ]
        )
        docs.append(
            {
                "source_type": "faq_catalog",
                "source_uri": f"{path.as_posix()}#{faq.get('id', title)}",
                "title": title,
                "content": content,
                "metadata": {
                    "catalog_version": catalog.get("version"),
                    "faq_id": faq.get("id"),
                },
            }
        )
    return docs


def markdown_document(path: Path) -> dict[str, Any]:
    return {
        "source_type": "approved_markdown",
        "source_uri": path.as_posix(),
        "title": path.stem,
        "content": path.read_text(encoding="utf-8"),
        "metadata": {"file_name": path.name},
    }


def build_documents() -> list[dict[str, Any]]:
    knowledge_dir = REPO_ROOT / "voice-bridge" / "knowledge"
    docs: list[dict[str, Any]] = []
    docs.extend(product_documents(knowledge_dir / "products.technolohit.json"))
    docs.extend(faq_documents(knowledge_dir / "faqs.technolohit.json"))
    docs.append(markdown_document(knowledge_dir / "technolohit.md"))
    return docs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", default=os.getenv("RAG_API_URL", DEFAULT_API_URL))
    parser.add_argument("--tenant-id", default=os.getenv("RAG_DEFAULT_TENANT_ID", "technolohit"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    docs = build_documents()
    if args.dry_run:
        print(json.dumps({"documents": len(docs), "titles": [doc["title"] for doc in docs]}, ensure_ascii=False, indent=2))
        return 0

    endpoint = args.api_url.rstrip("/") + "/v1/ingest/document"
    for doc in docs:
        payload = {
            "tenant_id": args.tenant_id,
            "language": "de",
            **doc,
        }
        result = post_json(endpoint, payload)
        print(f"ingested title={doc['title']} document_id={result.get('document_id')} chunks={result.get('chunks_created')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
