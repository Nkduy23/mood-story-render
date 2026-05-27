import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// Định nghĩa Interface dữ liệu rõ ràng để dập tắt lỗi Unsafe Assignment/Member Access
interface RenderJobData {
  files: {
    id: string;
    url: string;
    type: 'image' | 'video';
    duration?: number;
  }[];
  resolvedParams: {
    colorGrade: {
      brightness: number;
      contrast: number;
      saturation: number;
    };
    transition: string;
    textStyle: string;
    fontFamily: string;
    kenBurns: {
      endScale: number;
    };
    animationSpeed: number;
  };
  caption: string;
  totalDuration: number;
}

// --- THÊM ĐOẠN NÀY VÀO ĐÂY ĐỂ ÉP ĐƯỜNG DẪN CHUẨN TRÊN WINDOWS ---
if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe');
}

// Tự động sử dụng thư mục chạy dự án (Cross-platform cho cả Windows và Linux)
const TMP_DIR = path.join(process.cwd(), 'tmp');
const OUTPUT_DIR = path.join(process.cwd(), 'output');

// Tự động kiểm tra và tạo thư mục nếu chưa tồn tại
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Download file từ URL về local
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(
            new Error(`Tải file lỗi, HTTP status: ${response.statusCode}`),
          );
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

// Cleanup tmp files (Đã sửa lỗi biến pattern khai báo thừa không dùng)
function cleanup(jobId: string) {
  try {
    const files = fs.readdirSync(TMP_DIR).filter((f) => f.startsWith(jobId));
    files.forEach((f) => {
      try {
        fs.unlinkSync(path.join(TMP_DIR, f));
      } catch (e) {
        // Ghi log nhẹ thay vì để trống block catch tránh lỗi linter
        console.error(`Không thể xóa file tạm: ${f}`, e);
      }
    });
  } catch (e) {
    console.error('Lỗi khi đọc thư mục tmp để cleanup', e);
  }
}

@Processor('render')
export class RenderProcessor {
  @Process('process')
  async handleRender(job: Job): Promise<{ outputUrl: string }> {
    // Ép kiểu job.data về RenderJobData để an toàn về mặt dữ liệu
    const { files, resolvedParams, caption, totalDuration } =
      job.data as RenderJobData;
    const jobId = job.id.toString();

    try {
      await job.progress(5);

      // Bước 1: Download tất cả files về tmp
      const localFiles: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.type === 'video' ? 'mp4' : 'jpg';
        const localPath = path.join(TMP_DIR, `${jobId}_input_${i}.${ext}`);
        await downloadFile(file.url, localPath);
        localFiles.push(localPath);
        await job.progress(5 + Math.round((i / files.length) * 20));
      }

      await job.progress(25);

      // Bước 2: Tạo filter complex cho FFmpeg
      const clipDuration = totalDuration / localFiles.length;
      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

      await job.progress(30);

      // Bước 3: Build FFmpeg command
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg();

        // Input files
        localFiles.forEach((f) => command.input(f));

        // Filter complex: scale + pad về 1080x1920, concat
        const filterParts: string[] = [];
        const concatInputs: string[] = [];

        localFiles.forEach((_, i) => {
          filterParts.push(
            `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
              `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,` +
              `setsar=1,fps=30,` +
              `eq=brightness=${(resolvedParams.colorGrade.brightness - 1) * 0.3}:` +
              `contrast=${resolvedParams.colorGrade.contrast}:` +
              `saturation=${resolvedParams.colorGrade.saturation},` +
              `zoompan=z='min(zoom+0.0008,${resolvedParams.kenBurns.endScale})':` +
              `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
              `d=${Math.round(clipDuration * 30)}:s=1080x1920:fps=30` +
              `[v${i}]`,
          );
          concatInputs.push(`[v${i}]`);
        });

        // Concat tất cả clips
        filterParts.push(
          `${concatInputs.join('')}concat=n=${localFiles.length}:v=1:a=0[outv]`,
        );

        // Text overlay nếu có caption
        if (caption) {
          const safeCaption = caption
            .replace(/'/g, "\\'")
            .replace(/:/g, '\\:')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]');

          filterParts.push(
            `[outv]drawtext=` +
              `text='${safeCaption}':` +
              `fontsize=42:fontcolor=white:` +
              `x=(w-text_w)/2:y=h-200:` +
              `enable='between(t,1,${totalDuration - 1})':` +
              `alpha='if(lt(t,2),t-1,if(gt(t,${totalDuration - 2}),${totalDuration - 1}-t,1))':` +
              `box=1:boxcolor=black@0.4:boxborderw=10` +
              `[outv2]`,
          );
        }

        command
          .complexFilter(filterParts)
          .outputOptions([
            `-map ${caption ? '[outv2]' : '[outv]'}`,
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-movflags faststart',
          ])
          .output(outputPath)
          .on('progress', (p) => {
            const ffmpegProgress = p.percent ?? 0;
            // Gọi hàm xử lý bất đồng bộ nhưng không cần await kết quả trả về của tiến độ
            void job.progress(30 + Math.round(ffmpegProgress * 0.65));
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      await job.progress(95);

      // Cleanup tmp
      cleanup(jobId);

      await job.progress(100);

      const outputUrl = `http://${process.env.VPS_IP ?? 'localhost'}:3001/output/${jobId}.mp4`;
      return { outputUrl };
    } catch (err) {
      cleanup(jobId);
      throw err;
    }
  }
}
