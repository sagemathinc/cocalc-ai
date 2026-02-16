FROM ubuntu:25.10

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

CMD ["bash"]
