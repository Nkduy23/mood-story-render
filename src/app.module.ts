import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { RenderModule } from './render/render.module';

@Module({
  imports: [
    BullModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
    }),
    RenderModule,
  ],
})
export class AppModule {}
