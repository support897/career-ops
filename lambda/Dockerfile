# Dockerfile for career-ops Lambda with Chromium support
# Based on AWS Lambda Node.js 22 base image

FROM public.ecr.aws/lambda/nodejs:22

# Install system dependencies required by Chromium
RUN dnf install -y \
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
    && dnf clean all

# Install fonts for proper text rendering
RUN dnf install -y \
    google-noto-sans-fonts \
    google-noto-serif-fonts \
    && dnf clean all

# Copy package files and install dependencies
COPY lambda/package.json /var/task/package.json
RUN npm install --production

# Copy cookie crypto for platform auto-apply
COPY lib/cookie-crypto.mjs /var/task/lib/cookie-crypto.mjs
COPY scan.mjs /var/task/scan.mjs
COPY auto-apply.mjs /var/task/auto-apply.mjs
COPY apply-to-ats.mjs /var/task/apply-to-ats.mjs
COPY scan-ats-full.mjs /var/task/scan-ats-full.mjs
COPY generate-pdf.mjs /var/task/generate-pdf.mjs
COPY generate-cover-letter.mjs /var/task/generate-cover-letter.mjs
COPY build-cv-html.mjs /var/task/build-cv-html.mjs
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

# Copy tracker aliases
COPY tracker-aliases.json /var/task/tracker-aliases.json
COPY templates/states.yml /var/task/templates/states.yml

# The Lambda runtime mounts the image as read-only. The pipeline writes
# to output/, which we redirect to /tmp via the handler script.

# Copy the Lambda handler
COPY lambda/index.mjs /var/task/index.mjs

# Set the Lambda handler
CMD ["index.handler"]
