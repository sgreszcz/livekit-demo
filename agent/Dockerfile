# Glass Cockpit agent worker — built for `lk agent deploy`.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.10 /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 agent

WORKDIR /app

# Dependencies first so application edits don't invalidate the layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

# Fetch any plugin model weights at build time rather than on the first call. The
# all-Inference pipeline currently ships its VAD weights inside the wheel, so this is
# a no-op today; it keeps the image correct if a local plugin is ever added.
RUN python -m livekit.agents download-files

COPY agent.py telemetry.py chaos.py pricing.py ./

RUN chown -R agent:agent /app
USER agent

# LiveKit Cloud health/metrics port for the worker.
EXPOSE 8081

CMD ["python", "agent.py", "start"]
