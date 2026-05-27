import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

@Injectable()
export class RenderService {
  constructor(@InjectQueue('render') private renderQueue: Queue) {}

  async createRenderJob(data: any): Promise<string> {
    const job = await this.renderQueue.add('process', data, {
      attempts: 2,
      backoff: 3000,
      removeOnComplete: false, // giữ lại để FE poll
      removeOnFail: false,
    });
    return job.id.toString();
  }

  async getJobStatus(jobId: string): Promise<{
    status: string;
    progress: number;
    outputUrl?: string;
    error?: string;
  }> {
    const job = await this.renderQueue.getJob(jobId);
    if (!job) return { status: 'not_found', progress: 0 };

    const state = await job.getState();
    const progress = job.progress() as number;

    if (state === 'completed') {
      return {
        status: 'done',
        progress: 100,
        outputUrl: job.returnvalue?.outputUrl,
      };
    }

    if (state === 'failed') {
      return {
        status: 'error',
        progress: 0,
        error: job.failedReason,
      };
    }

    return { status: state, progress };
  }

  async getDownloadUrl(jobId: string) {
    const job = await this.renderQueue.getJob(jobId);
    if (!job) return { error: 'Job not found' };
    return { url: job.returnvalue?.outputUrl };
  }
}
