require('dotenv').config();

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
const { google } = require('googleapis');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const PORT = process.env.PORT || 3000;
const IP_ADDRESS = process.env.IP_ADDRESS || 'localhost';
const VIDEOS_DIR = path.join(__dirname, 'videos');
const THUMBS_DIR = path.join(__dirname, 'thumbnails');
const DEFAULT_THUMB = path.join(__dirname, 'default-thumbnail.webp');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE']
  }
});

[VIDEOS_DIR, THUMBS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(DEFAULT_THUMB)) fs.writeFileSync(DEFAULT_THUMB, '');

app.use(cors());
app.use(express.json());
app.use('/videos', express.static(VIDEOS_DIR));
app.use('/thumbnails', express.static(THUMBS_DIR));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEOS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) cb(null, true);
    else cb(new Error("Unsupported file type"), false);
  }
});

const KEYFILEPATH = path.join(__dirname, 'service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });
const driveService = google.drive({ version: 'v3', auth });

async function uploadToDrive(filepath, filename) {
  const fileMetadata = { name: filename };
  const media = {
    mimeType: 'video/mp4',
    body: fs.createReadStream(filepath),
  };
  const response = await driveService.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink, webContentLink'
  });
  await driveService.permissions.create({
    fileId: response.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return response.data;
}

async function generateThumbnail(videoPath, thumbPath, filename) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('start', () => io.emit('thumb-progress', { filename, progress: 0 }))
      .on('progress', (progress) => io.emit('thumb-progress', { filename, progress: Math.min(100, Math.round(progress.percent)) }))
      .on('end', () => {
        io.emit('thumb-progress', { filename, progress: 100 });
        resolve();
      })
      .on('error', (err) => reject(err))
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
  if (thumbnailCache.has(thumbName)) return thumbName;
  try {
    await fs.promises.access(thumbPath);
    thumbnailCache.set(thumbName, true);
    return thumbName;
  } catch {
    try {
      await generateThumbnail(videoPath, thumbPath, videoFilename);
      thumbnailCache.set(thumbName, true);
      return thumbName;
    } catch {
      const defaultThumb = 'default.webp';
      const defaultPath = path.join(THUMBS_DIR, defaultThumb);
      if (!fs.existsSync(defaultPath)) await fs.promises.copyFile(DEFAULT_THUMB, defaultPath);
      return defaultThumb;
    }
  }
}

app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const thumbName = await ensureThumbnailExists(req.file.filename);
    const driveResult = await uploadToDrive(req.file.path, req.file.filename);
    res.json({
      message: 'Upload successful',
      filename: req.file.filename,
      thumbnail: `http://${IP_ADDRESS}:${PORT}/thumbnails/${thumbName}`,
      size: req.file.size,
      driveLink: driveResult.webViewLink || null
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload processing failed' });
  }
});

app.get('/videolist', async (req, res) => {
  try {
    const files = await fs.promises.readdir(VIDEOS_DIR);
    const videoFiles = files.filter(f => ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(f).toLowerCase()));
    const videoList = await Promise.all(videoFiles.map(async (file) => {
      const stats = await fs.promises.stat(path.join(VIDEOS_DIR, file));
      const thumbName = `${path.parse(file).name}.webp`;
      return {
        title: path.parse(file).name,
        filename: file,
        url: `http://${IP_ADDRESS}:${PORT}/videos/${encodeURIComponent(file)}`,
        thumbnail: `http://${IP_ADDRESS}:${PORT}/thumbnails/${encodeURIComponent(thumbName)}`,
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

app.delete('/delete/:filename', async (req, res) => {
  const filename = req.params.filename;
  const videoPath = path.join(VIDEOS_DIR, filename);
  const thumbName = `${path.parse(filename).name}.webp`;
  const thumbPath = path.join(THUMBS_DIR, thumbName);
  try {
    if (fs.existsSync(videoPath)) await fs.promises.unlink(videoPath);
    else return res.status(404).json({ error: 'Video not found' });
    if (fs.existsSync(thumbPath)) {
      await fs.promises.unlink(thumbPath);
      thumbnailCache.delete(thumbName);
    }
    io.emit('video-deleted', { filename });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', time: new Date() });
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

server.listen(PORT, IP_ADDRESS, () => {
  console.log(`🚀 Server running at http://${IP_ADDRESS}:${PORT}`);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
