# Firebase emulators (Auth, Firestore, Storage) for local development.
# Java is needed by the Firestore emulator; packaging it here keeps the host free of a JDK.
FROM node:24-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g firebase-tools@15.34.0 \
  && firebase setup:emulators:firestore \
  && firebase setup:emulators:storage \
  && firebase setup:emulators:ui
WORKDIR /workspace
EXPOSE 4000 8080 9099 9199
# Import only when a previous export exists; a fresh volume has none.
CMD ["sh", "-c", "IMPORT=; [ -f /data/firebase-export-metadata.json ] && IMPORT=\"--import /data\"; exec firebase emulators:start --only auth,firestore,storage --project demo-arbitra $IMPORT --export-on-exit /data"]
