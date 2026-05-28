FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

ARG BUILD_VERSION=unknown
ARG IMAGE_TAG=unknown
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.version="${IMAGE_TAG}"

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

ENV BUILD_VERSION=${BUILD_VERSION}
ENV IMAGE_TAG=${IMAGE_TAG}
ENV GIT_SHA=${GIT_SHA}

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
