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


def test_retrieve_request_supports_agent_id():
    models = Path("rag-api/app/models.py").read_text(encoding="utf-8")
    assert 'agent_id: str = "main_voice_sales"' in models
    retrieval = Path("rag-api/app/retrieval.py").read_text(encoding="utf-8")
    assert "d.agent_id = $3" in retrieval


def test_ingest_conflict_target_is_agent_aware():
    retrieval = Path("rag-api/app/retrieval.py").read_text(encoding="utf-8")
    assert "ON CONFLICT (tenant_id, agent_id, source_uri, content_hash)" in retrieval


def test_voice_bridge_dockerfile_copies_agent_config():
    dockerfile = Path("voice-bridge/Dockerfile").read_text(encoding="utf-8")
    assert "COPY --chown=node:node config ./config" in dockerfile
    assert Path(
        "voice-bridge/config/agents/technolohit.main_voice_sales.v4.json"
    ).is_file()


def test_voice_rag_default_is_disabled():
    config = Path("voice-bridge/src/config.js").read_text(encoding="utf-8")
    assert 'readBool("VOICE_RAG_ENABLED", false)' in config
    assert 'readBool("VOICE_V4_REALTIME_ENABLED", false)' in config
