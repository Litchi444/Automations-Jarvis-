# n8n 2.x ships a hardened image with no package manager (no apk/apt).
# We therefore pull a statically linked ffmpeg from a multi-arch image
# (amd64 + arm64, so it also runs on ARM VPS plans).
# No RUN instructions on purpose: the base image may not have a usable shell.

ARG N8N_VERSION=2.48.8
ARG FFMPEG_VERSION=8.1

FROM mwader/static-ffmpeg:${FFMPEG_VERSION} AS ffmpeg

FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

COPY --from=ffmpeg /ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

# Pre-create the only directory n8n 2.x lets file nodes touch
# (N8N_RESTRICT_FILE_ACCESS_TO defaults to ~/.n8n-files).
# A fresh named volume mounted here inherits node:node ownership.
COPY --chown=node:node n8n-files /home/node/.n8n-files

USER node
