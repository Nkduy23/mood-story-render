import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ── Types ────────────────────────────────────────────────────────────────────

interface KenBurnsPreset {
  startScale: number;
  endScale: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

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
    kenBurns: KenBurnsPreset;
    animationSpeed: number;
  };
  caption: string;
  totalDuration: number;
  musicUrl?: string;
}

// ── FFmpeg path (Windows only) ───────────────────────────────────────────────

if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath('C:\\ffmpeg\\bin\\ffmpeg.exe');
}

// ── Dirs ─────────────────────────────────────────────────────────────────────

const TMP_DIR = path.join(process.cwd(), 'tmp');
const OUTPUT_DIR = path.join(process.cwd(), 'output');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP error: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      })
      .on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function cleanup(jobId: string) {
  try {
    fs.readdirSync(TMP_DIR)
      .filter((f) => f.startsWith(jobId))
      .forEach((f) => { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch {} });
  } catch {}
}

/**
 * Escape caption text cho FFmpeg drawtext.
 * Phải escape theo thứ tự: \ trước, rồi : [ ] '
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")  // Sửa cơ chế escape nháy đơn chuẩn quy tắc FFmpeg
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Word-wrap text để FFmpeg drawtext xuống dòng đúng.
 * FE canvas maxWidth = 1080 - 120 = 960px, font 72px ≈ 28 ký tự/dòng.
 */
function wrapCaption(text: string, maxChars = 28): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (test.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * Tính filter zoompan khớp logic FE
 */
function buildZoompanFilter(
  kb: KenBurnsPreset,
  frames: number,
  speed: number,
  inputIndex: number,
  outputLabel: string,
  colorGrade: { brightness: number; contrast: number; saturation: number },
  clipDuration: number,
): string {
  const sStart = kb.startScale;
  const sEnd = kb.endScale;
  const scaleDelta = (sEnd - sStart) / frames;

  const xStart = kb.startX ?? 0;
  const xEnd = kb.endX ?? 0;
  const yStart = kb.startY ?? 0;
  const yEnd = kb.endY ?? 0;

  const zExpr = `${sStart}+${scaleDelta.toFixed(6)}*(on-1)`;

  const xOffsetExpr = frames > 1
    ? `${xStart.toFixed(2)}+(${(xEnd - xStart).toFixed(2)})*(on-1)/${frames - 1}`
    : `${xStart.toFixed(2)}`;
  const xExpr = `iw/2+(${xOffsetExpr})-iw/zoom/2`;

  const yOffsetExpr = frames > 1
    ? `${yStart.toFixed(2)}+(${(yEnd - yStart).toFixed(2)})*(on-1)/${frames - 1}`
    : `${yStart.toFixed(2)}`;
  const yExpr = `ih/2+(${yOffsetExpr})-ih/zoom/2`;

  const bri = ((colorGrade.brightness - 1) * 0.3).toFixed(3);
  const con = colorGrade.contrast.toFixed(3);
  const sat = colorGrade.saturation.toFixed(3);

  return (
    `[${inputIndex}:v]` +
    `scale=1080:1920:force_original_aspect_ratio=increase,` +
    `crop=1080:1920,` +
    `setsar=1,fps=30,` +
    `eq=brightness=${bri}:contrast=${con}:saturation=${sat},` +
    `zoompan=` +
      `z='${zExpr}':` +
      `x='${xExpr}':` +
      `y='${yExpr}':` +
      `d=${frames}:s=1080x1920:fps=30` +
    `${outputLabel}`
  );
}

// ── Processor ─────────────────────────────────────────────────────────────────

@Processor('render')
export class RenderProcessor {
  @Process('process')
  async handleRender(job: Job): Promise<{ outputUrl: string }> {
    const { files, resolvedParams, caption, totalDuration, musicUrl } =
      job.data as RenderJobData;

    const jobId = job.id.toString();

    try {
      await job.progress(5);

      // ── Bước 1: Download files ──────────────────────────────────────────
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

      // ── Bước 2: Download nhạc ───────────────────────────────────────────
      let musicPath: string | null = null;
      if (musicUrl) {
        try {
          musicPath = path.join(TMP_DIR, `${jobId}_audio.mp3`);
          await downloadFile(musicUrl, musicPath);
        } catch (e) {
          console.warn('[Render] Tải nhạc thất bại, bỏ qua audio:', e);
          musicPath = null;
        }
      }

      await job.progress(30);

      // ── Bước 3: Build filter complex ────────────────────────────────────
      const clipDuration = totalDuration / localFiles.length;
      const framesPerClip = Math.round(clipDuration * 30);
      const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

      const filterParts: string[] = [];
      const concatInputs: string[] = [];

      localFiles.forEach((_, i) => {
        const outputLabel = `[v${i}]`;
        filterParts.push(
          buildZoompanFilter(
            resolvedParams.kenBurns,
            framesPerClip,
            resolvedParams.animationSpeed ?? 1.0,
            i,
            outputLabel,
            resolvedParams.colorGrade,
            clipDuration,
          ),
        );
        concatInputs.push(outputLabel);
      });

      // Concat tất cả clips
      filterParts.push(
        `${concatInputs.join('')}concat=n=${localFiles.length}:v=1:a=0[outv]`,
      );

      // ── Bước 4: Text overlay (Khớp font VPS và Tự động Word-wrap) ────────
      let videoMap = '[outv]';

      if (caption && caption.trim()) {
    const wrappedCaption = wrapCaption(caption);
    const safeCaption = escapeDrawtext(wrappedCaption);

    const lineCount = wrappedCaption.split('\n').length;
    const lineHeight = 90;
    const totalTextH = lineCount * lineHeight;
    const baseY = 1920 - 220 - totalTextH;

    // Padding cho box
    const boxPadding = 30;
    const boxY = baseY - boxPadding;
    const boxH = totalTextH + boxPadding * 2;

    let fontPath = '/usr/local/share/fonts/moodstory/Lora-Regular.ttf';
    if (resolvedParams.textStyle === 'serif') {
      fontPath = '/usr/local/share/fonts/moodstory/Lora-Regular.ttf';
    } else if (resolvedParams.textStyle === 'mono') {
      fontPath = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
    }

    const startT = 1;
    const endT = totalDuration - 1;
    const alphaExpr =
      `if(lt(t,${startT}),0,` +
      `if(lt(t,${startT + 0.33}),(t-${startT})/0.33,` +
      `if(gt(t,${endT - 0.33}),(${endT}-t)/0.33,` +
      `1)))`;

    // Bước 1: Vẽ box tối mờ phía sau chữ
    filterParts.push(
      `[outv]drawbox=` +
        `x=0:` +
        `y=${boxY}:` +
        `w=iw:` +
        `h=${boxH}:` +
        `color=black@0.45:` +
        `t=fill:` +
        `enable='between(t,${startT},${endT})'` +
      `[outv_box]`,
    );

    // Bước 2: Vẽ chữ lên trên box
    filterParts.push(
      `[outv_box]drawtext=` +
        `fontfile='${fontPath}':` +
        `text='${safeCaption}':` +
        `fontsize=72:` +
        `fontcolor=white:` +
        `x=(w-text_w)/2:` +
        `y=${baseY}:` +
        `line_spacing=18:` +
        `shadowcolor=black@0.6:` +
        `shadowx=1:shadowy=1:` +
        `alpha='${alphaExpr}':` +
        `enable='between(t,${startT},${endT})'` +
      `[outv2]`,
    );
    videoMap = '[outv2]';
  }
      // ── Bước 5: Run FFmpeg ───────────────────────────────────────────────
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg();

        localFiles.forEach((f) => command.input(f));
        if (musicPath) command.input(musicPath);

        command
          .complexFilter(filterParts)
          .outputOptions([
            `-map ${videoMap}`,
            ...(musicPath ? [`-map ${localFiles.length}:a`] : []),
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            ...(musicPath ? ['-c:a aac', '-shortest'] : []),
            '-movflags faststart',
          ])
          .output(outputPath)
          .on('progress', (p) => {
            const pct = p.percent ?? 0;
            void job.progress(30 + Math.round(pct * 0.65));
          })
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run();
      });

      await job.progress(95);
      cleanup(jobId);
      await job.progress(100);

      // Trả về địa chỉ tĩnh của video qua cổng phục vụ tệp Static của bạn
      const outputUrl = `http://${process.env.VPS_IP}:5000/output/${jobId}.mp4`;
      return { outputUrl };
    } catch (err) {
      cleanup(jobId);
      throw err;
    }
  }
}