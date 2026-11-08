ARG EVE_SANDBOX_BASE_IMAGE=ghcr.io/vercel/eve@sha256:18fb75032908d231b65e269fa46034ddcea3d90524d795d2f7e77c4fd4edbe48
FROM ${EVE_SANDBOX_BASE_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/oworker-dev/open-agent"

ARG PLAYWRIGHT_VERSION=1.62.1

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    imagemagick \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && npm install --global "@playwright/test@${PLAYWRIGHT_VERSION}" \
  && playwright install --with-deps chromium \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /root/.cache/pip

RUN node --version \
  && npm --version \
  && python3 --version \
  && git --version \
  && ffmpeg -version \
  && convert -version \
  && playwright --version
