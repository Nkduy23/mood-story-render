import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({
    origin: '*', // ← đổi thành * cho đơn giản khi dev
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  // Static files phải đặt SAU enableCors
  app.useStaticAssets(join(process.cwd(), 'output'), {
    prefix: '/output/',
  });

  await app.listen(process.env.PORT ?? 5000);
  console.log(`Render service running on port ${process.env.PORT ?? 5000}`);
}
bootstrap();