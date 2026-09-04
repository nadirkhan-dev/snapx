import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap() {
  // Throws and stops the process if anything is missing or looks like a
  // placeholder — before a port is bound and before anything can reach it.
  const cfg = loadConfig();

  /* bodyParser disabled globally so the upload route can read the raw stream.
     Express's JSON parser would otherwise consume the bytes first and the
     handler would wait forever on a stream that already ended. JSON is mounted
     below for every path except the upload. */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false, bodyParser: false,
  });

  app.use(helmet({
    // The API serves JSON, never HTML, so CSP here would only mislead. The web
    // app sets its own.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cookieParser());

  const json = express.json({ limit: '1mb' });
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path === '/api/media/upload' ? next() : json(req, res, next));


  /* Credentials must be allowed for the refresh cookie, which means the origin
     cannot be `*`. An explicit allow-list is the only correct pairing. */
  app.enableCors({
    origin: cfg.WEB_ORIGIN.split(',').map(o => o.trim()),
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Behind nginx or a load balancer, so per-IP limiting sees the real client.
  app.set('trust proxy', 1);

  /* Test-only: exposes the delivery outbox so the suite can read a reset code
     without it ever being logged. Mounted solely under NODE_ENV=test, so it
     cannot become an information leak in any other environment. */
  if (cfg.NODE_ENV === 'test') {
    const { DeliveryService } = await import('./common/delivery.service');
    const delivery = app.get(DeliveryService, { strict: false });
    const http = app.getHttpAdapter().getInstance() as express.Express;
    http.get('/api/test/outbox', (_req, res) => { res.json({ messages: delivery.outbox }); });
    http.delete('/api/test/outbox', (_req, res) => {
      delivery.clearOutbox();
      res.json({ cleared: true });
    });
  }

  await app.listen(cfg.PORT);
  new Logger('Bootstrap').log(`SNAPX API on http://localhost:${cfg.PORT}/api`);
}

bootstrap().catch(err => {
  // eslint-disable-next-line no-console
  console.error(`\nSNAPX API failed to start:\n${err.message}\n`);
  process.exit(1);
});
