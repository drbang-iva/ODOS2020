FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fonts-noto-core \
    libharfbuzz-subset0 \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    python3 \
    python3-venv \
  && python3 -m venv /opt/weasyprint \
  && /opt/weasyprint/bin/pip install --no-cache-dir WeasyPrint==69.0 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/weasyprint/bin:${PATH}"
WORKDIR /workspace
CMD ["node", "mcp/dist/correspondence/render-server.js"]
