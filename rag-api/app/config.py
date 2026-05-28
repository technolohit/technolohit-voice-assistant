from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "technolohit-rag-api"
    environment: str = Field(default="development", alias="RAG_ENV")
    host: str = Field(default="0.0.0.0", alias="RAG_HOST")
    port: int = Field(default=8080, alias="RAG_PORT")

    db_host: str = Field(default="10.20.0.1", alias="RAG_DB_HOST")
    db_port: int = Field(default=5432, alias="RAG_DB_PORT")
    db_name: str = Field(default="technolohit_growth", alias="RAG_DB_NAME")
    db_user: str = Field(default="", alias="RAG_DB_USER")
    db_password: str = Field(default="", alias="RAG_DB_PASSWORD")
    db_ssl: bool = Field(default=False, alias="RAG_DB_SSL")
    db_statement_timeout_ms: int = Field(default=500, alias="RAG_DB_STATEMENT_TIMEOUT_MS")

    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    embedding_model: str = Field(default="text-embedding-3-small", alias="RAG_EMBEDDING_MODEL")
    embedding_dimensions: int = Field(default=1536, alias="RAG_EMBEDDING_DIMENSIONS")

    default_tenant_id: str = Field(default="technolohit", alias="RAG_DEFAULT_TENANT_ID")
    default_language: str = Field(default="de", alias="RAG_DEFAULT_LANGUAGE")
    default_top_k: int = Field(default=3, alias="RAG_DEFAULT_TOP_K")
    default_min_score: float = Field(default=0.72, alias="RAG_DEFAULT_MIN_SCORE")
    exact_product_boost: float = Field(default=0.03, alias="RAG_EXACT_PRODUCT_BOOST")
    semantic_product_boost: float = Field(default=0.04, alias="RAG_SEMANTIC_PRODUCT_BOOST")
    retrieve_candidate_limit: int = Field(default=12, alias="RAG_RETRIEVE_CANDIDATE_LIMIT")
    semantic_product_accept_floor: float = Field(default=0.66, alias="RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR")
    max_document_chars: int = Field(default=60000, alias="RAG_MAX_DOCUMENT_CHARS")
    chunk_chars: int = Field(default=900, alias="RAG_CHUNK_CHARS")
    chunk_overlap_chars: int = Field(default=120, alias="RAG_CHUNK_OVERLAP_CHARS")
    log_query_preview: bool = Field(default=False, alias="RAG_LOG_QUERY_PREVIEW")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @property
    def db_dsn(self) -> str:
        if not self.db_user or not self.db_password:
            return ""
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
