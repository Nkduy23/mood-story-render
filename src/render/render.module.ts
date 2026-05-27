import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { RenderController } from './render.controller';
import { RenderService } from './render.service';
import { RenderProcessor } from './render.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'render',
    }),
  ],
  controllers: [RenderController],
  providers: [RenderService, RenderProcessor],
})
export class RenderModule {}
