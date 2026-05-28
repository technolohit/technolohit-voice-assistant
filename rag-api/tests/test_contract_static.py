import ast
from pathlib import Path


def test_required_routes_are_declared():
    source = Path("rag-api/app/main.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    route_paths = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute):
            continue
        if func.attr not in {"get", "post"}:
            continue
        if node.args and isinstance(node.args[0], ast.Constant):
            route_paths.append(node.args[0].value)

    assert "/healthz" in route_paths
    assert "/readyz" in route_paths
    assert "/v1/retrieve" in route_paths
    assert "/v1/ingest/document" in route_paths
    assert "/v1/ingest/reindex" in route_paths


def test_retrieval_logs_do_not_default_to_query_preview():
    config = Path("rag-api/app/config.py").read_text(encoding="utf-8")
    assert 'log_query_preview: bool = Field(default=False' in config


def test_voice_rag_default_is_disabled():
    config = Path("voice-bridge/src/config.js").read_text(encoding="utf-8")
    assert 'readBool("VOICE_RAG_ENABLED", false)' in config
