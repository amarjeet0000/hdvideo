const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const http = require('http');
const socketIo = require('socket.io');

// Configure FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE"]
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces

const VIDEOS_DIR = path.join(__dirname, 'videos');
const THUMBS_DIR = path.join(__dirname, 'thumbnails');
const DEFAULT_THUMB = path.join(__dirname, 'default-thumbnail.webp');

// Ensure directories exist
[VIDEOS_DIR, THUMBS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Create default thumbnail if missing
if (!fs.existsSync(DEFAULT_THUMB)) {
  fs.writeFileSync(DEFAULT_THUMB, '');
}

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/videos', express.static(VIDEOS_DIR));
app.use('/thumbnails', express.static(THUMBS_DIR));

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'), false);
    }
  }
});

// Thumbnail generator
async function generateThumbnail(videoPath, thumbPath, filename) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('start', () => {
        io.emit('thumb-progress', { filename, progress: 0 });
      })
      .on('progress', (progress) => {
        io.emit('thumb-progress', { filename, progress: Math.min(100, Math.round(progress.percent)) });
      })
      .on('end', () => {
        io.emit('thumb-progress', { filename, progress: 100 });
        resolve();
      })
      .on('error', (err) => {
        io.emit('thumb-error', { filename, error: err.message });
        reject(err);
      })
      .screenshots({
        count: 1,
        folder: path.dirname(thumbPath),
        filename: path.basename(thumbPath),
        size: '320x240',
        quality: 85
      });
  });
}

const thumbnailCache = new Map();

async function ensureThumbnailExists(videoFilename) {
  const thumbName = `${path.parse(videoFilename).name}.webp`;
  const thumbPath = path.join(THUMBS_DIR, thumbName);
  const videoPath = path.join(VIDEOS_DIR, videoFilename);

  if (thumbnailCache.has(thumbName)) {
    return thumbName;
  }

  try {
    await fs.promises.access(thumbPath);
    thumbnailCache.set(thumbName, true);
    return thumbName;
  } catch {
    try {
      await generateThumbnail(videoPath, thumbPath, videoFilename);
      thumbnailCache.set(thumbName, true);
      return thumbName;
    } catch (err) {
      console.error(`Thumbnail generation failed for ${videoFilename}:`, err);
      const defaultThumb = 'default.webp';
      const defaultPath = path.join(THUMBS_DIR, defaultThumb);
      try {
        if (!fs.existsSync(defaultPath)) {
          await fs.promises.copyFile(DEFAULT_THUMB, defaultPath);
        }
        return defaultThumb;
      } catch (fallbackErr) {
        console.error('Failed to use default thumbnail:', fallbackErr);
        return null;
      }
    }
  }
}

async function generateAllThumbnails() {
  try {
    const files = await fs.promises.readdir(VIDEOS_DIR);
    const videoFiles = files.filter(f =>
      ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(f).toLowerCase())
    );

    for (const file of videoFiles) {
      try {
        await ensureThumbnailExists(file);
      } catch (err) {
        console.error(`Error processing ${file}:`, err);
      }
    }
  } catch (err) {
    console.error('Error during initial thumbnail generation:', err);
  }
}

// API: Upload
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const thumbName = await ensureThumbnailExists(req.file.filename);

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
      message: 'Upload successful',
      filename: req.file.filename,
      thumbnail: thumbName ? `${baseUrl}/thumbnails/${thumbName}` : null,
      size: req.file.size
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({
      error: err.message.includes('Unsupported')
        ? 'Unsupported file type'
        : 'Upload processing failed'
    });
  }
});

// API: Video List
app.get('/videolist', async (req, res) => {
  try {
    const files = await fs.promises.readdir(VIDEOS_DIR);
    const videoFiles = files.filter(f =>
      ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(f).toLowerCase())
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const videoList = await Promise.all(videoFiles.map(async (file) => {
      const stats = await fs.promises.stat(path.join(VIDEOS_DIR, file));
      const thumbName = `${path.parse(file).name}.webp`;

      return {
        title: path.parse(file).name,
        filename: file,
        url: `${baseUrl}/videos/${encodeURIComponent(file)}`,
        thumbnail: `${baseUrl}/thumbnails/${encodeURIComponent(thumbName)}`,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      };
    }));

    res.json(videoList.sort((a, b) => b.created - a.created));
  } catch (err) {
    console.error('Error listing videos:', err);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

// API: Stream Video
app.get('/videos/:filename', (req, res) => {
  const filePath = path.join(VIDEOS_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// API: Delete Video + Thumbnail
app.delete('/delete/:filename', async (req, res) => {
  const filename = req.params.filename;
  const videoPath = path.join(VIDEOS_DIR, filename);
  const thumbName = `${path.parse(filename).name}.webp`;
  const thumbPath = path.join(THUMBS_DIR, thumbName);

  try {
    if (fs.existsSync(videoPath)) {
      await fs.promises.unlink(videoPath);
    } else {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (fs.existsSync(thumbPath)) {
      await fs.promises.unlink(thumbPath);
      thumbnailCache.delete(thumbName);
    }

    io.emit('video-deleted', { filename });
    res.json({ message: 'Video and thumbnail deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    time: new Date(),
    videos: fs.existsSync(VIDEOS_DIR) ? fs.readdirSync(VIDEOS_DIR).length : 0,
    thumbnails: fs.existsSync(THUMBS_DIR) ? fs.readdirSync(THUMBS_DIR).length : 0
  });
});

// Socket.IO events
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
generateAllThumbnails().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📂 Videos directory: ${VIDEOS_DIR}`);
    console.log(`🖼️ Thumbnails directory: ${THUMBS_DIR}`);
    console.log(`🔌 WebSocket ready`);
  });
});

// Global error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
