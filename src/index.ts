import { createApp } from "./app.js";
import { ConfigError, formatConfigError, loadConfig } from "./config.js";
import { buildLogger, type Logger } from "./logger.js";

function installProcessHandlers(app: Awaited<ReturnType<typeof createApp>>, logger: Logger): void {
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    app.stop().then(() => process.exit(0), (err) => {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // State after an unhandled rejection is unknown: log it and exit so Docker restarts the container.
  process.on("unhandledRejection", (err) => {
    logger.fatal({ err }, "unhandled rejection; exiting");
    process.exit(1);
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(formatConfigError(err));
      process.exit(1);
    }
    throw err;
  }
  const logger = buildLogger(config.LOG_LEVEL, config.NODE_ENV === "development");
  const app = await createApp(config, logger);
  installProcessHandlers(app, logger);
  await app.start();
  logger.info({ port: config.PORT, host: config.HOST }, "harvest listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
