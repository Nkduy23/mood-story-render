import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Serve static output files
  app.useStaticAssets(join(__dirname, '..', 'output'), {
    prefix: '/output/',
  });

  app.enableCors({
    origin: ['http://localhost:5000', 'https://moodstoryai.vercel.app/'],
    methods: ['GET', 'POST'],
  });

  app.useGlobalPipes(new ValidationPipe());

  await app.listen(5000);
  console.log('Render service running on port 5000');
}
bootstrap();
