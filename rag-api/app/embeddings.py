from openai import AsyncOpenAI
from .config import Settings


def _client(settings: Settings) -> AsyncOpenAI:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required for embedding generation")
    return AsyncOpenAI(api_key=settings.openai_api_key)


async def embed_text(settings: Settings, text: str) -> list[float]:
    response = await _client(settings).embeddings.create(
        model=settings.embedding_model,
        input=text,
        dimensions=settings.embedding_dimensions,
    )
    return list(response.data[0].embedding)


async def embed_many(settings: Settings, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    response = await _client(settings).embeddings.create(
        model=settings.embedding_model,
        input=texts,
        dimensions=settings.embedding_dimensions,
    )
    ordered = sorted(response.data, key=lambda item: item.index)
    return [list(item.embedding) for item in ordered]


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"
