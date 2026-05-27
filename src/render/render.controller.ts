import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { RenderService } from './render.service';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsObject,
} from 'class-validator';

class FileItemDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  url!: string;

  @IsString()
  @IsNotEmpty()
  type!: 'image' | 'video';

  @IsOptional()
  @IsNumber()
  duration?: number;
}

class ColorGradeDto {
  @IsNumber()
  brightness!: number;

  @IsNumber()
  contrast!: number;

  @IsNumber()
  saturation!: number;
}

class KenBurnsDto {
  @IsNumber()
  startScale!: number;

  @IsNumber()
  endScale!: number;

  @IsNumber()
  startX!: number;

  @IsNumber()
  endX!: number;

  @IsNumber()
  startY!: number;

  @IsNumber()
  endY!: number;
}

class ResolvedParamsDto {
  @IsObject()
  colorGrade!: ColorGradeDto;

  @IsString()
  transition!: string;

  @IsString()
  textStyle!: string;

  @IsString()
  fontFamily!: string;

  @IsObject()
  kenBurns!: KenBurnsDto;

  @IsNumber()
  animationSpeed!: number;

  @IsOptional()
  @IsObject()
  musicTrack?: {
    filename: string;
  };
}

export class RenderJobDto {
  @IsArray()
  @IsNotEmpty()
  files!: FileItemDto[];

  @IsObject()
  @IsNotEmpty()
  resolvedParams!: ResolvedParamsDto;

  @IsString()
  caption!: string;

  @IsNotEmpty()
  totalDuration!: 10 | 15 | 20 | 25;
}

@Controller('render')
export class RenderController {
  constructor(private readonly renderService: RenderService) {}

  @Get('ping')
  ping() {
    return 'pong';
  }

  @Post('job')
  async createJob(@Body() dto: RenderJobDto) {
    const jobId = await this.renderService.createRenderJob(dto);
    return { jobId };
  }

  @Get('status/:jobId')
  async getStatus(@Param('jobId') jobId: string) {
    return this.renderService.getJobStatus(jobId);
  }

  @Get('download/:jobId')
  async getDownloadUrl(@Param('jobId') jobId: string) {
    return this.renderService.getDownloadUrl(jobId);
  }
}
