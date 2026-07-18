# Dockerfile for career-ops Lambda with Chromium support
# Based on AWS Lambda Node.js 22 base image

FROM public.ecr.aws/lambda/nodejs:22

# Install system dependencies required by Chromium
RUN yum install -y \
    alsa-lib \
    atk \
    at-spi2-atk \
    cups-libs \
    gtk3 \
    libXcomposite \
    libXcursor \
    libXdamage \
    libXext \
    libXi \
    libXrandr \
    libXScrnSaver \
    libXtst \
    pango \
    pulseaudio-libs \
    libdrm \
    libgbm \
    nss \
    mesa-libEGL \
    mesa-libGL \
    && yum clean all

# Install fonts for proper text rendering
RUN yum install -y \
    google-noto-sans-fonts-common \
    google-noto-serif-fonts-common \
    && yum clean all

# Copy package files and install dependencies
COPY lambda/package.json /var/task/package.json
RUN npm install --production

# Copy career-ops code (core files needed for scanning)
COPY scan.mjs /var/task/scan.mjs
COPY classify-tier.mjs /var/task/classify-tier.mjs
COPY fingerprint-core.mjs /var/task/fingerprint-core.mjs
COPY tracker-parse.mjs /var/task/tracker-parse.mjs
COPY tracker-utils.mjs /var/task/tracker-utils.mjs
COPY verify-portals.mjs /var/task/verify-portals.mjs
COPY portals.yml /var/task/portals.yml
COPY config/ /var/task/config/

# Copy providers directory
COPY providers/ /var/task/providers/

# Copy plugins directory
COPY plugins/ /var/task/plugins/

# Copy lib directory (DB reader/writer)
COPY lib/ /var/task/lib/

# Copy mode files (needed for tier classification)
COPY modes/ /var/task/modes/

# Copy templates
COPY templates/ /var/task/templates/

# Copy data directory (for blacklist, etc.)
COPY data/ /var/task/data/

# Copy the Lambda handler
COPY lambda/index.mjs /var/task/index.mjs

# Set the Lambda handler
CMD ["index.handler"]
