FROM tensorflow/tensorflow:2.16.1-gpu

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

CMD ["bash"]
